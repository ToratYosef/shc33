package anim

import (
	"fmt"
	"math/rand"
	"strings"
	"time"

	"moviechat/client/internal/hackerbox"
)

var rainRunning bool

func Startup(e2ee bool) {
	StartMatrixRain()
	stages := []string{"Bootstrapping terminal uplink", "Negotiating secure channel", "Synchronizing routing tables"}
	for _, s := range stages {
		bar(s, 45*time.Millisecond)
		hexScroll(6)
	}
	if e2ee {
		fmt.Println("E2EE: ON  | FP: ", fakeFP())
	} else {
		fmt.Println("E2EE: OFF | TLS session established | SID:", fakeFP()[:12])
	}
}

func SendSequence() {
	StartMatrixRain()
	bar("Serializing payload", 55*time.Millisecond)
	bar("Securing transport", 55*time.Millisecond)
	bar("Packetizing", 55*time.Millisecond)
	bar("Transmitting", 55*time.Millisecond)
}

func ReceiveSequence(e2ee bool) {
	bar("Inbound stream detected", 45*time.Millisecond)
	bar("Verifying integrity", 45*time.Millisecond)
	if e2ee {
		bar("Decryption complete", 45*time.Millisecond)
	} else {
		bar("Secure transport complete", 45*time.Millisecond)
	}
}

func bar(title string, d time.Duration) {
	for i := 0; i <= 20; i++ {
		fmt.Printf("\r\033[92m%-30s\033[0m [\033[32m%s\033[0m%s]", title, strings.Repeat("█", i), strings.Repeat(" ", 20-i))
		time.Sleep(d)
	}
	fmt.Print("\n")
}
func hexScroll(lines int) {
	chars := "0123456789abcdef"
	for i := 0; i < lines; i++ {
		var b strings.Builder
		for j := 0; j < 52; j++ {
			b.WriteByte(chars[rand.Intn(len(chars))])
		}
		fmt.Println("\033[32m" + b.String() + "\033[0m")
		time.Sleep(70 * time.Millisecond)
	}
}
func fakeFP() string {
	hex := "0123456789ABCDEF"
	parts := make([]string, 8)
	for i := range parts {
		var b strings.Builder
		for j := 0; j < 8; j++ {
			b.WriteByte(hex[rand.Intn(len(hex))])
		}
		parts[i] = b.String()
	}
	return strings.Join(parts, "-")
}

func StartMatrixRain() {
	if rainRunning {
		return
	}
	rainRunning = true
	go func() {
		chars := "01abcdef"
		for rainRunning {
			if hackerbox.MatrixPaused() {
				time.Sleep(60 * time.Millisecond)
				continue
			}
			var b strings.Builder
			for i := 0; i < 36; i++ {
				b.WriteByte(chars[rand.Intn(len(chars))])
			}
			fmt.Println("\033[2m\033[32m" + b.String() + "\033[0m")
			time.Sleep(120 * time.Millisecond)
		}
	}()
}

func StopMatrixRain() { rainRunning = false }
