# The Kalon Bot

## Deploy

1. Push this repository to GitHub.
2. On the server, clone the repo.
3. Create a real `.env` file on the server with your secrets.
4. Build and run with Docker:

```bash
git clone <your-repo-url>
cd the_kalon
cp .env.example .env
# edit .env and fill your real values
sudo docker compose up -d --build
```

### Notes
- The app runs with `npm run bot`.
- The container uses `.env` from the project root.
- Do not commit your real `.env` file to GitHub.
