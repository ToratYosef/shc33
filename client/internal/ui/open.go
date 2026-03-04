package ui

import (
	"fmt"
	"strings"

	"moviechat/client/internal/api"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"
)

func Open(client *api.Client, username string) error {
	app := tview.NewApplication()
	contacts := tview.NewList()
	contacts.SetBorder(true).SetTitle(" Contacts ")
	chat := tview.NewTextView()
	chat.SetDynamicColors(true)
	chat.SetBorder(true).SetTitle(" Conversation ")
	input := tview.NewInputField().SetLabel("> ").SetFieldWidth(0)
	status := tview.NewTextView().SetText("Ctrl+S send | Ctrl+C quit").SetDynamicColors(true)

	var selected string
	refreshUsers := func() {
		env, err := client.Request("USERS_LIST", map[string]any{})
		if err != nil { status.SetText("[red]users error"); return }
		list, _ := api.DecodePayload[[]api.UserInfo](env)
		contacts.Clear()
		for _, u := range list {
			if u.Username == username { continue }
			label := u.Username
			if u.Online { label += " [green]●" } else { label += " [gray]○" }
			user := u.Username
			contacts.AddItem(label, "", 0, func() {
				selected = user
				chat.SetTitle(fmt.Sprintf(" Conversation: %s ", selected))
			})
		}
	}
	refreshUsers()

	contacts.SetSelectedFunc(func(i int, main, sec string, r rune) { selected = strings.Fields(main)[0] })

	app.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		if ev.Key() == tcell.KeyCtrlC { app.Stop(); return nil }
		if ev.Key() == tcell.KeyCtrlS {
			msg := input.GetText()
			if selected == "" || strings.TrimSpace(msg)=="" { return nil }
			if err := client.Send("MSG_SEND", api.MessagePayload{To:selected, Body:msg}); err != nil { status.SetText("[red]send failed"); return nil }
			fmt.Fprintf(chat, "[yellow]%s -> %s:[white] %s\n", username, selected, msg)
			input.SetText("")
			return nil
		}
		return ev
	})

	go func() {
		for {
			var env api.Envelope
			if err := client.Conn.ReadJSON(&env); err != nil { return }
			if env.Type == "MSG_DELIVERED" {
				m, _ := api.DecodePayload[api.Message](env)
				app.QueueUpdateDraw(func() { fmt.Fprintf(chat, "[green]%s:[white] %s\n", m.From, m.Body) })
			}
			if env.Type == "PRESENCE_UPDATE" { app.QueueUpdateDraw(func(){ status.SetText("presence updated") }) }
		}
	}()

	layout := tview.NewFlex().SetDirection(tview.FlexRow).
		AddItem(tview.NewFlex().AddItem(contacts, 30, 1, true).AddItem(chat, 0, 3, false), 0, 1, true).
		AddItem(input, 1, 0, false).
		AddItem(status, 1, 0, false)

	return app.SetRoot(layout, true).Run()
}
