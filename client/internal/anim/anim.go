package anim

import (
	"fmt"
	"math/rand"
	"strings"
	"time"
)

func Startup(e2ee bool) {
	stages := []string{"Bootstrapping terminal uplink", "Negotiating secure channel", "Synchronizing routing tables"}
	for _, s := range stages {
		bar(s)
		hexScroll()
	}
	if e2ee {
		fmt.Println("E2EE: ON  | FP: ", fakeFP())
	} else {
		fmt.Println("E2EE: OFF | TLS session established | SID:", fakeFP()[:12])
	}
}

func SendSequence() {
	bar("Serializing payload")
	bar("Securing")
	bar("Packetizing")
	bar("Transmitting")
}

func ReceiveSequence(e2ee bool) {
	bar("Inbound stream detected")
	bar("Verifying integrity")
	if e2ee { bar("Decryption complete") } else { bar("Secure transport complete") }
}

func bar(title string) {
	for i:=0;i<=20;i++ {
		fmt.Printf("\r%-30s [%s%s]", title, strings.Repeat("█",i), strings.Repeat(" ",20-i))
		time.Sleep(20*time.Millisecond)
	}
	fmt.Print("\n")
}
func hexScroll() {
	chars := "0123456789abcdef"
	for i:=0;i<3;i++ {
		var b strings.Builder
		for j:=0;j<48;j++ { b.WriteByte(chars[rand.Intn(len(chars))]) }
		fmt.Println(b.String())
		time.Sleep(30*time.Millisecond)
	}
}
func fakeFP() string {
	hex := "0123456789ABCDEF"; parts := make([]string,8)
	for i:=range parts { var b strings.Builder; for j:=0;j<8;j++ { b.WriteByte(hex[rand.Intn(len(hex))]) }; parts[i]=b.String() }
	return strings.Join(parts, "-")
}
