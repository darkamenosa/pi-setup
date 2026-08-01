# Pi Agent Extensions & Skills

A collection of extensions and skills for [Pi](https://github.com/earendil-works/pi-coding-agent), the local coding agent. This repo bundles a curated set of tools for web research (Codex & Grok search), image analysis, subagent orchestration, memory, scheduling, and developer productivity — ready to install into any Pi setup.

## Contents

| Directory | What's included |
|---|---|
| `extensions/` | 25 Pi extension sources (`.ts`). Code only — tests and symlinks excluded. |
| `skills/` | 23 skill folders, each with `SKILL.md` plus scripts, templates, and examples. |

Highlights:

- **Search & vision** — `codex-search`, `codex-vision`, `grok-search`: live web research and image analysis through Codex and Grok.
- **Automation** — `autocompact`, `schedule`, `goal`, `keep-thinking`, `fast`, `tps`: session lifecycle, scheduling, and token/perf tracking.
- **Agent tooling** — `subagent`, `control`, `session-breakdown`, `split-fork`, `review`, `answer`, `todos`, `files`, `unified-edit`, `prompt-editor`, `memory`, and more.
- **Skills** — browsing (`realbrowser`, `native-web-search`, `librarian`), audio (`transcribe`, `audio-transcription`), development (`ghidra`, `github`, `create-cli`, `uv`, `commit`, `update-changelog`), productivity (`gog`, `google-workspace`, `apple-mail`, `summarize`, `tmux`, `peekaboo`, `pi-share`, `sentry`, `oracle`, `openscad`, `frontend-design`, `whimsical`).

## Installation

Extensions and skills live under `~/.pi/agent/` in a Pi installation. Either copy or symlink them:

```bash
# extensions
mkdir -p ~/.pi/agent/extensions
cp extensions/*.ts ~/.pi/agent/extensions/

# skills
cp -R skills/* ~/.pi/agent/skills/

# or symlink for live updates
ln -s "$PWD/extensions"/*.ts ~/.pi/agent/extensions/
```

Then restart Pi (or run `/reload` if supported) to load the extensions.

## Requirements

- **Pi** — the extensions use the Pi SDK (`@earendil-works/pi-coding-agent`).
- **Node.js 18+** for skill scripts.

### Authentication

No credentials live in this repo. The tools below read auth from your machine at runtime.

#### Codex search & vision (`codex-search.ts`, `codex-vision.ts`)

These tools call OpenAI through the official Codex CLI OAuth flow, so **Codex auth is required on the machine**:

1. Run `codex login` once — it creates `~/.codex/auth.json` with your OAuth tokens.
2. Credential resolution order:
   - `CODEX_AUTH_JSON` env var → path to a custom auth file
   - `~/.codex/auth.json` (or `$CODEX_HOME/auth.json` if `CODEX_HOME` is set)
   - `CODEX_ACCESS_TOKEN` env var → must contain a ChatGPT account id claim
3. Expired access tokens are auto-refreshed using the refresh token. If the auth file has no refresh token (or refresh fails), re-run `codex login`.
4. The embedded `app_EMoamEEZ73f0CkXaXp7hrann` is the **public** OAuth client id from the official Codex CLI — not a secret.

> Without `codex login`, these tools fail with: *"No local Codex OAuth credentials found. Run `codex login` first."*

#### Grok search (`grok-search.ts`)

Same idea, but auth comes from **Pi's own xAI OAuth** instead of a separate CLI:

1. Run `/login xai` inside Pi once — Pi stores the OAuth token in its auth store.
2. The extension pulls the token through Pi's model registry (provider: `xai`).
3. Requests are sent to the grok CLI chat proxy with a `grok-shell` user-agent; the version is read from `~/.grok/version.json` (defaults to `0.2.93`).

> Without xAI OAuth, the tool fails with: *"Pi xAI OAuth is not configured. Run /login xai, then retry."*

Optional environment variables:

| Variable | Default |
|---|---|
| `GROK_SEARCH_MODEL` | `grok-4.20-multi-agent` |
| `GROK_CLI_CHAT_PROXY_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` |
| `GROK_SEARCH_OUTPUT_DIR` | `~/.pi/agent/grok-search/outputs` |

## Security

- No API keys, tokens, private keys, or auth files are stored in this repo.
- Sensitive state stays on the machine: `~/.codex/auth.json`, Pi's OAuth store, `~/.grok/`.
- Auth failures fail loudly with instructions — never a silent fallback to unauthenticated calls.

## License

Apache 2.0. Individual skills may carry their own license files (see `skills/transcribe/LICENSE.txt`).
