# feeds

A fast, keyboard-driven RSS reader web UI that reads the Fluent Reader SQLite
database directly (`~/.config/fluent-reader/fluent-reader.db`), same schema,
same feeds. It owns fetching, so the Fluent Reader app itself is optional.

## Run

The server runs as a systemd user service:

```bash
systemctl --user status feeds        # check it
systemctl --user restart feeds       # restart after code changes
journalctl --user -u feeds -f        # follow logs
```

Open the UI: `chromium --app=http://127.0.0.1:8787`, or launch **Feeds** from
the app launcher.

Dev loop: `npm run dev` (vite on :5173, proxies /api to :8787), then
`npm run build` to refresh the served UI.

## What it does

- Server (Node 26 + `node:sqlite`, Fastify, port 8787):
  - API: feeds/groups with unread counts, paged items, item content,
    PATCH read/starred, manual fetch trigger.
  - Fetcher: pulls all sources every 30 min (reads `fetchInterval` from
    Fluent Reader's config.json), dedupes on guid-or-link inside an
    immediate transaction.
  - Theme: parses the current Omarchy theme's `colors.toml` into CSS
    variables, so the UI follows your theme.
- UI (React + Vite): sidebar with groups, magazine list with thumbnails,
  article pane with sanitized HTML (DOMPurify).

## Keys

| key | action |
| --- | --- |
| `j` / `k` (or arrows) | next / previous item |
| `o` / `enter` | open article (marks read) |
| `m` | toggle read |
| `s` | star |
| `u` | toggle unread-only |
| `r` | fetch now |
| `esc` | close article |

## Notes

- Fluent Reader fetches only while its app is open. Either app can fetch;
  both write to the same DB with guarded inserts, so nothing duplicates.
  Reading in both UIs at once is fine but unnecessary.
- Backups of the original db/config live in
  `~/.config/fluent-reader/backup-pre-feeds-*`.
