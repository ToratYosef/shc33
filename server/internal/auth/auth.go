package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type Claims struct {
	UserID   int64  `json:"uid"`
	Username string `json:"usr"`
	JTI      string `json:"jti"`
	jwt.RegisteredClaims
}

func HashPassword(pass string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.DefaultCost)
	return string(b), err
}
func VerifyPassword(hash, pass string) error { return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pass)) }

func NewToken(secret string, userID int64, username string, ttl time.Duration) (token string, jti string, exp time.Time, err error) {
	now := time.Now()
	exp = now.Add(ttl)
	jti = uuid.NewString()
	claims := Claims{UserID: userID, Username: username, JTI: jti, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(exp), IssuedAt: jwt.NewNumericDate(now)}}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	token, err = t.SignedString([]byte(secret))
	return
}

func ParseToken(secret, tok string) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(tok, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if token.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, errors.New("invalid signing method")
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

func HashToken(token string) string {
	s := sha256.Sum256([]byte(token))
	return hex.EncodeToString(s[:])
}

func ValidateUsername(u string) bool {
	if len(u) < 3 || len(u) > 24 {
		return false
	}
	for _, ch := range u {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
			continue
		}
		return false
	}
	return true
}
