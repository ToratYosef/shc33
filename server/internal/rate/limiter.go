package rate

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

type Limiter struct {
	mu       sync.Mutex
	capacity float64
	rate     float64
	items    map[string]*bucket
}

func New(capacity int, refillPerSec float64) *Limiter {
	return &Limiter{capacity: float64(capacity), rate: refillPerSec, items: map[string]*bucket{}}
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.items[key]
	if !ok {
		b = &bucket{tokens: l.capacity, last: now}
		l.items[key] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	b.tokens += elapsed * l.rate
	if b.tokens > l.capacity {
		b.tokens = l.capacity
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens -= 1
	return true
}
