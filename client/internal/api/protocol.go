package api

import "time"

type Envelope struct {
	Type      string      `json:"type"`
	RequestID string      `json:"requestId,omitempty"`
	TS        int64       `json:"ts"`
	Payload   interface{} `json:"payload,omitempty"`
}

type AuthPayload struct {
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	Token    string `json:"token,omitempty"`
}

type MessagePayload struct {
	To        string `json:"to,omitempty"`
	Body      string `json:"body,omitempty"`
	MessageID int64  `json:"messageId,omitempty"`
}

type Message struct {
	ID          int64      `json:"id"`
	From        string     `json:"from"`
	To          string     `json:"to"`
	Body        string     `json:"body"`
	CreatedAt   time.Time  `json:"createdAt"`
	DeliveredAt *time.Time `json:"deliveredAt,omitempty"`
	SeenAt      *time.Time `json:"seenAt,omitempty"`
}

type UserInfo struct {
	Username string `json:"username"`
	Online   bool   `json:"online"`
}
