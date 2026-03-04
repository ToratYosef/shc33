package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"moviechat/client/internal/anim"
	"moviechat/client/internal/api"
	"moviechat/client/internal/store"
	"moviechat/client/internal/ui"
)

func main() {
	if len(os.Args) < 2 {
		usage(); return
	}
	server := getenv("CHAT_SERVER", "ws://127.0.0.1:8080")
	wsURL := api.NormalizeWSURL(server)
	cmd := os.Args[1]

	switch cmd {
	case "register":
		u, p := credsPrompt()
		c := mustDial(wsURL); defer c.Conn.Close()
		anim.Startup(false)
		_, err := c.Request("AUTH_REGISTER", api.AuthPayload{Username:u, Password:p})
		must(err)
		fmt.Println("registered")
	case "login":
		u, p := credsPrompt()
		c := mustDial(wsURL); defer c.Conn.Close()
		anim.Startup(false)
		env, err := c.Request("AUTH_LOGIN", api.AuthPayload{Username:u, Password:p}); must(err)
		var pl map[string]any; _ = decode(env.Payload, &pl)
		tok, _ := pl["token"].(string)
		must(store.Save(store.Session{Server:server, Username:u, Token:tok}))
		fmt.Println("logged in as", u)
	case "logout":
		_ = store.Clear(); fmt.Println("logged out")
	case "whoami":
		s, err := store.Load(); must(err); fmt.Println(s.Username)
	case "users":
		c, _ := authConn(); defer c.Conn.Close(); anim.Startup(false)
		env, err := c.Request("USERS_LIST", map[string]any{}); must(err)
		users,_:=api.DecodePayload[[]api.UserInfo](env)
		for _, u := range users { fmt.Printf("%s\t%v\n", u.Username, u.Online) }
	case "ping":
		c,_:=authConn(); defer c.Conn.Close(); env, err := c.Request("PING", map[string]any{}); must(err); b,_:=json.Marshal(env.Payload); fmt.Println(string(b))
	case "send":
		fs := flag.NewFlagSet("send", flag.ExitOnError)
		to := fs.String("to", "", "recipient")
		message := fs.String("message", "", "message")
		_ = fs.Parse(os.Args[2:])
		if *to == "" { fmt.Print("to: "); fmt.Scanln(to) }
		if *message == "" { fmt.Print("message: "); in:=bufio.NewReader(os.Stdin); m,_:=in.ReadString('\n'); *message=strings.TrimSpace(m) }
		c,_:=authConn(); defer c.Conn.Close(); anim.SendSequence()
		env, err := c.Request("MSG_SEND", api.MessagePayload{To:*to, Body:*message}); must(err)
		b,_:=json.MarshalIndent(env.Payload,"","  "); fmt.Println(string(b))
	case "inbox":
		c,_:=authConn(); defer c.Conn.Close(); env, err := c.Request("INBOX_LIST", map[string]any{}); must(err)
		msgs,_:=api.DecodePayload[[]api.Message](env)
		for _, m := range msgs { fmt.Printf("[%s] %s -> %s: %s\n", m.CreatedAt.Format("2006-01-02 15:04"), m.From, m.To, m.Body) }
	case "open":
		c,s := authConn(); defer c.Conn.Close(); anim.Startup(false); must(ui.Open(c, s.Username))
	default:
		usage()
	}
}

func authConn() (*api.Client, store.Session) {
	s, err := store.Load(); must(err)
	c := mustDial(api.NormalizeWSURL(s.Server))
	_, err = c.Request("AUTH_LOGIN", api.AuthPayload{Token:s.Token})
	if err != nil { fmt.Println("session invalid, login again"); os.Exit(1) }
	return c, s
}

func mustDial(url string) *api.Client { c, err := api.Dial(url); must(err); return c }
func must(err error) { if err != nil { fmt.Println("error:", err); os.Exit(1) } }
func usage() {
	fmt.Println("chat register|login|logout|whoami|users|ping|send --to <u> [--message m]|inbox|open")
}
func credsPrompt() (string,string) {
	in:=bufio.NewReader(os.Stdin)
	fmt.Print("username: "); u,_:=in.ReadString('\n')
	fmt.Print("password: "); p,_:=in.ReadString('\n')
	return strings.TrimSpace(u), strings.TrimSpace(p)
}
func getenv(k,d string) string { if v:=os.Getenv(k); v!="" { return v }; return d }
func decode(src any, dst any) error { b,_:=json.Marshal(src); return json.Unmarshal(b,dst) }
