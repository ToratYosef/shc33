.PHONY: build test clean

build:
	mkdir -p dist
	cd server && go build -o ../dist/server ./cmd/server
	cd client && go build -o ../dist/chat ./cmd/chat

build-client-all:
	mkdir -p dist
	cd client && GOOS=linux GOARCH=amd64 go build -o ../dist/chat-linux-amd64 ./cmd/chat
	cd client && GOOS=windows GOARCH=amd64 go build -o ../dist/chat-windows-amd64.exe ./cmd/chat
	cd client && GOOS=darwin GOARCH=amd64 go build -o ../dist/chat-darwin-amd64 ./cmd/chat
	cd client && GOOS=darwin GOARCH=arm64 go build -o ../dist/chat-darwin-arm64 ./cmd/chat

build-server:
	mkdir -p dist
	cd server && go build -o ../dist/server ./cmd/server

test:
	cd server && go test ./...

clean:
	rm -rf dist
