package db

import (
	"database/sql"
	"errors"
	"time"

	"moviechat/server/internal/auth"
	"moviechat/server/internal/model"

	_ "modernc.org/sqlite"
)

type DB struct {
	SQL       *sql.DB
	Ephemeral bool
}

func Open(path string, ephemeral bool) (*DB, error) {
	dsn := path
	if ephemeral {
		dsn = "file::memory:?cache=shared"
	}
	s, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	d := &DB{SQL: s, Ephemeral: ephemeral}
	if err := d.migrate(); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *DB) migrate() error {
	q := []string{
		`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, passhash TEXT NOT NULL, discoverable INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL);`,
		`CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL);`,
		`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL, body_or_ciphertext TEXT NOT NULL, created_at DATETIME NOT NULL, delivered_at DATETIME, seen_at DATETIME);`,
		`CREATE INDEX IF NOT EXISTS idx_messages_recipient_created ON messages(recipient_id, created_at);`,
	}
	for _, qq := range q {
		if _, err := d.SQL.Exec(qq); err != nil {
			return err
		}
	}
	return nil
}

func (d *DB) CreateUser(username, pass string) error {
	h, err := auth.HashPassword(pass)
	if err != nil {
		return err
	}
	_, err = d.SQL.Exec(`INSERT INTO users(username, passhash, created_at) VALUES(?,?,?)`, username, h, time.Now().UTC())
	return err
}

func (d *DB) UserByUsername(username string) (id int64, passhash string, err error) {
	err = d.SQL.QueryRow(`SELECT id, passhash FROM users WHERE username=?`, username).Scan(&id, &passhash)
	return
}

func (d *DB) UsernameByID(id int64) (string, error) {
	var u string
	err := d.SQL.QueryRow(`SELECT username FROM users WHERE id=?`, id).Scan(&u)
	return u, err
}

func (d *DB) SaveSession(userID int64, tokenHash string, exp time.Time) error {
	_, err := d.SQL.Exec(`INSERT INTO sessions(user_id, token_hash, expires_at, created_at) VALUES(?,?,?,?)`, userID, tokenHash, exp.UTC(), time.Now().UTC())
	return err
}

func (d *DB) SessionValid(userID int64, tokenHash string) bool {
	var c int
	err := d.SQL.QueryRow(`SELECT COUNT(1) FROM sessions WHERE user_id=? AND token_hash=? AND expires_at>?`, userID, tokenHash, time.Now().UTC()).Scan(&c)
	return err == nil && c > 0
}

func (d *DB) DeleteSessions(userID int64) error {
	_, err := d.SQL.Exec(`DELETE FROM sessions WHERE user_id=?`, userID)
	return err
}

func (d *DB) SaveMessage(senderID, recipientID int64, body string) (int64, time.Time, error) {
	now := time.Now().UTC()
	res, err := d.SQL.Exec(`INSERT INTO messages(sender_id, recipient_id, body_or_ciphertext, created_at) VALUES(?,?,?,?)`, senderID, recipientID, body, now)
	if err != nil {
		return 0, time.Time{}, err
	}
	id, _ := res.LastInsertId()
	return id, now, nil
}

func (d *DB) MarkDelivered(msgID int64) (time.Time, error) {
	now := time.Now().UTC()
	_, err := d.SQL.Exec(`UPDATE messages SET delivered_at=? WHERE id=?`, now, msgID)
	return now, err
}

func (d *DB) MarkSeen(msgID int64) (time.Time, error) {
	now := time.Now().UTC()
	_, err := d.SQL.Exec(`UPDATE messages SET seen_at=? WHERE id=?`, now, msgID)
	return now, err
}

func (d *DB) UndeliveredFor(userID int64) ([]model.Message, error) {
	rows, err := d.SQL.Query(`SELECT m.id, u1.username, u2.username, m.body_or_ciphertext, m.created_at FROM messages m JOIN users u1 ON m.sender_id=u1.id JOIN users u2 ON m.recipient_id=u2.id WHERE m.recipient_id=? AND m.delivered_at IS NULL ORDER BY m.created_at ASC`, userID)
	if err != nil { return nil, err }
	defer rows.Close()
	var out []model.Message
	for rows.Next() {
		var m model.Message
		if err := rows.Scan(&m.ID, &m.From, &m.To, &m.Body, &m.CreatedAt); err != nil { return nil, err }
		out = append(out, m)
	}
	return out, nil
}

func (d *DB) Users() ([]string, error) {
	rows, err := d.SQL.Query(`SELECT username FROM users WHERE discoverable=1 ORDER BY username ASC`)
	if err != nil { return nil, err }
	defer rows.Close()
	var out []string
	for rows.Next() { var u string; rows.Scan(&u); out = append(out, u) }
	return out, nil
}

func (d *DB) ResolveUser(username string) (int64, error) {
	var id int64
	err := d.SQL.QueryRow(`SELECT id FROM users WHERE username=?`, username).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) { return 0, errors.New("user_not_found") }
	return id, err
}

func (d *DB) Inbox(userID int64, limit int) ([]model.Message, error) {
	rows, err := d.SQL.Query(`SELECT m.id, u1.username, u2.username, m.body_or_ciphertext, m.created_at, m.delivered_at, m.seen_at
FROM messages m JOIN users u1 ON m.sender_id=u1.id JOIN users u2 ON m.recipient_id=u2.id
WHERE m.sender_id=? OR m.recipient_id=? ORDER BY m.created_at DESC LIMIT ?`, userID, userID, limit)
	if err != nil { return nil, err }
	defer rows.Close()
	var out []model.Message
	for rows.Next() {
		var m model.Message
		if err := rows.Scan(&m.ID,&m.From,&m.To,&m.Body,&m.CreatedAt,&m.DeliveredAt,&m.SeenAt); err != nil { return nil, err }
		out=append(out,m)
	}
	return out,nil
}
