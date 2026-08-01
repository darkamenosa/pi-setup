# Realbrowser Command Reference

Command shape:

```text
realbrowser [global flags] <group> <command> [args] [flags]
```

Global flags:

```text
-t, --target <label|targetId|prefix>   Target for reads/actions
--handle <name|path>                   Saved target handle
--context <id>                         profile:..., anonymous:..., session:..., endpoint:...
--owner <id>                           Scope labels/defaults/leases to a Codex run or project
--global                               Use the shared global owner namespace intentionally
-p, --profile <profile>                Browser profile, e.g. chrome:Default
--anonymous --session <name>           Isolated managed browser context
--browser-url <url>                    Explicit CDP endpoint
--json                                 One JSON value on stdout
--out, -o <path>                       Write large output/artifact
--values                               Include normally redacted values
--background                           Safe no-focus creation only
--best-effort-background               Allow stopped-profile launch focus risk
--front                                Explicit foreground handoff
--incognito, --private                 Visual Chrome Incognito UI for anonymous sessions
--allow-browser-scope-target           Explicit opt-in to cross-profile target risk
--take-lease                           Intentionally take a target leased by another owner
--confirm                              Explicit approval for disruptive commands
--force                                Guarded opt-in for risky operations
--timeout <ms>                         Operation timeout
```

Groups:

```text
profile     list/inspect/relaunch
session     list/use/clear/stop
daemon      status/doctor/monitor/restart/stop
tab         list/select/ensure/new/navigate/label/focus/close/handoff/resume
handle      create/list/release
read        observe/size/snapshot/query/query-selector/items/item/text/html/links/forms/url/is
wait        ready/selector/text/url/load/network
action      state/root/click/fill/type/press/key/upload/submit/hover/select/drag
screenshot  capture/full/area/device/responsive
console     list/get/clear/capture
network     list/get/body/export/clear/capture
state       cookies/storage/cache/headers/permissions/clipboard/emulate
dialog      list/arm/accept/dismiss
perf        timing/vitals/trace
download    click/wait
export      pdf
devtools    list/raw
chain       run target-bound JSON steps
completion  bash/zsh/fish/powershell
```

Profile scope:

- `profile list --active` includes `profile` or `browser` in text output and
  `cdpScope` in JSON. Direct WebSocket endpoints from `DevToolsActivePort` are
  preferred over HTTP `/json/version`; stale port files are probed and ignored.
  This command is passive and must not open CDP WebSockets or trigger Chrome's
  Allow debugging prompt.
- The `PROFILE_ID` column is the selector to pass to `--profile`, for example
  `chrome:Default`.
- `profile` scope means the endpoint was discovered inside that profile
  directory.
- `browser` scope means the root browser endpoint is available. It is valid for
  browser-wide debugging, but it cannot by itself prove which profile owns an
  already-open tab.
- With `--profile ...` and `cdpScope: "browser"`, `tab list` is diagnostic:
  returned targets are marked as unproven unless they were created by
  `realbrowser` through that named profile. `tab select`, `tab navigate`, reads,
  and actions reject unproven targets by default. Use `tab ensure/new` through
  the named profile when the task asks to open that profile; use
  `--allow-browser-scope-target` or `--browser-url` only for intentional
  browser-wide debugging.
- For `tab ensure/new --profile ...`, browser-scoped CDP can inspect explicit
  targets but cannot by itself prove profile-specific background creation. The
  command reuses only proven profile-owned labels/URLs. If no proven target
  exists, it uses verified background probes or fails with recovery hints.
- `--front` is the explicit foreground handoff. `--best-effort-background`
  allows stopped-profile launch risk, but it must not OS-launch an
  already-running browser-scoped profile.
- If the profile is already running without a direct WebSocket endpoint, creation
  fails fast with an approval/recovery hint instead of trying to control the
  wrong browser.
- `--best-effort-background` can launch a stopped profile with accepted focus
  risk. It cannot retrofit DevTools onto an already-running non-debuggable
  browser process or force an already-running browser-scoped profile to open in
  the background.
- `profile relaunch <profile> --confirm` is the last-resort approval-gated
  recovery for signed-in tasks blocked by a locked non-debuggable profile. It
  quits the browser app for that user data directory, then starts it with remote
  debugging enabled.

Exit codes:

```text
0 success
1 runtime failure
2 usage/validation failure
3 target not found, ambiguous, or stale
4 context/profile cannot be proven safe
5 action preflight/final guard failure, target lease conflict, raw mutation guard, or browser-wide state guard
6 local state lock timeout
```

JSON rules:

- Success writes exactly one JSON object to stdout with `--json`.
- Errors write one JSON object to stderr with `error.code`, `error.message`,
  and `next`.
- Large debug data should use `--out`; stdout returns path plus metadata.
- `read observe/size/query/items/item/snapshot/text/links/forms/url/is` honor
  `--out`. Text-like reads write plain text; structured reads write JSON so
  `jq`, `rg`, and editors can inspect them without spending model tokens.

Important command semantics:

- `tab ensure <url> --label L` reuses a live label or exact URL before creating;
  in browser-scoped profile contexts, reuse is limited to tabs proven to have
  been created through that named profile.
- Labels, default context, and element refs are scoped by owner. Use
  `--owner <id>` or `REALBROWSER_OWNER=<id>` when several Codex sessions are open
  and should not share labels such as `app` or overwrite each other's `b1`/`e1`
  action refs.
- Mutating commands claim/check a target lease. If a target is leased by another
  owner, navigation, focus, close, actions, reload captures, state changes,
  viewport/full screenshots, annotated screenshots/checkpoints, downloads, trace
  control, dialog arming, and mutating raw CDP calls fail until the caller
  intentionally uses `--take-lease` or `--force`. Leases age out after
  `REALBROWSER_LEASE_STALE_MS` milliseconds, defaulting to seven days.
  `tab ensure` skips another owner's URL match and creates a fresh tab instead
  of reusing that tab.
- `--anonymous` means isolated temporary browser state. Add `--incognito` or
  `--private` only when a managed anonymous session should open as Chrome's
  visible Incognito UI. Incognito/private mode is not supported with signed-in
  profiles or arbitrary CDP endpoints because it would blur target provenance.
- `tab new <url>` always creates a new tab and refuses label replacement unless
  `--force`.
- `tab navigate <target> <url>` never navigates an implicit selected tab.
- `tab navigate <target> <link-ref>` can navigate `l1` refs emitted by
  `read snapshot --urls`.
- `read size` measures HTML/text/node counts and recommends a reader.
- `read tree` fetches Chrome's ARIA accessibility tree via CDP. Composable
  flags: `--interactive`/`-i` (interactive roles only), `--compact`/`-c` (skip
  unnamed structural nodes), `--depth N`/`-d N` (limit tree depth),
  `--diff`/`-D` (show only changes since last snapshot), `--selector` (scope to
  CSS subtree). Refs (`b1`, `l1`, `e1`) bridge back to DOM for clicks/actions.
  Output is 5-20x more compact than `read snapshot` for typical pages.
- `read query` returns refs such as `l1`, `b1`, `f1`, and `e1`; filters such as
  `--visible`, `--enabled`, `--topmost`, `--href-filter`, `--text-filter`, and
  `--fields` keep output small.
- `read query` expects CSS selectors, not literal text. For literal text checks,
  use `wait text`, `read text --out` with `rg`, or a small CSS selector plus
  `--text-filter`.
- `read snapshot --selector <css> --urls --cursor-interactive --diff` returns
  scoped DOM/role refs plus bounded link refs.
- `read item --index N` returns only one top-level collection item. Use
  `--expand-selector <css>` only when a scoped read has identified a local
  expander inside that item.
- `action state --root active` returns active-root refs, controls, and
  button-like final candidates that are currently visible, enabled,
  pointer-enabled, in the viewport, and topmost. Controls outside that safe set
  remain in `controls` for diagnosis instead of being promoted as final
  candidates.
- `action state --root active --screenshot --annotate-refs` returns the same refs
  plus a target-bound visible checkpoint path/dimensions; annotations draw
  the active root plus current visible refs on the captured visual surface
  without taking the full scroll height of a feed/root. JSON reports
  `screenshot.annotation.count`, `.skipped`, and `.rootIncluded`; use
  `--max-labels <n>` to bound overlay density. Checkpoint `--screenshot` output
  uses the normalized screenshot pipeline by default; if `--out tmp/state.png`
  is passed, the returned path may be `tmp/state.jpg`. Use `--raw-size`,
  `--no-normalize`, or `--format png` for exact PNG pixels.
- `action upload --root active <file>` chooses a file input inside the active
  root; use `--input-ref <ref>` when the root exposes multiple file inputs.
  If the file input appears only after a visible upload control is clicked, use
  `action upload --trigger-ref <ref> <file>` so the file chooser is armed and
  intercepted before the click. Plain `action click` blocks actual file
  inputs/labels and protocol-detected file chooser openings unless
  `--allow-file-dialog` is explicit.
- `action submit --root active --text <label>` clicks one guarded final control
  whose accessible label/text exactly matches `<label>`. It does not scroll
  arbitrary matching controls into view before the safety check; if the intended
  final control is outside the visible root/viewport, bring the root to the
  correct state, re-run `action state`, then submit by exact label or ref.
- `action submit <button-ref>` clicks a specific enumerated final control inside
  the active root.
- `network capture --reload` defines a capture window and clears the target
  network buffer first.
- `network capture --include-body` requires `--out` unless `--force` is
  explicit; response bodies can be large and should normally be inspected from
  the written JSON file.
- `wait ready --screenshot` captures visible checkpoint evidence after readiness
  succeeds.
- `screenshot capture/full/area/device` always stays bound to `--target`.
  `screenshot area <ref> <out.png>` captures the requested ref/selector as an
  explicit tall artifact when needed, and `screenshot device --visual-stable
  --settle-ms <ms>` captures responsive screenshots after readiness/settle checks
  with PNG dimension metadata. Device screenshots use DPR 1 by default, so
  `mobile:390x844` writes `390x844`.
- `screenshot full` uses native document full-page capture when the document
  scrolls. If the document is fixed-height but a dominant visible scroll
  container exists, it scrolls and stitches that container while preserving
  visible header/footer UI outside it. Pass `--selector <scroll-container>` when
  the target panel/list is known and only that panel is desired.
- Routine screenshot artifacts are normalized by default for agent use, following
  OpenClaw's max-side/max-bytes/quality ladder: JPEG quality 85, max side 2000px,
  max bytes 5mb. `--raw-size`, `--format png`, or an explicit `.png` path keeps
  exact browser pixels.
- `network body --full` requires `--out` unless `--force`; default stdout is
  capped and JSON-safe.
- `state headers`, `state permissions`, and `state clipboard` cover testing
  flows without opening DevTools. Permission grant/reset uses Chrome
  browser-wide APIs and requires `--force`.
- `daemon monitor --json` reports live CDP health, target count, sessions, and
  per-target buffer sizes without dumping page content. If a daemon is starting
  while Chrome waits for Allow debugging, retrying the same command should wait
  for that daemon instead of spawning a second controller.
- Browser-scoped Chrome profiles that share one `browserUrl` also share one
  physical daemon. The request context still keeps labels/provenance scoped by
  profile, but the CDP approval should happen once per browser endpoint.
- `chain` runs in one context; context flags belong on the `chain` command, not
  inside individual steps.
- `perf trace start/stop --out trace.json` captures a CDP performance trace to
  a file.
- `export pdf` uses CDP `Page.printToPDF`; it does not open a system dialog.

Default context:

```text
session use profile:chrome:Default
session use anonymous:check
session use endpoint:http://127.0.0.1:9222
session clear
session clear --all
session stop [query]
session stop [query] --all
```

Default context never replaces target selection. It only removes repeated
`--profile`/`--anonymous --session` flags for follow-up commands. Defaults are
stored per owner; `session clear` clears the current owner, and `session clear
--all` removes every owner default. `session stop` is also owner-scoped unless
`--all` is explicit.

Keyboard actions:

```text
action type -t app e1 "hello"
action type -t app --stdin
action press -t app Escape
action key -t app Escape
action drag -t app b1 --to b2
action drag -t app b1 --to-point 320,180
action drag -t app --from-point 20,40 --to-point 300,40
action drag -t app b1 --by 80,0 --steps 16 --duration 400
action state -t app --root active --compact --screenshot --annotate-refs
action upload -t app --root active --input-ref e2 ~/Downloads/file.png
action upload -t app --root active --trigger-ref b7 ~/Downloads/file.png
action submit -t app --root active --text "Submit"
action submit -t app b4
```

`type` can target a current ref/selector or type into the already focused
element. `press` is the documented key form. `key` is an alias for agents that
naturally use browser-action wording like "send key Escape".

`drag` performs a target-bound pointer drag and drops by releasing at the
destination. Sources and destinations are viewport CSS pixels or current
refs/selectors. Use `--to <ref|selector>`, `--to-point <x,y>`, or `--by
<dx,dy>`. Optional timing knobs are `--steps <n>`, `--duration <ms>`, `--hold
<ms>`, and `--button left|middle|right`.

`submit --text` is exact-match by default to avoid clicking wrapper controls that
only contain the requested label as part of a longer label. If an exact label is
not available, run `action state --root active --compact` and submit by the
specific button ref.

Screenshot checkpoints:

```text
wait ready -t app --visual-stable --screenshot --out tmp/ready.png
screenshot capture -t app --selector '[role=dialog]' tmp/dialog.png --annotate-refs
screenshot capture -t app tmp/app.jpg --max-side 1600 --max-bytes 2mb
screenshot capture -t app --raw-size tmp/app.png
screenshot full -t app tmp/app-full.png
screenshot full -t app --selector '[data-scroll-root]' tmp/panel-full.png
screenshot area -t app b2 tmp/button.png --annotate-refs
screenshot device -t page --anonymous --session responsive --devices desktop:1440x900,tablet:768x1024,mobile:390x844 --visual-stable --settle-ms 300 tmp/page
```

Use screenshots for visual state, layout, media, covered controls, upload
previews, and viewport evidence. Do not use screenshots as the primary parser for
huge feeds or large HTML pages; use scoped reads/query/items first. Action/wait
checkpoint screenshots are visible-root/viewport captures. Use `screenshot area`
or `screenshot full` only when the tall artifact itself is requested. Checkpoint
screenshots are normalized by default; read the returned `screenshot.path`
instead of assuming the requested `--out` extension was preserved.
`screenshot full` avoids false one-viewport captures on app shells by stitching
the dominant internal scroll container when the document itself does not scroll,
while keeping visible top and bottom chrome such as headers and composers.
On signed-in/current profile tabs, prefer `screenshot capture`, `screenshot
area`, or `wait ready --screenshot` for progress checks. `screenshot device`
sets CDP viewport emulation temporarily, so use it mainly on anonymous or
disposable tabs for responsive evidence; do not use it as a routine checkpoint
on a live compose/post/upload flow.
