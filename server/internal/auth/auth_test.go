package auth

import "testing"

func TestPasswordHashVerify(t *testing.T) {
	h, err := HashPassword("secret123")
	if err != nil { t.Fatal(err) }
	if VerifyPassword(h, "secret123") != nil { t.Fatal("verify failed") }
	if VerifyPassword(h, "wrong") == nil { t.Fatal("expected wrong password") }
}

func TestValidateUsername(t *testing.T) {
	if !ValidateUsername("neo_01") { t.Fatal("valid username rejected") }
	if ValidateUsername("bad space") { t.Fatal("invalid accepted") }
}
