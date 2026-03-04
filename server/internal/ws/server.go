package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"moviechat/server/internal/auth"
	"moviechat/server/internal/config"
	"moviechat/server/internal/db"
	"moviechat/server/internal/model"
	"moviechat/server/internal/rate"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type clientConn struct {
	conn     *websocket.Conn
	userID   int64
	username string
}

type Hub struct {
	cfg       config.Config
	db        *db.DB
	upgrader  websocket.Upgrader
	mu        sync.RWMutex
	online    map[int64]map[*clientConn]bool
	authLimit *rate.Limiter
	sendLimit *rate.Limiter
}

func NewHub(cfg config.Config, dbx *db.DB) *Hub {
	return &Hub{cfg: cfg, db: dbx, upgrader: websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}, online: map[int64]map[*clientConn]bool{}, authLimit: rate.New(8, 1), sendLimit: rate.New(20, 5)}
}

func (h *Hub) Handle(w http.ResponseWriter, r *http.Request) {
	ws, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil { return }
	c := &clientConn{conn: ws}
	defer ws.Close()
	ip := r.RemoteAddr
	for {
		var env model.Envelope
		if err := ws.ReadJSON(&env); err != nil {
			h.unregister(c)
			return
		}
		h.route(c, ip, env)
	}
}

func (h *Hub) route(c *clientConn, ip string, env model.Envelope) {
	switch env.Type {
	case "AUTH_REGISTER":
		if !h.cfg.AllowRegister { h.err(c, env.RequestID, "registration_disabled"); return }
		if !h.authLimit.Allow("auth:"+ip) { h.err(c, env.RequestID, "rate_limited"); return }
		b,_:=json.Marshal(env.Payload); var p model.AuthPayload; _=json.Unmarshal(b,&p)
		if !auth.ValidateUsername(p.Username) || len(p.Password) < 8 { h.err(c, env.RequestID, "invalid_credentials"); return }
		if err:=h.db.CreateUser(p.Username,p.Password); err!=nil { h.err(c,env.RequestID,"username_taken"); return }
		h.ok(c, env.RequestID, map[string]string{"status":"registered"})
	case "AUTH_LOGIN":
		if !h.authLimit.Allow("auth:"+ip) { h.err(c, env.RequestID, "rate_limited"); return }
		b,_:=json.Marshal(env.Payload); var p model.AuthPayload; _=json.Unmarshal(b,&p)
		if p.Token != "" {
			claims, err := auth.ParseToken(h.cfg.TokenSecret, p.Token)
			if err != nil || !h.db.SessionValid(claims.UserID, auth.HashToken(p.Token)) { h.err(c, env.RequestID, "invalid_token"); return }
			c.userID, c.username = claims.UserID, claims.Username
			h.register(c)
			h.ok(c, env.RequestID, map[string]any{"token": p.Token, "username": c.username, "e2ee": false})
			h.deliverOffline(c)
			return
		}
		uid, passhash, err := h.db.UserByUsername(p.Username)
		if err != nil || auth.VerifyPassword(passhash,p.Password)!=nil { h.err(c, env.RequestID, "auth_failed"); return }
		tok,jti,exp,err:=auth.NewToken(h.cfg.TokenSecret, uid, p.Username, h.cfg.TokenTTL)
		if err!=nil { h.err(c,env.RequestID,"token_error"); return }
		_ = jti
		_ = h.db.SaveSession(uid, auth.HashToken(tok), exp)
		c.userID, c.username = uid, p.Username
		h.register(c)
		h.ok(c, env.RequestID, map[string]any{"token":tok,"username":c.username,"expiresAt":exp,"e2ee":false})
		h.deliverOffline(c)
	case "AUTH_LOGOUT":
		if c.userID>0 { _ = h.db.DeleteSessions(c.userID) }
		h.ok(c,env.RequestID,map[string]string{"status":"logged_out"})
		h.unregister(c)
	case "USERS_LIST":
		if !h.requireAuth(c, env.RequestID) { return }
		uu, _ := h.db.Users()
		resp := make([]model.UserInfo,0,len(uu))
		for _, u := range uu { resp = append(resp, model.UserInfo{Username:u, Online:h.isOnlineByUsername(u)}) }
		h.ok(c, env.RequestID, resp)
	case "PING":
		h.write(c, model.Envelope{Type:"PONG", RequestID:env.RequestID, TS:time.Now().UnixMilli(), Payload: map[string]any{"session":uuid.NewString()[:8]}})
	case "MSG_SEND":
		if !h.requireAuth(c, env.RequestID) { return }
		if !h.sendLimit.Allow("send:"+c.username) { h.err(c,env.RequestID,"rate_limited"); return }
		b,_:=json.Marshal(env.Payload); var p model.MessagePayload; _=json.Unmarshal(b,&p)
		if len(p.Body)==0 || len([]byte(p.Body)) > h.cfg.MaxMessageBytes { h.err(c, env.RequestID, "invalid_message_size"); return }
		rid, err := h.db.ResolveUser(p.To)
		if err != nil { h.err(c, env.RequestID, "recipient_not_found"); return }
		id, created, err := h.db.SaveMessage(c.userID, rid, p.Body)
		if err != nil { h.err(c, env.RequestID, "store_error"); return }
		msg := model.Message{ID:id, From:c.username, To:p.To, Body:p.Body, CreatedAt:created}
		if h.pushToUser(rid, "MSG_DELIVERED", msg) {
			dt,_:=h.db.MarkDelivered(id); msg.DeliveredAt=&dt
			h.ok(c, env.RequestID, map[string]any{"status":"delivered","message":msg})
		} else {
			h.ok(c, env.RequestID, map[string]any{"status":"queued","message":msg})
		}
	case "MSG_SEEN":
		if !h.requireAuth(c, env.RequestID) { return }
		b,_:=json.Marshal(env.Payload); var p model.MessagePayload; _=json.Unmarshal(b,&p)
		st, err := h.db.MarkSeen(p.MessageID); if err!=nil { h.err(c, env.RequestID, "seen_error"); return }
		h.ok(c, env.RequestID, map[string]any{"messageId":p.MessageID, "seenAt":st})
	case "INBOX_LIST":
		if !h.requireAuth(c, env.RequestID) { return }
		msgs,_:=h.db.Inbox(c.userID, 100)
		h.ok(c, env.RequestID, msgs)
	default:
		h.err(c, env.RequestID, "unsupported_type")
	}
}

func (h *Hub) requireAuth(c *clientConn, req string) bool { if c.userID==0 { h.err(c,req,"unauthorized"); return false }; return true }
func (h *Hub) err(c *clientConn, req,msg string) { log.Printf("event=error user=%s err=%s", c.username, msg); h.write(c, model.Envelope{Type:"ERROR", RequestID:req, TS:time.Now().UnixMilli(), Payload: map[string]string{"error":msg}}) }
func (h *Hub) ok(c *clientConn, req string, payload interface{}) { h.write(c, model.Envelope{Type:"AUTH_OK", RequestID:req, TS:time.Now().UnixMilli(), Payload:payload}) }
func (h *Hub) write(c *clientConn, env model.Envelope) { _ = c.conn.WriteJSON(env) }

func (h *Hub) register(c *clientConn) {
	h.mu.Lock(); defer h.mu.Unlock()
	if _,ok:=h.online[c.userID]; !ok { h.online[c.userID]=map[*clientConn]bool{} }
	h.online[c.userID][c]=true
	log.Printf("connect user=%s", c.username)
	h.broadcastPresence(c.username, true)
}
func (h *Hub) unregister(c *clientConn) {
	if c.userID==0 { return }
	h.mu.Lock(); defer h.mu.Unlock()
	if m,ok:=h.online[c.userID]; ok { delete(m,c); if len(m)==0 { delete(h.online,c.userID); h.broadcastPresence(c.username,false) } }
	log.Printf("disconnect user=%s", c.username)
}
func (h *Hub) broadcastPresence(username string, online bool) {
	env := model.Envelope{Type:"PRESENCE_UPDATE", TS:time.Now().UnixMilli(), Payload:map[string]any{"username":username,"online":online}}
	for _, set := range h.online { for cc := range set { _ = cc.conn.WriteJSON(env) } }
}
func (h *Hub) pushToUser(uid int64, typ string, payload interface{}) bool {
	h.mu.RLock(); set,ok:=h.online[uid]; h.mu.RUnlock(); if !ok || len(set)==0 { return false }
	env:=model.Envelope{Type:typ, TS:time.Now().UnixMilli(), Payload:payload}
	for c := range set { _ = c.conn.WriteJSON(env) }
	return true
}
func (h *Hub) isOnlineByUsername(username string) bool {
	id, err := h.db.ResolveUser(username); if err!=nil { return false }
	h.mu.RLock(); defer h.mu.RUnlock(); return len(h.online[id])>0
}
func (h *Hub) deliverOffline(c *clientConn) {
	msgs, err := h.db.UndeliveredFor(c.userID); if err!=nil { return }
	for _, m := range msgs {
		_ = c.conn.WriteJSON(model.Envelope{Type:"MSG_DELIVERED", TS:time.Now().UnixMilli(), Payload:m})
		dt,_ := h.db.MarkDelivered(m.ID)
		m.DeliveredAt=&dt
		sid, _ := h.db.ResolveUser(m.From)
		h.pushToUser(sid, "MSG_ACK", map[string]any{"messageId":m.ID,"status":"delivered"})
	}
}
