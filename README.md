# Synced Up

Reliable two-way sync between an Obsidian vault and a Dropbox folder, designed for
**Obsidian on iOS** (also works on Android and desktop). On a Mac you can keep using the
official Dropbox client; this plugin syncs the same folder from the phone.

## How it stays reliable

| Problem in other sync plugins | What this plugin does |
| --- | --- |
| Compares modification times, which iOS and Dropbox change freely → phantom changes, missed edits | Compares **content** using Dropbox's own `content_hash`, computed locally |
| Re-lists the whole Dropbox folder every time | Uses Dropbox **incremental cursors**: only changes since the last sync are fetched |
| Can't tell "deleted here" from "created there" | Remembers the last agreed version of every file (**three-way comparison**) |
| Overwrites the other side's edits | Uploads are **conditional on the revision we saw** (`strict_conflict`); if Dropbox changed meanwhile, the file is retried next sync |
| Conflicts → errors or lost text | **Both versions are kept**: `Note (conflict iPhone 2026-11-06 0905).md` |
| A bug or empty vault wipes Dropbox | **Asks before deleting** more than N files and refuses to mirror an empty vault; local deletions go to `.trash` |
| iOS kills the app mid-sync → broken state | State is checkpointed during the sync and written atomically; an interrupted run just continues |
| Cyrillic / accented names duplicated or failing | Unicode-normalized (NFC) and case-insensitive matching, ASCII-safe API headers |

Files that are already identical on both sides (e.g. a vault previously downloaded
by another app) are recognised by content and **not transferred again**.

## Modes

- **Manual** — sync only when you tap the ribbon button or run *Sync now*.
- **Automatic** — on startup, when you return to the app, a few seconds after you stop
  editing, and every N minutes.

You can start a sync from:

- the **↻ button in the header** of any open note (can be turned off in settings),
- **Sync with Dropbox** in a note's **⋯** menu,
- the **Sync** row at the top of the plugin settings,
- the command palette (*Synced Up: Sync now*), which you can also add to the mobile
  toolbar,
- the ribbon, on desktop.

*Preview* (*Preview sync (dry run)* in the command palette) shows exactly what would be downloaded, uploaded, deleted or
treated as a conflict, without changing anything. *Show sync log* shows what happened
(with a Copy button for bug reports).

## Setup

1. Install the plugin. Until it is in the community plugin list, use
   [BRAT](https://github.com/TfTHacker/obsidian42-brat): *BRAT → Add beta plugin* →
   `vicmosin/obsidian-synced-up`.
2. Settings → *Synced Up* → **Connect**, sign in to Dropbox and press **Allow**.
   If you are not returned to Obsidian automatically, use **Connect with code** and paste
   the code Dropbox shows.
3. **Dropbox folder**: the folder holding your vault, as it appears in Dropbox,
   e.g. `/Obsidian/Diary`.
4. Run **Preview sync** once to check the plan, then **Sync now**.

No Dropbox developer account or app registration is needed. Sign-in uses OAuth with
PKCE, so the plugin contains no secret: the built-in app key only identifies the app,
and access is granted solely by you on Dropbox's own page. You can revoke it any time at
<https://www.dropbox.com/account/connected_apps>.

### Using your own Dropbox app (optional)

1. <https://www.dropbox.com/developers/apps> → **Create app** → **Scoped access** →
   **Full Dropbox**.
2. **Permissions**: enable `files.metadata.read`, `files.metadata.write`,
   `files.content.read`, `files.content.write`, then **Submit**.
3. **Settings → Redirect URIs**: add `obsidian://synced-up-auth`.
4. Paste its **App key** into *Advanced → Custom Dropbox app key*.

## What is synced

Everything in the vault except the patterns in *Excluded paths* (default: `.trash/`,
`.DS_Store`, temp files). The `.obsidian` folder is **not** synced by default, because a
phone and a computer usually want different settings and plugins. Per-device files
(`workspace.json`, `workspace-mobile.json`) and this plugin's own folder (state, tokens,
log) are never synced.

## Development

```bash
npm install
npm test        # unit + scenario tests against an in-memory Dropbox
npm run build   # main.js
```

The sync logic is independent of Obsidian:

- `src/sync/plan.ts`: pure three-way decision per file (the table in `decide`)
- `src/sync/engine.ts`: fetch remote delta → scan vault → plan → execute with checkpoints
- `src/dropbox/`: Dropbox HTTP API client and PKCE auth
- `src/obsidian/`: vault adapter, state file, settings and UI

To release, bump `version` in `manifest.json`, `package.json` and `versions.json`
and merge to `main`. GitHub Actions then builds and publishes the release that BRAT installs.

## Disclaimer

Synced Up is an independent project and is not affiliated with or endorsed by Dropbox, Inc.

## License

MIT
