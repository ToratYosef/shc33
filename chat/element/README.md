# Element deployment notes

This project uses `vectorim/element-web:latest` via Docker Compose.

- Runtime config is mounted from `chat/element/config.json`.
- In requested path mode, Element is served at `/chat/ui/` through Nginx.
- In recommended subdomain mode, Element is served at `/` on `chat.example.com`.

If you want a pinned version, change the image tag in `chat/docker-compose.yml`.
