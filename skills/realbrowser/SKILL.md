---
name: realbrowser
description: Use for fast target-first local Chrome/Chromium browser control with stable labeled tabs, signed-in profiles, anonymous sessions, compact reads, screenshots, console logs, network request/response capture, root-scoped page actions, uploads, guarded submits, downloads, and PDF export. Use this skill whenever the task involves the user's actual Chrome browser — inspecting open tabs, reading console errors, capturing network traffic, taking screenshots of live pages, filling forms, uploading files, or any browser automation that needs signed-in state or existing browser context. Also use for anonymous page reads, responsive screenshots, and PDF generation via CDP.
---

# Realbrowser

Use `realbrowser` when a task needs the user's local browser state or a fast
managed browser. Target-first: resolve or create one tab target, then pass
`-t <label>` or `--handle` on every read, action, screenshot, console,
network, state, dialog, performance, download, or export command. Pointer
drag/drop is available through `action drag` with refs/selectors or viewport
CSS pixel coordinates.

The design is site-agnostic and OS-portable. Do not encode site names, UI
copy, or language-specific picker labels into the workflow. Use generic
browser state: profile/context, target, active root, refs, accessibility
labels, structural selectors, viewport/topmost checks, network entries,
downloads, artifacts. Site-specific CSS or text is only a last-mile selector
chosen after a scoped read proves it correct for the current page.

**Read the full SKILL.md once before the first browser action.** End to end
(no `head`/`tail`/`sed -n '1,N p'` slices). Efficiency Rules and Operating
Loop contain non-negotiable rules whose absence drives cost and failure loops.

## Fast Start

CLI at `scripts/realbrowser` (Node: `scripts/realbrowser.mjs`). Set
`REALBROWSER="<skill-directory>/scripts/realbrowser"` (POSIX) or
`$Realbrowser = Join-Path "<skill-directory>" "scripts\realbrowser.ps1"`
(PowerShell).

```bash
# Anonymous (isolated temp state, not visible Incognito)
"$REALBROWSER" tab ensure https://example.com --anonymous --session check --label page --background
"$REALBROWSER" read observe -t page --anonymous --session check

# Signed-in profile or existing Chrome
"$REALBROWSER" profile list --active
"$REALBROWSER" tab ensure <url> --profile chrome:Default --label app --background
"$REALBROWSER" read observe -t app --profile chrome:Default

# Default context for repeated work; owner scoping for parallel sessions
"$REALBROWSER" session use profile:chrome:Default
export REALBROWSER_OWNER=my-project   # parallel sessions
"$REALBROWSER" tab ensure <url> --label app --background
```

Visible Incognito only when the user asks for a visible Incognito window: add
`--incognito` (or `--private`) with `--front`.

**Pick by URL stability:**

- **Stable-URL sites** (search engines, wikis, code hosts, news, docs):
  deep-link FIRST. Verify with `read observe`; fall back to homepage UI on
  "404"/"Not Found"/"error"/"Pardon".
- **Stateful SPAs** (URL not source of truth — content hydrated from
  session/cookie state or form-driven): **homepage + UI FIRST.** Constructed
  deep-links frequently 404; the probe wastes 20-40s. Skip unless you have
  evidence (bookmark, prior-session success in this Chrome).

Stateful-SPA cold-start (canonical 5 cmds; typical 2-5 min, varies with bot
defenses):

```bash
"$REALBROWSER" tab ensure <homepage> --profile chrome:Default --label app --background
"$REALBROWSER" read tree -t app -i -c                    # find c<n> chips + HINT line
"$REALBROWSER" action click -t app c1                    # chip pre-fills form (if one matches)
"$REALBROWSER" action submit -t app --text "Search"      # exact visible label (localize as needed)
"$REALBROWSER" wait ready -t app --visual-stable --timeout 30000
```

No matching chip? Picker UI fallback in `references/workflows.md`.

**Don't add `--allow-browser-scope-target` reflexively.** Tabs created via
`tab ensure --profile` are profile-proven — later `-t app` works without it.
Only needed when claiming an existing user tab on a browser-scoped CDP
endpoint (rare).

Creation = `tab ensure`/`tab new`; navigation = `tab navigate <t> <url>`;
reads/actions require a target. `profile list` reports CDP scope (`profile`
= one profile, `browser` = inspect-only for existing tabs). `--background`
uses only background-safe paths. Running browser-scoped profiles are never
OS-launched in background; use `--front` for explicit visual handoff. Mutating
commands claim a target lease — don't navigate/click/close/focus/reload/download a leased target
without `--take-lease` or explicit handoff. Full/responsive/device/annotated
screenshots also require the lease.

## Tab Ownership And Task Registry

Each invocation has a *task*. Agent tabs tracked per-task, separate from
user tabs. `tab list --mine` shows only this task's tabs; `tab list` shows
everything with `mine` / `user` / `other-agent` column.

**Same task + same origin = same tab.** A second `tab ensure
<same-origin-url>` reuses the original; passing a new label aliases the old.
If the new label points elsewhere, realbrowser refuses with
`duplicate_task_origin` and lists recovery commands verbatim. **USE the
existing handle** — do not invent a new label. Mutating commands
(`tab navigate`, `tab close`) refuse user-owned tabs by default; opt in with
`tab select --take-lease` or `tab navigate --allow-user-tab-mutation`.

End of task: `tab done` marks complete, leaves open (safe default). Add
`--close` or use `tab close --mine` to close only agent tabs.

Failure modes the registry prevents: inventing `app2`/`app3` after a click
fails; closing one of the user's tabs thinking it was the agent's; losing
track of which tab is owned.

`background_create_unavailable` on `tab ensure --background`? Do not switch to
anonymous or another profile unless the user approves. Use an existing proven
tab, ask for `--front`, or ask for a one-shot profile relaunch if CDP is locked.

**User tab in conflicting state.** If `tab list <site>` shows a user tab
already on a page that doesn't match what the task needs (e.g. user is
mid-flow on a stateful SPA), don't `--take-lease` and don't probe with a
deep-link — for stateful SPAs the deep-link will 404 or 500. Open a
fresh agent tab via the homepage with `tab ensure <homepage> --force-new
--label <new> --profile <p> --background`. The new tab carries its own
session-scoped state from the same cookies, leaving the user's tab untouched.

## Operating Loop

1. **Classify scope:** existing tab, signed-in profile, anonymous, debug,
   read-only, or form/action.
2. **Inspect before creating:** `profile list --active`, `tab list <q>
   --profile`. Browser-scoped targets are diagnostic; create through the named
   profile with `tab ensure --background`.
3. **Acquire one stable target:** `tab select --label` (existing) or
   `tab ensure --label` (create). Multiple matches? Disambiguate by URL/title;
   never guess.
4. **One tree, many diffs.** `read tree -t <L> -i -c` once per page state;
   `read tree -i -c -D` after each action. Do not chain `read snapshot` /
   `read query` / `screenshot full` to find elements.
5. **Forms/uploads/submits:** `action state -t <L> --root active`. Add
   `--screenshot --annotate-refs` only when visual check prevents a wrong
   click. Submit with `action submit --text <label>` or `action submit
   <button-ref>` — once.
6. **Verify after action:** `read tree -i -c --diff` (~50 tokens) or
   `wait ready --visual-stable`. Screenshots only when verification is
   visual-only.
7. **Ephemeral UI** (dropdowns, tooltips, autocomplete, modals): the opening
   click invalidates prior refs. Re-read tree — never retry a failed
   click/fill with the same ref.
8. **"covered-by:..." / "not topmost":** the error names the cover. Recovery:
   `action press Escape` → `action scroll` → `wait ready --visual-stable`.
   Two identical "covered-by" errors = change strategy.
9. **After navigation:** any route swap invalidates refs. Re-read tree.
10. **End-of-turn cleanup.** Close tabs you created that aren't deliverable
    (created/edited doc, cart, dashboard the user asked to inspect) or
    handoff (waiting for login/approval/payment/CAPTCHA). Use `tab done
    --close` or `tab close --mine` — never touches user tabs.

For inspection-only work, preserve user state: avoid focus changes, restore
temporary filter/sort/tab changes before finishing. Never parallelize
target-changing commands with reads on the same target.

## Efficiency Rules

Hard rules, not suggestions. A typical read-only task should complete in
under 2 minutes and fewer than 10 commands. Concrete patterns for each rule
live in `references/workflows.md` (Efficiency Patterns).

- **Read before acting.** The tree is data — find the user's label in tree
  text, act on its ref. State attrs (`[disabled]`, `[modal]`, `value="..."`)
  change what action is correct. On failure: re-read, don't retry same ref.
- **`c<n>` non-ARIA refs.** React/Vue custom widgets (recent-search bubbles,
  calendar cells, chips) under `# cursor-clickables` — use like AX refs.
- **Refs scoped to most recent tree.** Each `read tree` resets refs. "Ref
  stale or unknown" = re-read tree.
- **If it's on disk, grep.** After `read text --out` / `read tree --out`,
  use `grep` / `sls` / `node -e` on the file. No more `read query
  --text-filter` round trips for the same content.
- **Don't sleep — wait for the page.** `wait ready --visual-stable`
  (default), `wait selector`, `wait text`, `wait url --contains`. Chained
  `sleep N` is dead time.
- **Pick the cheapest reader.** `read tree -i -c` to interact; `read text
  --out` for bulk; `read items` for feeds; `screenshot capture` only for
  visual decisions. See Reader Cost Reference in workflows.md.
- **One tree, many diffs.** `read tree -i -c` once per page state, `-D`
  after every action (2-10 lines of delta).
- **Refs first, CSS only when known.** A selector is a *guess* (banned) if
  you used `[class*="..."]`, modified a seen selector, or copied from
  another site. After one failed `read query`, switch to refs — no
  iterative selector hunting.
- **Data extraction: one read, never scroll+screenshot in a loop.**
  `read tree` / `read text` see the full DOM regardless of fold. Vision is
  5-20× more expensive per byte and misreads digits.
- **Screenshots: visual state only.** See Screenshot Decision Table in
  workflows.md. Never screenshot to read prices/dates/labels.
- **Dropdowns: type-first.** When click opens a search input, type
  immediately. For click-then-popup widgets, `read autocomplete --near
  <button-ref>`. For silent fill no-ops on custom widgets, pass
  `action fill <ref> "<v>" --require-change` to fail loudly.
- **After-submit: one wait.** `wait ready --visual-stable --timeout 30000`
  then `read tree --diff`. Don't stack sleeps; don't `tab focus --front`
  "to make it work" — background works fine.
- **One authoritative signal = answer.** Selected option, `[checked]`,
  success toast, cart line item, URL change — treat as proof unless
  another signal contradicts. Don't re-verify via alternate surfaces.
- **Command-count checkpoints.** At cmd 5: am I making real progress? At
  cmd 10: if not nearly complete, reassess fundamentally.
- **Talk to the user every 5+ tool calls.** One sentence prevents silent
  runs ending in `[Request interrupted by user]`.
- **Report partial success and stop.** Multi-part request and you have
  part A with confidence? Report A *now*. SPA results pages frequently
  lose state on back/forward/reload.
- **Stay on the user's site.** If the user named a site, don't substitute
  when you hit friction. After the failure budget, report the blocker.
- **Never truncate tree output.** `| head` / `| tail` discards elements.
  Use `--out FILE`, or scope at source with `--selector` / `--depth N` /
  `--limit N`.

**ABSOLUTE RULE:** Never guess CSS selectors. If you haven't seen the exact
selector verbatim in prior output, source you read, or `forms`, use refs.

**Failure budget:** Failure Recovery Matrix in `references/workflows.md`.
Three failed commands on the same interaction = wrong approach.

**Shell portability:** examples use POSIX (`grep`, `head`, `wc`). PowerShell
substitutes are in `references/workflows.md` (Shell Portability). `node -e
"<js>"` is the portable last resort — Node ships with the CLI runtime.

## Profile Approval And Daemon Reuse

`profile list --active` is passive — reads `DevToolsActivePort` without
opening a CDP socket. Reuse the existing WebSocket and its
per-browser-endpoint daemon. If Chrome shows an Allow-debugging prompt, wait
for the existing daemon (`daemon monitor --json`). For low-approval
clean-state work prefer anonymous; for signed-in state attach to the real
profile.

Don't probe multiple profiles in parallel on a browser-scoped WebSocket. Pick
one profile, run one target-acquisition. Once a label is created, `-t <L>`
infers context. If `profile list --active` returns nothing but `profile list`
shows running data, Chrome is on the approval prompt — retry after approve.
No WebSocket endpoint at all = `--best-effort-background` cannot attach.

**`profile relaunch --confirm` IS DESTRUCTIVE — quits Chrome and closes ALL
user tabs.** Never run without explicit one-shot user approval in the
current turn. Standing approval from a previous run does NOT carry forward.

If CDP attach fails (no `DevToolsActivePort`, port refused, "endpoint did not
become ready"): run `profile inspect <profile>`, then **stop and report**.
Quote the error, ask the user to approve the Chrome Allow dialog or relaunch.
Do NOT auto-relaunch — each relaunch loses user tabs without recovering CDP
when the underlying issue is approval policy. Run `profile relaunch
--confirm` only after the user types something like "go ahead, relaunch
Chrome" in the same turn — exactly once.

**Only mutate tabs you created.** `tab close`, `tab navigate`, lease-taking
clicks, full-screen screenshots scoped to labels/handles acquired via
`tab ensure --label <L>` or explicit `tab select`. Never close or navigate
the user's pre-existing tabs without their request.

**Never steal focus.** The skill operates strictly in background — opening
tabs, clicking, navigating, reading must NEVER bring Chrome to the front or
move keyboard focus from the user's current app.

- `tab ensure --background` is the default. Don't promote to `--front` for
  routine work.
- A click that "doesn't fire" in background is NOT a reason to focus the
  tab. Fix via CDP synthetic dispatch (`action click` auto-retries),
  `--bypass-overlay`, or `action submit --text <label>` — never
  `tab focus --front`.
- `tab focus --front` is NOT routine recovery. Even for bot challenges
  ("Pardon Our Interruption" / "Just a moment"), STOP and ask the user.
  Only proceed if the user explicitly approves in the same turn; restore
  prior app immediately after.
- Don't `osascript activate Google Chrome`/`activate Safari` — it always
  steals focus.

Use `--front` only for explicit visual handoff. `tab ensure --background`
already performs verified browserContextId discovery when possible.
`--best-effort-background` is only for stopped-profile launch risk and must not
OS-launch an already-running browser-scoped profile.

## Common Workflows

Minimal skeletons live in `references/workflows.md` (form/upload,
console/network, screenshots, drag/drop, PDF, anonymous, responsive, infinite
feeds, stateful-SPA recovery). Open it when the task needs detail.

## References

- `references/commands.md`: command tree, output, errors, JSON contract,
  POSIX↔PowerShell shell mapping.
- `references/workflows.md`: Reader Cost Reference, Screenshot Decision Table,
  Failure Recovery Matrix, Efficiency Patterns, profile/anonymous/feed/action/
  upload/network/screenshot/download/PDF workflows.
- `references/design-notes.md`: what was copied from chrome-cdp, gstack, and
  OpenClaw and the long-term daemon/API model.

## Safety Rules

- `--background` = safe CDP/background creation. `--front` only for explicit
  handoff or when hidden/unfocused interaction is impossible.
- Signed-in profile mutation requires a proven target label or handle.
- Browser-scoped CDP is not proof of existing-tab profile ownership. Prefer
  labels/handles; verify URL/title before actions.
- Uploads and final actions stay inside the active root. No global selectors
  for file upload or submit.
- Screenshots are target-bound visual evidence. Use early when visual state
  affects action safety, but do NOT replace scoped DOM/query readers with
  screenshot parsing on huge pages.
- Final actions enumerate button-like candidates inside the active root.
  Label submits are exact-match; prefer a button ref when controls share
  similar words. Click once, verify passively.
- Cookies/storage/headers redacted unless `--values` explicit.
- Large HTML, network bodies, HAR, console dumps, traces, screenshots, PDFs,
  downloads go to `--out` or artifact paths — never stdout.
