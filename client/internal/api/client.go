package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type Client struct {
	Conn *websocket.Conn
	mu   sync.Mutex
}

func Dial(url string) (*Client, error) {
	head := http.Header{}
	c, _, err := websocket.DefaultDialer.Dial(url, head)
	if err != nil { return nil, err }
	return &Client{Conn:c}, nil
}

func NormalizeWSURL(base string) string {
	if strings.HasPrefix(base, "http://") { return "ws://"+strings.TrimPrefix(base,"http://")+"/ws" }
	if strings.HasPrefix(base, "https://") { return "wss://"+strings.TrimPrefix(base,"https://")+"/ws" }
	if strings.HasPrefix(base, "ws://") || strings.HasPrefix(base,"wss://") { return strings.TrimRight(base, "/") + "/ws" }
	return "ws://" + base + "/ws"
}

func (c *Client) Request(typ string, payload interface{}) (Envelope, error) {
	reqID := uuid.NewString()
	env := Envelope{Type:typ, RequestID:reqID, TS:time.Now().UnixMilli(), Payload:payload}
	c.mu.Lock()
	if err := c.Conn.WriteJSON(env); err != nil { c.mu.Unlock(); return Envelope{}, err }
	for {
		var resp Envelope
		if err := c.Conn.ReadJSON(&resp); err != nil { c.mu.Unlock(); return Envelope{}, err }
		if resp.RequestID == reqID || (resp.RequestID=="" && (resp.Type=="ERROR" || resp.Type=="AUTH_OK" || resp.Type=="PONG")) {
			c.mu.Unlock()
			if resp.Type == "ERROR" {
				b,_:=json.Marshal(resp.Payload)
				return resp, errors.New(string(b))
			}
			return resp, nil
		}
	}
}


func (c *Client) Send(typ string, payload interface{}) error {
	env := Envelope{Type:typ, RequestID:uuid.NewString(), TS:time.Now().UnixMilli(), Payload:payload}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Conn.WriteJSON(env)
}

func DecodePayload[T any](env Envelope) (T, error) {
	var out T
	b, err := json.Marshal(env.Payload)
	if err != nil { return out, err }
	if err := json.Unmarshal(b, &out); err != nil { return out, fmt.Errorf("decode payload: %w", err) }
	return out, nil
}
