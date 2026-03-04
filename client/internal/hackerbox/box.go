package hackerbox

import (
	"fmt"
	"math/rand"
	"os"
	"strings"
	"time"
)

const (
	reset  = "\033[0m"
	green  = "\033[32m"
	bright = "\033[92m"
	dim    = "\033[2m"
	black  = "\033[40m"
)

var dramatic = []string{
	"INJECTING PAYLOAD",
	"COMPILING PACKETS",
	"DEPLOYING SIGNAL",
	"INITIALIZING DATA STREAM",
	"ENCRYPTING FRAGMENTS",
	"TRANSMITTING BURST",
	"VERIFYING HANDSHAKE",
	"BYPASSING FIREWALL",
}

func ShowAuthorizedBox() { renderHackerBox([]string{"AUTHORIZED TERMINAL", "ACCESS GRANTED"}, "ok") }
func ShowDeniedBox()     { renderHackerBox([]string{"ACCESS DENIED", "INVALID CREDENTIALS"}, "err") }
func ShowMessageSentBox() {
	renderHackerBox([]string{"MESSAGE SENT", "TRANSMISSION COMPLETE"}, "ok")
}
func ShowMessageFailedBox() {
	renderHackerBox([]string{"TRANSMISSION FAILED", "RETRY REQUIRED"}, "err")
}
func ShowStatusBox(message string) { renderHackerBox([]string{message}, "status") }

func ShowRandomDramatic(count int) {
	if count < 1 {
		count = 1
	}
	for i := 0; i < count; i++ {
		ShowStatusBox(dramatic[rand.Intn(len(dramatic))])
	}
}

func renderHackerBox(lines []string, kind string) {
	PauseMatrixRain()
	defer ResumeMatrixRain()

	width := 34
	term := 100
	if c := os.Getenv("COLUMNS"); c != "" {
		fmt.Sscanf(c, "%d", &term)
	}
	if term < width+2 {
		term = width + 2
	}
	pad := strings.Repeat(" ", (term-width)/2)
	color := bright
	if kind == "err" {
		color = green
	}

	top := "╔" + strings.Repeat("═", width-2) + "╗"
	midBlank := "║" + strings.Repeat(" ", width-2) + "║"
	bottom := "╚" + strings.Repeat("═", width-2) + "╝"

	fmt.Print("\033[2J\033[H")
	fmt.Println(black + dim + pad + top + reset)
	fmt.Println(black + dim + pad + midBlank + reset)
	for _, line := range lines {
		centered := center(line, width-2)
		typed := typewriter(centered)
		fmt.Println(black + color + pad + "║" + typed + "║" + reset)
		fmt.Println(black + dim + pad + midBlank + reset)
	}
	fmt.Println(black + dim + pad + bottom + reset)
	time.Sleep(time.Duration(1200+rand.Intn(600)) * time.Millisecond)
	fmt.Print("\033[2J\033[H")
}

func center(s string, n int) string {
	if len(s) >= n {
		return s[:n]
	}
	l := (n - len(s)) / 2
	r := n - len(s) - l
	return strings.Repeat(" ", l) + s + strings.Repeat(" ", r)
}

func typewriter(s string) string {
	r := []rune(s)
	for range r {
		time.Sleep(8 * time.Millisecond)
	}
	return s
}

var rainPaused bool

func PauseMatrixRain()   { rainPaused = true }
func ResumeMatrixRain()  { rainPaused = false }
func MatrixPaused() bool { return rainPaused }
