# Alef

**A 3D planet of every Claude Code session on your machine.**

Alef draws each Claude Code session as a point on a continent. Sessions on the same project sit in the same district. A watcher reads the transcripts as they're written, so the planet updates while you work. Alef reads from your machine. Anything it sends elsewhere is a remote service you configure yourself.

Alef is a personal control room for one developer who runs many Claude Code sessions at once. This repo is the full build, open-sourced so you can fork it and adapt it.

---

## What's in it

- **The planet.** Sessions as points, grouped into districts by project or by automation. Click a district to see its sessions.
- **The feed.** Live events from sessions, with decisions that need you pulled to the top.
- **Jev, the router.** A hook that reads each prompt and suggests a skill, a model tier and a deliverable before the session starts. See `hooks/jev-router.mjs`.
- **Memory and vault views.** Claude Code memory and an Obsidian vault, searchable from the same screen.
- **Routine health.** Launchd jobs and scheduled routines, with their last run and output (`server/features/routines.ts`).
- **A voice brain.** Optional. Needs model keys you supply (see the environment variables below).
- **A guard.** `server/guard.ts` and the permission hook refuse actions that could take a live service offline.

## Requirements

- macOS. The watcher reads `~/.claude`, and the routine views use launchd. Nothing here is tested on Linux.
- Node.js 20 or newer.
- Claude Code, used on the same machine.
- Optional: an Obsidian vault for the vault views.

## Quick start

```bash
git clone https://github.com/<you>/alef.git
cd alef
npm install
npm run dev
```

The client runs on `http://localhost:5178` and the API on `5179`. Change them with `ALEF_CLIENT_PORT` and `ALEF_PORT`.

With no data yet, the planet is empty. Start a Claude Code session in any folder and it appears within a few seconds.

## Make it yours

Setup is a short set of questions, written up in [SETUP.md](SETUP.md). Open the repo in Claude Code and ask it to set up your Alef. It asks where your projects and vault are, which projects deserve their own district, and which services must never be touched. It then writes the answers as environment variables and a short notes file you can edit.

By hand, these are the knobs the code reads:

| Setting | What it does |
| --- | --- |
| `ALEF_VAULT_DIR` | Obsidian vault location. Default: `~/Documents/Code/alex_claude`. |
| `ALEF_DB_PATH` | SQLite database path. |
| `ALEF_PORT`, `ALEF_CLIENT_PORT` | API and client ports. |
| `ALEF_DISPATCH_DIR` | Where dispatch files are written. |
| `ROUTE_CARD_LOG` | Where Jev writes its routing log. |
| `OLLAMA_HOST`, `OLLAMA_EMBED_MODEL` | Local embedding model for memory search, if you use one. |
| `ELEVENLABS_API_KEY`, `TYPESAFE_API_KEY` | Optional service keys. Read them from the environment or the Keychain, never from a committed file. |
| Districts | `server/heuristics.ts` decides which district a session lands in. |

## How it fits together

```
Claude Code transcripts ──► indexer ──► SQLite ──► planet (client)
                                 │
hooks (jev-router, permissions) ─┘──► feed and decisions
                                 │
launchd, vault and memory ───────┴──► routine and memory views
```

- `server/indexer.ts` reads transcripts and writes events.
- `server/db.ts` holds them in SQLite.
- `server/heuristics.ts` assigns districts.
- `client/` renders the planet with Three.js and the feed.
- `hooks/` holds the Claude Code hooks.
- `scripts/` holds the launchd installers and their helpers.

More detail: [docs/FEATURES.md](docs/FEATURES.md), [docs/VIEWS.md](docs/VIEWS.md).

## Safety

- Alef doesn't upload transcripts or memory. Network calls happen only for services you configure.
- Secrets in transcripts are redacted before display (`server/activity.ts`, `server/privacy-guard.ts`).
- The guard refuses actions on services you list as live.
- Read the code before you give it access to your machine. It is a personal tool, not a hardened product.

## Tests

```bash
npm run typecheck
npm test
```

Some tests read local launchd and `~/.claude` state. They fail on a machine without that state. Run them on your own Mac before you rely on the results.

## Status

Experimental. It is one developer's working tool, so it changes often and parts of it are rough. Issues and pull requests are welcome, especially for setup and district heuristics.

## License

No license file yet. Until one is added, the code is not licensed for reuse.
