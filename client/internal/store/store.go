package store

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Session struct {
	Server   string `json:"server"`
	Username string `json:"username"`
	Token    string `json:"token"`
}

func path() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".moviechat", "session.json")
}

func Save(s Session) error {
	p := path()
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	b, _ := json.MarshalIndent(s, "", "  ")
	return os.WriteFile(p, b, 0o600)
}

func Load() (Session, error) {
	p := path()
	b, err := os.ReadFile(p)
	if err != nil { return Session{}, err }
	var s Session
	return s, json.Unmarshal(b, &s)
}

func Clear() error { return os.Remove(path()) }
