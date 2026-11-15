<p align="center">
  <img src="design/icon.svg" alt="Wellsprings" width="110" />
</p>

<h1 align="center">Wellsprings</h1>

<p align="center">
  A keyboard-driven RSS reader for the Linux desktop.<br>
  Feeds are springs. Groups are streams. Everything is local.
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Wellsprings" width="860" />
</p>

## Why

Wellsprings is a local-first feed reader built on Rust and Tauri. No accounts,
no cloud, no telemetry. Your feeds and articles live in a SQLite database on
your machine, and a background loop keeps them fresh while the app sits quietly
in your tray.

- **Keyboard driven**: hjkl moves across the article grid, plus o, m, s, u, r
  for open, mark read, star, unread only, and refresh. The mouse is optional.
- **Streams**: bundle feeds into streams, drag and drop to reorder them right
  in the sidebar, or reorganize everything in the settings sheet.
- **Background fetching**: a fetch loop runs on a configurable interval
  (default 30 minutes) even with the window closed.
- **Close to tray**: closing the window hides it. Fetching never stops.
- **Live theming**: follows Omarchy theme changes within seconds. On other
  desktops it falls back to a fixed Dracula look.
- **Dedupe**: items are keyed by guid and raw link, so a feed that changes its
  URL scheme midstream does not double post.

## Keys

| Key | Action |
| --- | --- |
| `j` / `k` | move down / up |
| `h` / `l` | move left / right |
| `o` or `Enter` | open article |
| `m` | toggle read |
| `s` | star |
| `u` | unread only |
| `r` | refresh |
| `Esc` | close article |

## Build

Requirements: Rust (rustup), Node 20+, and the
[Tauri Linux prerequisites](https://tauri.app/start/prerequisites/)
(webkit2gtk 4.1 and friends).

```bash
npm install
npm run tauri dev      # run it
npm run tauri build    # package a .deb
```

On first run Wellsprings creates its database at
`~/.local/share/com.georgeferreira.wellsprings/wellsprings.db` and starts
fetching any feeds you add in settings.

## Roadmap

- [ ] Search over titles and content (the FTS5 schema is already in place)
- [ ] OPML import and export
- [ ] One time import from Fluent Reader
- [ ] macOS builds

## License

MIT. See [LICENSE](LICENSE).
