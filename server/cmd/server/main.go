package main

import (
	"fmt"
	"log"
	"net/http"

	"moviechat/server/internal/config"
	"moviechat/server/internal/db"
	"moviechat/server/internal/ws"

	"github.com/go-chi/chi/v5"
)

func main() {
	cfg := config.Load()
	dbx, err := db.Open(cfg.DatabasePath, cfg.EphemeralMode)
	if err != nil {
		log.Fatal(err)
	}
	hub := ws.NewHub(cfg, dbx)

	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	r.Get("/ws", hub.Handle)

	addr := fmt.Sprintf("%s:%s", cfg.Host, cfg.Port)
	log.Printf("server starting on %s tls=%v ephemeral=%v", addr, cfg.TLSCertPath != "" && cfg.TLSKeyPath != "", cfg.EphemeralMode)
	if cfg.TLSCertPath != "" && cfg.TLSKeyPath != "" {
		log.Fatal(http.ListenAndServeTLS(addr, cfg.TLSCertPath, cfg.TLSKeyPath, r))
	}
	log.Fatal(http.ListenAndServe(addr, r))
}
