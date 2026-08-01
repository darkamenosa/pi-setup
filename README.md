# Pi Setup

Personal Pi agent setup: a snapshot of the extensions and skills this machine uses, kept for reference, backup, and sharing.

## Contents

| Directory | Source | What's included |
|---|---|---|
| `extensions/` | `~/Workspace/pi/extensions` (11 files) + `~/.pi/agent/extensions` (14 files) | All `.ts` extension source code. Tests excluded; symlinks resolved to actual files. |
| `skills/` | `~/.pi/agent/skills` (23 skills) | Full skill folders: `SKILL.md`, scripts, templates, examples. |

## Updating the snapshot

```bash
# extensions (code only — no tests)
cp ~/Workspace/pi/extensions/*.ts extensions/

# personal extensions (actual files only — ignore symlinks)
find ~/.pi/agent/extensions -maxdepth 1 -type f -name "*.ts" -exec cp {} extensions/ \;

# skills
cp -R ~/.pi/agent/skills/. skills/
rm -f skills/.DS_Store
```

## Authentication requirements

No credentials live in this repo. The tools below read auth from your machine at runtime.

### Codex search & vision (`codex-search.ts`, `codex-vision.ts`)

These tools call OpenAI through the official Codex CLI OAuth flow, so **you need Codex auth on the machine**:

1. Run `codex login` once — it creates `~/.codex/auth.json` with your OAuth tokens.
2. Credential resolution order:
   - `CODEX_AUTH_JSON` env var → path to a custom auth file
   - `~/.codex/auth.json` (or `$CODEX_HOME/auth.json` if `CODEX_HOME` is set)
   - `CODEX_ACCESS_TOKEN` env var → must contain a ChatGPT account id claim
3. Expired access tokens are auto-refreshed using the refresh token. If the auth file has no refresh token (or refresh fails), re-run `codex login`.
4. The embedded `app_EMoamEEZ73f0CkXaXp7hrann` is the **public** OAuth client id from the official Codex CLI — not a secret.

> No `codex login` → the tools fail with: *"No local Codex OAuth credentials found. Run `codex login` first."*

### Grok search (`grok-search.ts`)

The same idea, but auth comes from **Pi's own xAI OAuth** instead of a separate CLI:

1. Run `/login xai` inside Pi once — Pi stores the OAuth token in its auth store.
2. The extension pulls the token through Pi's model registry (provider: `xai`).
3. The request is sent to the grok CLI chat proxy with a `grok-shell` user-agent; the version is read from `~/.grok/version.json` (defaults to `0.2.93`).

> No xAI OAuth → the tool fails with: *"Pi xAI OAuth is not configured. Run /login xai, then retry."*

Optional environment variables:

| Variable | Default |
|---|---|
| `GROK_SEARCH_MODEL` | `grok-4.20-multi-agent` |
| `GROK_CLI_CHAT_PROXY_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` |
| `GROK_SEARCH_OUTPUT_DIR` | `~/.pi/agent/grok-search/outputs` |

## Security

- No API keys, tokens, private keys, or auth files are stored in this repo.
- Sensitive state stays on the machine: `~/.codex/auth.json`, Pi's OAuth store, `~/.grok/`.
- `.gitignore` keeps out `.pi/`, `.env`, `node_modules`, logs, and editor junk.
- Auth failures fail loudly with instructions (never silently fall back to unauthenticated calls).
