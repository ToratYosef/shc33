package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Host            string
	Port            string
	DatabasePath    string
	TokenSecret     string
	AllowRegister   bool
	EphemeralMode   bool
	MaxMessageBytes int
	TokenTTL        time.Duration
	TLSCertPath     string
	TLSKeyPath      string
}

func Load() Config {
	return Config{
		Host:            getenv("HOST", "0.0.0.0"),
		Port:            getenv("PORT", "8080"),
		DatabasePath:    getenv("DATABASE_PATH", "./moviechat.db"),
		TokenSecret:     getenv("TOKEN_SECRET", "dev-secret-change-me"),
		AllowRegister:   getenvBool("ALLOW_REGISTRATION", true),
		EphemeralMode:   getenvBool("EPHEMERAL_MODE", false),
		MaxMessageBytes: getenvInt("MAX_MESSAGE_BYTES", 4096),
		TokenTTL:        time.Duration(getenvInt("TOKEN_TTL_HOURS", 24)) * time.Hour,
		TLSCertPath:     os.Getenv("TLS_CERT_PATH"),
		TLSKeyPath:      os.Getenv("TLS_KEY_PATH"),
	}
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func getenvInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return d
}
func getenvBool(k string, d bool) bool {
	if v := os.Getenv(k); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return d
}
