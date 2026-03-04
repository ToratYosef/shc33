package db

import "testing"

func TestOfflineQueueFlow(t *testing.T) {
	db, err := Open("", true)
	if err != nil { t.Fatal(err) }
	if err := db.CreateUser("alice", "password123"); err != nil { t.Fatal(err) }
	if err := db.CreateUser("bob", "password123"); err != nil { t.Fatal(err) }
	alice, _ := db.ResolveUser("alice")
	bob, _ := db.ResolveUser("bob")
	id, _, err := db.SaveMessage(alice, bob, "hi")
	if err != nil { t.Fatal(err) }
	msgs, err := db.UndeliveredFor(bob)
	if err != nil || len(msgs) != 1 { t.Fatalf("expected 1 undelivered, got %d err=%v", len(msgs), err) }
	if _, err := db.MarkDelivered(id); err != nil { t.Fatal(err) }
	msgs, _ = db.UndeliveredFor(bob)
	if len(msgs) != 0 { t.Fatalf("expected 0 undelivered got %d", len(msgs)) }
}
