# Realbrowser Workflows

## Contents

- [Task Registry: One Tab Per Task Per Origin](#task-registry-one-tab-per-task-per-origin)
- [Existing Tab In A Profile](#existing-tab-in-a-profile)
- [Current State Versus Fresh Capture](#current-state-versus-fresh-capture)
- [Anonymous Browse](#anonymous-browse)
- [Repeated Content And Huge Pages](#repeated-content-and-huge-pages)
- [ARIA Tree](#aria-tree-primary-interaction-reader)
- [Scrolling](#scrolling)
- [Drag And Drop](#drag-and-drop)
- [Form, Upload, Submit](#form-upload-submit)
- [Console And Network](#console-and-network)
- [Screenshots, Download, PDF](#screenshots-download-pdf)
- [Failure Recovery Matrix](#failure-recovery-matrix)
- [Efficiency Patterns](#efficiency-patterns)
- [Shell Portability](#shell-portability-posix-vs-powershell)

## Task Registry: One Tab Per Task Per Origin

Each invocation has a *task* (derived from `REALBROWSER_TASK_ID`,
`REALBROWSER_OWNER`, or the per-shell owner). Per task and per origin, the
agent keeps at most one tab. This eliminates the "app2, app3, app4"
failure mode where a confused agent invents new labels after a click error
and ends up with several duplicate tabs on the same site.

The state surface for the agent's own work:

```bash
realbrowser tab list --mine --profile chrome:Default       # only this task's tabs
realbrowser tab list --profile chrome:Default              # everything, with mine/user/other-agent column
```

`tab ensure` is now origin-deduped:

```bash
realbrowser tab ensure https://www.example.com/ --label app --profile chrome:Default --background
# created app https://www.example.com/
# task-tab origin=https://www.example.com label=app target=A0637EC0 status=active

realbrowser tab ensure https://www.example.com/page --label app2 --profile chrome:Default --background
# reused app2 https://www.example.com/page    (same target, alias added)
# task-tab origin=https://www.example.com label=app2 target=A0637EC0 status=active

realbrowser tab ensure https://www.example.com/ --label different --profile chrome:Default --background
# WHEN label `different` already points elsewhere:
# ERROR duplicate_task_origin: already have an agent tab for origin https://www.example.com in this task under label app
# next:
#   realbrowser action state -t app --root active --compact
#   realbrowser tab navigate -t app https://www.example.com/
#   realbrowser tab ensure https://www.example.com/ --label different --force-new
```

**On `duplicate_task_origin`: do not invent a new label.** Read the error.
The `next:` lines tell you the exact recovery command verbatim. The most
common cause is "I just lost track of my own tab"; the fix is to USE the
existing handle, not to create more tabs.

To retry a navigation that returned an error page or after a 404, use
`tab navigate` on the existing handle — never `tab ensure` with a new label:

```bash
realbrowser tab navigate -t app https://www.example.com/path
```

`tab navigate` and `tab close` refuse user-owned tabs by default. To work on
a user tab, claim it first:

```bash
realbrowser tab select <prefix> --take-lease --label userpage --profile chrome:Default
realbrowser tab navigate -t userpage https://example.com
```

End-of-task cleanup options:

```bash
realbrowser tab done --profile chrome:Default               # mark complete, leave open
realbrowser tab done --close --profile chrome:Default       # mark complete and close mine
realbrowser tab close --mine --profile chrome:Default       # close all my task tabs
realbrowser tab close -t app --profile chrome:Default       # close one specific labeled tab
```

`--mine` and `tab done` only ever touch tabs the registry says belong to this
task. The user's tabs are never closed.

When `tab ensure --background` returns `background_create_unavailable`, keep
the user's requested profile. Do not switch to anonymous or another profile
unless the user approves. Use an existing proven tab, ask for `--front`, or ask
for one-shot `profile relaunch --confirm` if CDP is locked.

## Existing Tab In A Profile

```bash
realbrowser profile list --active
realbrowser tab list "app.example" --profile chrome:Default
realbrowser tab select "app.example" --profile chrome:Default --label app
realbrowser read observe -t app --profile chrome:Default
```

Use `tab list` first when the user asks to inspect a current/open tab. Use
`tab ensure` only when no usable tab exists.

If several tabs match, stop and disambiguate by URL, title, and a small
`read observe`; do not read console/network/content from several tabs and merge
the result. Follow-up instructions like "enter" or "select home" apply to the
currently selected/verified target unless the user changes scope.

If `profile list --active --json` reports `cdpScope: "browser"`, treat existing
tab ownership as unproven unless the tab was created by `realbrowser` through
that named profile. URL/title/content can disambiguate browser-wide debugging,
but it is not profile ownership proof. Creation is not silently promoted to OS
launch. `tab ensure/new --profile ... --background` uses background-safe paths
only. Use `--front` when the user explicitly accepts visible handoff.
`tab ensure --background` already performs verified browserContextId discovery
when possible. `--best-effort-background` allows stopped-profile launch risk,
but it must not OS-launch an already-running browser-scoped profile.

For named-profile opens, browser-scoped matches are not profile proof. If
`tab list "example.com" --profile chrome:Default` shows related tabs but none
was created by `realbrowser` through that profile, do not select a related tab
and navigate it. Create a new tab through the named profile:

```bash
realbrowser tab ensure https://example.com --profile chrome:Default --label app --background
```

Use `--browser-url` or `--allow-browser-scope-target` only for intentional
browser-wide debugging where cross-profile risk is acceptable.

Direct WebSocket endpoints from `DevToolsActivePort` are preferred over HTTP
`/json/version` discovery. `profile list --active` is passive: it must not open
CDP WebSockets or cause Chrome approval prompts. If it reports no DevTools
profiles while `profile list` or `profile inspect` shows `userDataInUse: true`,
the browser has no discoverable direct endpoint yet. Do not retry `tab ensure ...
--best-effort-background`; that flag can launch a stopped profile but cannot
attach to an existing non-debuggable Chrome process.

When the task depends on signed-in state and direct attach still fails, ask for
approval to relaunch instead of ending with a manual instruction:

```bash
realbrowser profile relaunch chrome:Default --confirm
realbrowser tab ensure https://example.com --profile chrome:Default --label app --background
```

`profile relaunch` quits the browser app for that user data directory, starts it
with remote debugging, and is a last-resort recovery that should only be run
after the user approves that disruption.

Default context can remove repeated flags after the profile choice is clear:

```bash
realbrowser session use profile:chrome:Default
realbrowser tab list "app.example"
realbrowser read observe -t app
realbrowser session clear
```

In multi-agent workflows, keep each project/session in its own owner namespace:

```bash
export REALBROWSER_OWNER=project-a
realbrowser session use profile:chrome:Default
realbrowser tab ensure http://localhost:3000 --profile chrome:Default --label app --background
```

Labels, default context, and target leases are owner-aware. If one session has
leased a tab, another session should create/select its own target instead of
mutating that tab. Use `--take-lease` only when the user intentionally wants the
second session to take over the target.

## Current State Versus Fresh Capture

Use the live signed-in tab/profile for inboxes, social sites, admin dashboards,
console logs, account pages, and any task that depends on cookies or the current
UI. Start with `profile list --active`, `tab list <query>`, and `tab select`.
If the user names a profile such as "Work" or provides a display-name hint,
resolve it through `profile list` / `profile inspect` instead of assuming
`chrome:Default`.

Use anonymous sessions for public-page screenshots, clean-state checks, and
responsive viewport captures unless the user explicitly asks for the current
logged-in browser. For viewport work on disposable targets, prefer `screenshot
device` because it captures and reports each output size in one command. On
signed-in/current profile tabs, use `screenshot capture`, `screenshot area`, or
`wait ready --screenshot` for progress checks; reserve `screenshot device` for
explicit responsive evidence because it temporarily applies CDP viewport
emulation. `action state --screenshot` and `wait ready --screenshot` are visible
checkpoints; `screenshot area/full` are explicit tall-artifact commands. Default
checkpoint artifacts are normalized JPEGs for agent use even when `--out` ends
in `.png`; the returned `screenshot.path` is authoritative and may change to
`.jpg`. Pass `--raw-size`, `--no-normalize`, or `--format png` when exact browser
pixels/PNG output are required. `screenshot device` uses DPR 1 by default for
exact CSS viewport PNGs. `screenshot full` uses document full-page capture when
the document scrolls, and stitches a dominant internal scroll container when an
app shell keeps the document fixed-height. Whole-page stitched captures preserve
visible UI above and below the scroll container, such as headers and reply
composers; `--selector <scroll-container>` captures only the selected panel.

For inspection-only tasks, preserve state. If you change filters, sort, scroll,
or selected panels to inspect something, restore them when practical and say so
in the result.

## Anonymous Browse

```bash
realbrowser tab ensure https://example.com --anonymous --session check --label page --background
realbrowser read observe -t page --anonymous --session check
realbrowser session stop check
```

Anonymous means isolated temporary browser state, not network anonymity and not
Chrome's visible Incognito UI. Use `--incognito` or `--private` only when the
visible browser must look like a real Chrome Incognito window:

```bash
realbrowser tab ensure https://example.com --anonymous --session private --label page --front --incognito
```

Do not use a shell-only command such as `open -na "Google Chrome" --args
--incognito ...` as the normal workflow: it may create a visible Incognito
window, but it loses `realbrowser` target labels, daemon reuse, screenshots,
console/network capture, and guarded actions.

## Repeated Content And Huge Pages

```bash
realbrowser read size -t group
realbrowser read items -t group --collection auto --direct-children --limit 8 --max-text-chars 700
realbrowser read item -t group --collection auto --direct-children --index 4 --max-text-chars 4000
realbrowser read query -t group 'article,[role=article],[role=listitem],li,tr,.card' --visible --fields ref,tag,text --limit 12 --json
realbrowser read snapshot -t group --selector '<small-container>' --urls --cursor-interactive --diff
```

Do not dump full HTML for huge feeds, inboxes, chats, tables, dashboards,
notifications, or search result pages. Use `read size` first; when the page is
large/huge, prefer `read item`, `read items`, or scoped `read query`.
Keep reusable workflows structural and site-neutral: collection roots,
landmarks, roles, list/table rows, links, buttons, form fields, refs, and
network entries. Use site-specific selectors only after a scoped read proves
they are needed for this one page, and keep them out of shared examples.

When exact order matters, verify the surface and order before reading the item:
current sort/filter, heading, top-level collection root, direct children, and
whether collapsed text needs expansion. Broad article selectors can include
comments, sidebars, and nested cards; use direct children or message blocks to
confirm top-level order. Reserve `read snapshot --selector` for small verified
containers or interaction refs, not as the default parser for a large root.

Expansion is explicit and selector-based. Use `read item --expand-selector <css>`
only after a scoped read shows a local expander inside the target item.

If the page offers a stable sort URL/filter that changes "most relevant" into a
chronological/current order, apply that early and verify the heading once before
spending tokens on deeper DOM exploration.

## ARIA Tree (Primary Interaction Reader)

`read tree` fetches Chrome's accessibility tree via CDP. It IS the "one big
read" agents reach for full HTML or full screenshot to get — the entire
interactive surface (buttons, links, inputs, tabs, dropdowns) with refs
attached, 5–20× more compact than DOM snapshots.

The canonical pattern:

```bash
realbrowser read tree -t app -i -c        # once per page state, ~300-2000 tokens
realbrowser action click -t app b3
realbrowser read tree -t app -i -c -D     # delta after action, ~0-200 tokens
realbrowser action fill -t app e1 "value"
realbrowser read tree -t app -i -c -D     # delta after action
```

Anti-patterns (strictly more expensive than `read tree`):

- **`read html` / full HTML to find elements:** modern SPAs ship 100k–1M tokens
  of HTML. `read html --out FILE` is for offline grep, not interaction.
- **`screenshot full` + vision to read content:** vision tokens are 5–20× more
  expensive per byte than text and misread small text. You still need refs to
  click — `read tree` returns them for free.
- **`read query` to find what `read tree` already showed:** the tree already
  enumerates every interactive element. `read query` is for a known CSS
  selector you've already seen verbatim.
- **Multiple readers on the same page state:** one `read tree` is the snapshot.
  Following with `read snapshot`, `read query`, or `read items` on unchanged
  state is duplication.
- **Re-reading the full tree after a small action:** use `-D` (diff). A click
  that opens a dropdown adds 5 lines; full re-reads pay for the whole tree.

Graduated reader hierarchy:
1. `read tree -i -c` — buttons, links, inputs, tabs with refs (primary)
2. `read tree -i -c -D` — verify after action, shows only changes
3. `read tree -i -c --selector main` — scope to a landmark
4. `read items`/`read item` — feeds, lists, repeated rows (when tree's flat list
   isn't enough)
5. `read query <css>` — only for a CSS selector you've already seen verbatim
6. `read snapshot --selector <css>` — DOM structure when ARIA tree is inadequate
7. `read text --out FILE` + file search (`grep`/`sls`) — bulk text extraction
8. `read html --out FILE` — offline HTML search (zero model tokens)

```bash
realbrowser read tree -t app -i -c
realbrowser read tree -t app --interactive --compact --depth 4
realbrowser read tree -t app --selector main -i -c
```

Composable short flags: `-i` (interactive only), `-c` (compact: skip unnamed
structural nodes), `-d N` (depth limit), `-D` (diff against previous snapshot).

After an action, use `--diff` to see only what changed:

```bash
realbrowser action click -t app b3
realbrowser read tree -t app -i -c -D
```

The diff output shows only added/removed lines, saving tokens on verify steps.
Use `read tree --diff` as the default verify-after-action step instead of
screenshots. Reserve screenshots for visual-only state (image previews, layout
shifts, canvas rendering).

Refs from `read tree` (`b1`, `l1`, `e1`) work with all action commands (`action
click`, `action fill`, `action type`, `action submit`, `action scroll`,
`action drag`).

For large pages, combine flags: `read tree -i -c -d 3 --selector main` gives
the interactive elements in the main landmark, limited to depth 3. This is
typically 20-50 lines instead of 200+ for a full DOM snapshot.

Boolean state checks are available via `read is`:

```bash
realbrowser read is visible e1 -t app
realbrowser read is enabled b3 -t app
realbrowser read is checked e5 -t app
```

Each returns bare `true` or `false` (2 tokens).

## Scrolling

```bash
realbrowser action scroll -t app down 500
realbrowser action scroll -t app up 300
realbrowser action scroll -t app --selector '[data-scroll-root]' down 800
realbrowser action scroll -t app e1 down 400
```

Scroll the window or a specific element. Directions: `up`, `down`, `left`,
`right`. Default: `down 500`. Use `--selector` or a ref to scroll a container
instead of the page window. Verify scroll position with `read tree --diff` after
scrolling.

## Drag And Drop

```bash
realbrowser action drag -t app b1 --to b2
realbrowser action drag -t app b1 --to-point 320,180
realbrowser action drag -t app --from-point 20,40 --to-point 300,40
realbrowser action drag -t app b1 --by 80,0 --steps 16 --duration 400
```

`action drag` performs a pointer drag and drops by releasing at the destination.
Use refs/selectors for structural targets and `--to-point` / `--from-point` for
canvas, dock, resize, or other coordinate-driven UI. Coordinates are viewport CSS
pixels, matching CDP screenshots. Keep drag workflows target-bound and generic:
read the tree or screenshot to identify the source, then drag by ref or explicit
point; do not bake app-specific selectors into shared flows.

## Form, Upload, Submit

```bash
realbrowser action state -t app --root active --compact
realbrowser action state -t app --root active --compact --screenshot --annotate-refs
realbrowser action fill -t app e1 "caption"
realbrowser action type -t app e1 "caption"
realbrowser action upload -t app --root active --input-ref e2 ~/Downloads/media.png
realbrowser wait ready -t app --visual-stable --screenshot --out tmp/upload-ready.png
realbrowser action submit -t app --root active --text "Submit"
realbrowser wait ready -t app --timeout 10000
```

Upload verification uses visible app state such as filename text, previews,
image/video dimensions, enabled final controls, and loading markers. Do not rely
on `input.files` after the app ingests the file.
Upload and submit fail when the active root cannot contain the chosen control;
do not switch to global selectors unless the task explicitly asks for page-wide
debugging and you pass `--root page`.

For final-action flows, first enumerate the active root and button-like
candidates, then fill/upload using refs from that root. Click the final control
once by exact text or by ref. Verify with passive state such as URL/title,
enabled/disabled state, preview/status text, network activity, or a scoped read;
do not double-click to test success.

Use `action state --screenshot --annotate-refs` when visual state changes the
decision: modal boundaries, file previews, covered controls, disabled buttons,
canvas/media, crop areas, or multiple visually similar final controls. It returns
the same refs plus a visible-root/viewport screenshot path, not the full scroll
height of a feed/root. The overlay marks the active root boundary and visible
refs; JSON exposes `screenshot.annotation` metadata. Inspect that image before
the next mutating action when the visual state affects which ref is safe;
otherwise the path alone is not evidence.

For uploads, never use standalone `action click` on visible media, attachment,
or file-picker controls. Use `action upload --input-ref <ref> <file>` when a
file input ref exists. Use `action upload --trigger-ref <ref> <file>` when the
page requires clicking a picker control to create/open the file input; this
follows OpenClaw's file-chooser hook pattern by arming the chooser before the
click and setting files through the browser protocol. Standalone click uses a
short CDP file-chooser guard and reports `file_dialog_would_open` instead of
letting the native picker block the desktop.

`fill` replaces values and works for normal inputs. `type <ref> <text>` focuses
the ref and sends native CDP text input, which is safer for rich
contenteditable/React editors that reject synthetic replacement. If an overlay,
picker, or menu owns the active root, press `Escape`, re-run `action state`, and
continue from the corrected root.

`submit --text` requires an exact accessible label/text match inside the active
root. When multiple controls contain similar words or the exact label is not
listed, submit by the enumerated button ref, for example `action submit -t app
b4`, rather than widening to global selectors.
Labels such as `Submit`, `Save`, `Send`, `Post`, `Next`, or localized strings
are page data, not workflow assumptions. A reusable flow should either read the
current root and pass the exact observed label, or select the enumerated ref.

## Console And Network

```bash
realbrowser tab list "<url-or-title-fragment>" --profile chrome:Default
realbrowser tab select "<exact-match>" --profile chrome:Default --label app
realbrowser console list -t app --errors --limit 80
realbrowser console capture -t app --clear --reload --duration 3000 --out tmp/console.json
realbrowser network capture -t app --reload --duration 5000 --out tmp/network.json
realbrowser network capture -t app --include-body --out tmp/network-with-bodies.json
realbrowser network list -t app --filter "/api/" --json
realbrowser network get -t app req_12 --out tmp/req_12.json
realbrowser network body -t app req_12 --response --out tmp/req_12-response.json --full
realbrowser network export -t app --format har --out tmp/app.har
realbrowser perf trace -t app start
realbrowser perf trace -t app stop --out tmp/trace.json
realbrowser state headers set -t app --header "X-Debug: 1"
realbrowser state clipboard read -t app --values
```

For "check console log" or "copy console output", the deliverable is the exact
tab's DevTools Console lines. Select one tab, verify it, and paste the lines
back verbatim. If `console list` is empty but startup logs are expected, arm
`console capture --reload`; old buffers may not replay. Do not broaden into a
general browser summary.

No repeated approval prompts: use the selected target through the existing
`DevToolsActivePort` WebSocket and `realbrowser` daemon. If multiple Chrome
profiles report the same browser-scoped WebSocket, choose the intended profile
and avoid parallel profile probes; the daemon is shared per browser endpoint.
After `tab ensure --label app`, later `-t app` commands can infer the label's
context instead of falling back to a separate endpoint daemon. If Chrome is waiting
for Allow debugging, wait on that starting daemon and retry the same command;
do not spawn another controller. Do not switch to other Chrome DevTools MCP
controllers or foreground Chrome just to read logs. If a profile lacks a direct
WebSocket endpoint, use the profile recovery hint instead of opening extra
controllers.

After Chrome or the computer restarts, a real signed-in Chrome profile may still
show Chrome's debugging approval once. The durable optimization is daemon/endpoint
reuse while the browser lives; anonymous managed sessions avoid signed-in-profile
approval but do not contain the user's logged-in state.

Capture network before reload/action when response bodies matter.

Use `daemon monitor --json` when debugging CDP health, stale daemons, or buffer
growth. Use `network export --out` or `network body --out --full` when the
response is too large for stdout and should be inspected with the search tool
your shell provides (`grep`/`jq`/`rg` on POSIX shells, `Select-String` /
`ConvertFrom-Json` on PowerShell, or `node -e` anywhere) or an editor.

Use `network capture --include-body --out tmp/network.json` only for explicit
debug sessions; body capture requires `--out` unless `--force` is explicit.
Otherwise keep body reads targeted with `network body`.

For large read/debug surfaces, use `--out` instead of stdout:

```bash
realbrowser read size -t app --out tmp/page-size.json
realbrowser read query -t app "button,input,a" --limit 100 --out tmp/controls.json
realbrowser read snapshot -t app --selector main --out tmp/main-snapshot.txt
realbrowser read text -t app --max-chars 50000 --out tmp/page-text.txt
```

## Screenshots, Download, PDF

```bash
realbrowser screenshot capture -t app tmp/app.png
realbrowser screenshot capture -t app tmp/app.jpg --max-side 1600 --max-bytes 2mb
realbrowser screenshot capture -t app --raw-size tmp/app.png
realbrowser screenshot capture -t app --selector '[role=dialog]' tmp/dialog.png --annotate-refs
realbrowser screenshot full -t app tmp/app-full.png
realbrowser screenshot full -t app --selector '[data-scroll-root]' tmp/panel-full.png
realbrowser screenshot area -t app b2 tmp/button.png --annotate-refs
realbrowser screenshot area -t app --selector main tmp/app-main.png
realbrowser screenshot device -t page --anonymous --session responsive --devices desktop:1440x900,tablet:768x1024,mobile:390x844 --visual-stable --settle-ms 300 tmp/page
realbrowser download click -t app e7 --out ~/Downloads/export.csv
realbrowser export pdf -t app ~/Downloads/page.pdf --print-background
```

Do not run a reload/capture command in parallel with screenshot/PDF/export on
the same target.

For exact viewport evidence, use `screenshot device`; it sets each viewport,
waits/settles when requested, clears viewport emulation afterward, saves PNGs,
and reports path, dimensions, viewport, and expected dimensions in JSON. The
output dimensions match the requested CSS viewport by default; use raw CDP/dev
tools paths only when physical DPR pixels are explicitly wanted. Inspect saved
images with `view_image` when the visual result matters. Avoid it as a routine
checkpoint on a live signed-in tab; use visible checkpoint screenshots for
progress and `screenshot area/full` only when the large artifact is the
requested output.

## Portable Batch

```bash
realbrowser chain -t app --from flow.json --return summary
realbrowser chain -t app --from - --return summary < flow.json
realbrowser chain --profile chrome:Default --foreach groups.json --var group --set media=~/Downloads/post.png --from flow.json
```

`chain` avoids Bash-only loops and PowerShell quoting differences. Steps are
normal CLI token arrays, and `$group.url`, `$group.label`, `$media`, and
`$index` are substituted per iteration. `chain` runs inside one browser
context, so put `--profile`, `--anonymous --session`, or `--browser-url` on the
chain command rather than switching profiles inside individual steps.

## Stable-URL vs Stateful-SPA Entry Points

Two entry-point classes — pick by URL stability, not by site domain.

- **Stable-URL sites**: search engines, wikis, code hosts, news, docs,
  blogs, static product pages. Deep-link FIRST.
- **Stateful SPAs**: sites where URL is not the source of truth — content
  is hydrated from session/cookie state, server-rendered after auth, or
  driven by a form. Homepage + UI FIRST.

### Deep-link probe (stable-URL sites only)

```bash
"$REALBROWSER" tab ensure "https://<site>/<path>?<your-query-params>" \
  --profile chrome:Default --label search --background
"$REALBROWSER" wait ready -t search --visual-stable --timeout 8000
"$REALBROWSER" read observe -t search   # if title looks wrong, abandon to UI immediately
"$REALBROWSER" read text -t search --selector main --out tmp/results.txt
grep -nE "<your-pattern>" tmp/results.txt | head -30
```

URL-shape candidates come from prior observation — a sample form
submission (most sites preserve `?key=value` params in the result URL),
the site's docs, or the site's public API. Do not invent param names.

### Stateful-form UI flow (canonical shape)

This pattern works for any form-driven site: search/results pages,
filtered listings, multi-step checkout flows, internal dashboards with
filters, configurators, registration forms. The mechanics are the same —
pick form triggers, set values, submit, read results.

1. `tab ensure <homepage> --profile <p> --label <L> --background`
2. `read tree -t <L> -i -c` — list every input, dropdown, and primary
   action button. Look for a `# cursor-clickables` section listing
   `c<n>` refs for non-ARIA widgets (recent-action chips, custom day
   cells, custom range sliders).
3. **Recent-action chip:** if the homepage shows a `c<n>` chip matching
   the user's request (a saved/recent search, a quick-link tile, a
   "frequently visited" entry), one click often pre-fills the entire
   form. Click it before tapping individual triggers.
4. Otherwise, set each form value:
   - For ARIA dropdowns: `action click <button-ref>` to open, then
     `action click <option-ref>` from the freshly-re-read tree.
   - For portal-rendered popovers (the layer is in a different DOM
     subtree): `read autocomplete -t <L> --near <button-ref>` enumerates
     items as `o1, o2, ...` refs. Then `action click <o-ref>`.
   - For text inputs: `action fill <ref> "<value>"`. Add
     `--require-change` when you suspect a custom widget that may silently
     reject programmatic fill.
   - For custom widgets without ARIA roles (date cells, color pickers,
     custom range UI): use the `c<n>` non-ARIA refs from the tree, or a
     verified CSS selector seen in prior output.
5. Submit by exact visible label `action submit -t <L> --text "<button-label>"`
   or by ref. If the click reports `covered-by:<sel>`, retry once with
   `--bypass-overlay`.
6. `wait ready -t <L> --visual-stable --timeout 30000`. If a bot/anti-bot
   challenge page replaces the result (typical signals: page title or h1
   contains words like "interruption", "verify", "moment", "checking",
   "captcha", or shows a Cloudflare/PerimeterX/Datadome banner), STOP and
   ask the user before promoting the tab to foreground.
7. `read text -t <L> --selector main --out tmp/results.txt` then grep for
   the pattern that matches the data shape you need.

If the form fills and submits but the result page fails (challenge,
redirect, session expired), report what you have from the form view
(values entered, any data already visible) — don't loop.

### Multi-step results: advance via the visible forward control

Some sites split the result across multiple panels and require a forward
click between panels (e.g. "step 1 of 3"). One `read tree -i -c` per panel,
advance by ref, verify with `read tree --diff`.

When advancing requires picking a placeholder option to unlock the next
step, **pick the first/most-suitable by ref and move on**. Selecting an
option in a results or comparison page is read-only intent — the
commit/buy/submit step is the final confirmation screen.

1. First panel visible. If the panel requires picking an option (radio,
   tile, dropdown) before "next" is enabled, click the option you want
   (or the first/cheapest if the user didn't specify).
2. Click the forward control. Match the visible label on the page —
   "Continue", "Next", "Confirm", "Proceed", or the localized equivalent
   the site happens to show. Do not hardcode label assumptions across
   sites.
3. If a non-committing modal appears between panels (recommendation,
   upsell, "are you sure"), dismiss via a clearly-non-committing visible
   label ("Skip", "No thanks", "Close", "Maybe later", or the localized
   equivalent shown). Re-read tree.
4. Repeat until the panel you need is visible. STOP before any panel
   that requires payment, irreversible commit, or PII submission unless
   the user explicitly asked for that.

### Virtualized result lists

Long result lists are often virtualized (only ~6-10 rows in DOM at a
time). If the page advertises "Showing N items" but `read text` returns
only the first batch:

```bash
"$REALBROWSER" action scroll -t <L> down 2000
"$REALBROWSER" action scroll -t <L> down 2000
"$REALBROWSER" read text -t <L> --selector main --out tmp/all.txt
```

Without scroll, items rendered last (often the cheapest, the newest, or
otherwise sort-last) are invisible. Cap at 3 scrolls — if results are
still incomplete after that, report what you have.

## Reader Cost Reference

Typical input tokens per reader on a generic web page. Pick the cheapest reader
that returns refs (or text, when refs are not needed).

| Reader | Tokens | Refs? | Use when |
|---|---|---|---|
| `read tree -i -c` | 300–2,000 | yes | **Default for interaction** |
| `read tree -i -c -D` | 0–200 | yes (delta) | **Verify after action** |
| `read tree -i -c --selector main` | 100–500 | yes | Scope to a landmark |
| `read text --out FILE` then `grep`/`sls` | ~0 (file) | no | Bulk text extraction |
| `read items / read item` | 200–2,000 | yes | Feeds, lists, repeated rows |
| `read query <css>` | 50–500 | yes | One known CSS selector |
| `read snapshot --selector <css>` | 5,000–50,000 | yes | Tree inadequate (rare) |
| `read html --out FILE` | ~0 (file) | no | Offline HTML grep only |
| `screenshot capture` | ~600 image tokens | no | Visual state decision |
| `screenshot full` then vision | 2,000–4,000 image tokens | no | **Never for parsing** |

`screenshot full` followed by vision parsing is 10–1000× more expensive than
`read tree -i -c` and still produces no refs to act on. Use it only for
visual-state decisions (modal opened, image rendered).

## Screenshot Decision Table

Screenshots are for visual-only decisions. Reading text from screenshots is
banned — vision tokens are 5-20× more expensive per byte and misread small
digits.

| Goal | Tool |
|---|---|
| "What does the whole long page look like?" | `screenshot full` (one shot) |
| "Did the modal open?" / "Is the spinner gone?" | `screenshot capture` (viewport) |
| "What items / values are listed?" | `read text --selector main --out` + grep |
| "What buttons exist on the long form?" | `read tree -i -c --out` + grep |
| "Did my click change the DOM?" | `read tree -i -c --diff` (~50 tokens, no screenshot) |

**Anti-patterns:**
- `screenshot capture` after every click "to confirm it worked" — `read tree
  --diff` is 12× cheaper and tells you exactly what changed.
- `screenshot capture` + scroll + `screenshot capture` + scroll loop —
  one `screenshot full` is cheaper and not fragmented.
- Vision to read prices/dates/labels — use `read text --out` + grep.

## Failure Recovery Matrix

| Failure type | Max attempts | Then |
|---|---|---|
| Ref stale/covered/not topmost | 1 | Re-read tree for fresh refs |
| Click error contains `covered-by:<sel>` | 1 | `action scroll down 400` then retry; if still covered, retry with `action click <ref> --bypass-overlay` (dispatches events directly, ignores hit-test) |
| `action fill` reports `accepted: false` or silent no-op (custom widget, masked input) | 1 | Re-fill with `--require-change` to fail loudly; if it errors, switch to the widget UI (open popover/dropdown, click an option) |
| Dropdown item not in tree | 1 | `read autocomplete -t <label>` then `action click <o-ref>` |
| Dropdown item not clickable | 1 | Type into search input instead |
| CSS selector guess (not from prior output) | 0 | Use refs — never guess selectors |
| CSS selector from prior output, not found | 1 | Fall back to `read tree -i -c` + refs |
| `tab navigate` shows `WARN: page title looks like an error page` | 1 | URL is wrong — go back / use UI path. Don't retry the same URL. |
| URL navigation 404 | 1 | Go back, use the UI path |
| Any single interaction | 3 total | Stop. Switch strategy entirely. |

Three failed commands on the same interaction = wrong approach. Escalate in
this order — all within the user's specified site:

1. `read tree -t <target> -i -c` — fresh view, refs reset
2. `action press Escape` then re-read tree — close blocking overlay/modal
3. `action scroll` to bring the target into view, then re-read tree
4. Keyboard navigation: `action press Tab`, then `action press Enter`
5. A different UI path to the same goal **on the same site** (homepage menu
   instead of a homepage hero button)
6. `network list --filter "/api/"` — check if the data is available via XHR
   you can read without further interaction
7. Direct URL navigation **on the same site** if the site supports deep links

If all seven fail, stop and report the blocker. Do not silently switch to a
different site or service.

## Efficiency Patterns

Concrete examples backing the efficiency rules in `SKILL.md`. Read these
once per session and apply the rule shape, not the literal commands.

### Read before acting — interpret the tree

`read tree -i -c` returns the interactive surface as text. Interpret it the
way a user would — match the user's request to what's on the page, *before*
clicking.

1. **Find what the user named.** Search the tree text for the exact label
   ("Sign in", "Submit", "Buy now") and use the matching ref. Don't click
   the first interactive element by reflex.
2. **Read state attributes.** `[disabled]` means precondition missing;
   `[expanded=false]` means children may not be reachable; `[modal]` means
   only that dialog's controls are valid; `[required]`, `[checked]`,
   `[focused]`, `value="..."` all change what action is correct.
3. **Disambiguate by ancestor.** Two buttons share a name? One in a
   `dialog`, one in `main` — pick the one in the right context.
4. **Recognize blocking state.** Modal/`alertdialog` covers the page;
   `aria-busy` or zero interactives means mid-load — `wait ready
   --visual-stable` first.
5. **Plan the whole flow from one tree.** A form usually shows every input
   + submit in one read. Plan all the fills, then act.
6. **On failure: re-read, don't retry.** "Not topmost", "covered", "ref
   stale" mean the page changed since the tree was captured. `read tree
   -i -c -D` shows what's different.

### If it's on disk, grep — don't ask the browser again

Once any reader writes content to disk via `--out`, the next search MUST be
on the file. After `read tree --out FILE` / `read text --out FILE`, run
`grep -nE 'pat' FILE` (POSIX) or `sls -Pattern 'pat' FILE` (PowerShell)
instead of another `read query --text-filter`.

**Banned anti-pattern:** capture to disk → 3+ `read query --text-filter`
calls hunting for a label that's in the file. After the first failed
`read query` on captured content, switch to file search.

### Data extraction — one read, never scroll+screenshot in a loop

```bash
# BAD: 13 commands, ~10 minutes — scroll-and-screenshot loop
screenshot capture -> scroll -> screenshot -> scroll -> screenshot -> ...

# GOOD: 2 commands, ~3 seconds — one bulk text capture, then local search
"$REALBROWSER" read text -t app --selector main --out tmp/results.txt
grep -nE "<your-pattern>" tmp/results.txt   # POSIX
sls -Pattern "<your-pattern>" tmp/results.txt  # PowerShell
```

One `read tree -i -c` captures ALL interactive elements regardless of fold
position (CDP reads the full DOM, not just the rendered viewport). Use
`--out` for pages with 50+ elements.

### After-submit — one wait, no stacked sleeps

```bash
"$REALBROWSER" action click <submit-ref>
"$REALBROWSER" wait ready -t app --visual-stable --timeout 30000
"$REALBROWSER" read tree -t app -i -c --diff   # verify new state
```

`wait ready --visual-stable` already waits for network + DOM stability. Do
not chain `sleep N`, and do not chain `tab focus --front` "to make the page
work" (background works fine).

### One authoritative signal = answer

When the page exposes one authoritative signal for the fact you need —
selected option, `[checked]` state, success modal/toast, line item in
cart, URL parameter, value attribute on an input — treat that as the
answer unless another signal directly contradicts it. Don't re-verify
through header badges or alternate surfaces.

### Dropdowns, pickers, autocomplete — type-first

When a click opens a dropdown with a search input, type immediately — the
input is usually auto-focused: `action type "search text"`.

If items don't show in `read tree` (custom autocomplete without
`role=listbox/option`), run `read autocomplete -t <label>` — enumerates
the floating layer as `o1, o2, …` refs.

**Anchor with `--near <ref>` for click-then-popup widgets** — when the
dropdown opens after clicking a button (not typing into an input), pass
`read autocomplete -t <label> --near <button-ref>`. Without `--near`, the
reader uses `document.activeElement`, which lies for custom popovers.

If `read autocomplete` returns `(no eligible layer near anchor)`, the
dropdown likely closed — re-click the field, retry with `--near`.

**Silent fill no-ops on custom widgets.** Custom date inputs, masked
inputs, and React/Vue controlled components often accept `el.value = "..."`
programmatically but render the placeholder back. Pass
`action fill <ref> "<value>" --require-change` to fail loudly when the
visible value didn't change. Then pivot to the widget's own UI (open the
popover, click an option).

### Command-count checkpoints

At command 5: "Am I making real progress?" If more than 1 command did
not advance toward the goal, you're in a loop. Re-read tree, use refs.

At command 10: if not nearly complete, you have taken a wrong approach.
Do not continue — reassess fundamentally.

### Refs first — CSS only when known

After `read tree -i -c`, every interactive element has a ref (`b1`, `l1`,
`e1`). Use refs: `action click b3`, `action fill e2 "value"`,
`action type e1 "text"`.

CSS selectors are allowed only when *known* — verbatim from prior output,
app source you read, or a standard landmark (`main`, `nav`,
`[role="dialog"]`).

A selector is a *guess* (banned) if you used `[class*="..."]`, modified a
seen selector (`.results-list` → `.results-item`), or copied from another
site. The test: "Where did I see this selector?" — if you can't point to a
prior output line, it's a guess.

**Banned: iterative selector hunting.** After the first failed CSS result,
switch to refs. Do not run a second `read query` with a different selector.

### Lazy-loaded content (infinite scroll, virtualized lists)

Most sites are NOT virtualized — try one tree read first. When the tree
shows 5 results but the page advertises 30, or `read text` contains
"Showing 1-5 of 30":

- Issue 2-3 progressively-deeper scrolls (`action scroll down 2000`),
  re-reading text or tree once after the last scroll — not after each.
- Or, if the URL supports `?page=N` / `?limit=100`, prefer `tab navigate`
  to a deeper page over scroll.
- Cap at 3 scrolls. If results still incomplete, report what you have.

### Talk to the user every 5+ tool calls

If you've made 5 or more tool calls without emitting any text to the user,
emit a one-sentence progress note. Silent runs ending in
`[Request interrupted by user]` are failure modes the user pays for in
real time.

### Report partial success and stop

When the user asks for multi-part data and you have already captured at
least one part with confidence, **report what you have first**. Don't
navigate away from a working results page to re-fetch the rest. SPA
results pages frequently lose state on back/forward, direct nav, or full
reload. A 6-minute happy path becomes a 12-minute timeout when you abandon
a captured result to chase the next one.

### Multi-step flows and stateful forms

Any wizard, checkout, or **results page that shows one step at a time** is
a multi-step flow. One `read tree -i -c` per page state, advance by the
correct ref, verify with `read tree --diff` or `read observe`.

When advancing requires picking a placeholder option (default, shipping,
"any" choice) to unlock the next step, pick the first/most-suitable by
ref and move on. Don't bail mid-flow; bail at the final commit.

If a non-essential modal appears between steps (upsell, recommendation,
"are you sure"), dismiss it via the visible non-committing label
("Skip", "No thanks", "Close", "Maybe later", or the localized equivalent).
Re-read tree.

### Never truncate tree output

Truncating with `| head` / `| tail` (POSIX) or `| Select-Object -First` /
`gc -Head` (PowerShell) discards elements you need. If the output is too
large for context, use `--out tmp/tree.txt` and read the file, or scope at
the source with `--selector` / `--depth N` / `--limit N`.

## Shell Portability (POSIX vs PowerShell)

Examples elsewhere use POSIX shell syntax (`grep`, `sleep`, `head`, `wc`)
which works on macOS, Linux, WSL, and Git Bash on Windows. Native Windows
PowerShell substitutes:

| POSIX | PowerShell | Notes |
|---|---|---|
| `grep -E "x" FILE` | `sls -Pattern "x" FILE` | `sls` = `Select-String` |
| `grep -c "x" FILE` | `(sls "x" FILE).Count` | count matches |
| `head -50 FILE` | `gc FILE -Head 50` | `gc` = `Get-Content` |
| `wc -l FILE` | `(gc FILE).Count` | line count |
| `sleep 1` | `Start-Sleep 1` | (but prefer `wait ready`) |
| `cat FILE` | `gc FILE` |  |
| `rg "x" FILE` | `sls -Pattern "x" FILE` | ripgrep is third-party |
| `jq '.x' FILE.json` | `gc FILE.json \| ConvertFrom-Json \| % x` | jq is third-party |

`node -e "<js>"` is a portable last resort — Node is required to run
`realbrowser`, so it's available wherever the CLI runs. Use it for one-off
parsing that exceeds shell ergonomics on any platform.
