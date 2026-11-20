# Setting up your Alef

This file is a brief for an AI assistant and for you. Open the repo in Claude Code and ask it to set up your Alef. The assistant follows this file.

## Rules for the assistant

1. Ask in batches of up to four questions. Give a recommended answer for each. Don't ask one at a time.
2. Read the code before asking when the code can answer.
3. Write nothing until the user confirms the summary.
4. Never write a secret value into the repo. Keys stay in the Keychain or the environment.
5. Never load, unload or edit a launchd job without the user's explicit yes.
6. Never touch a service the user lists as live. Ask first.

## Batch 1: where things live

1. Where are your projects? (recommended: `~/Documents/Code`)
2. Where is your Obsidian vault, if you have one? (recommended: none, the vault views stay empty)
3. Do you want Alef to read transcripts from every project, or only from a list? (recommended: every project)

## Batch 2: what matters to you

1. Which projects should be their own district? (recommended: your three most active)
2. Which launchd jobs or routines should Alef show? (recommended: none on day one)
3. Which services must never be touched, such as a tunnel or a public site? (list them, or none)
4. Do you want the voice brain? It needs a model key. (recommended: off)

## Batch 3: how Jev routes

1. Which deliverables do you produce most: documents, slides, code, research? (recommended: code and documents)
2. How much should the router ask before acting? (recommended: only when the card lists a question)

## What the assistant writes

After the answers, the assistant shows a summary and waits for a yes. Then it writes:

- `.env` at the repo root with the environment variables for the answers (`ALEF_VAULT_DIR`, `ALEF_PORT`, and any others you chose). It is git-ignored. Load it with `set -a; source .env; set +a` before `npm run dev`.
- Edits to `server/heuristics.ts` for the district rules you named.
- A `docs/live-services.md` notes file listing the services to protect, for you to read. The guard does not read it automatically.

Then it runs `npm run typecheck`, and reports the result. It starts the dev server only when asked.

## Checking it worked

- `npm run dev` starts without errors.
- The planet shows a point for each recent Claude Code session.
- Each district you named shows the sessions you expect.
