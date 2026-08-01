# Realbrowser Design Notes

`realbrowser` is a standalone Node/CDP runtime. It does not call the old
`realbrowser` CLI as its backend.

Copied or ported patterns:

- From `chrome-cdp`: raw WebSocket CDP client, direct `DevToolsActivePort`
  WebSocket attach without requiring HTTP discovery, unique target prefixes,
  direct `Input.insertText`, `Input.dispatchMouseEvent`, and persistent daemon
  idea.
- From `gstack browse`: single command registry shape, auto-start loopback
  server, state file with token, process health check, and O(1) circular
  console/network/dialog buffers, stdin/file `chain`, snapshot diff, and
  cursor-interactive discovery.
- From OpenClaw browser: `suggestedTarget`, labels before raw IDs, target-bound
  actions, ref-based query/action flows, selector-scoped snapshots, CDP
  screenshot/PDF behavior, guarded final-action semantics, link URL refs, and
  compact output with large artifacts written to files.

Long-term invariants:

- Context, target, active root, and element ref are separate concepts.
- Current-state browsing starts from tab discovery. Public screenshots can use
  anonymous sessions; logged-in/current UI tasks should reuse existing tabs.
- Anonymous sessions are managed isolated temporary Chrome profiles. They are
  not Chrome's visual Incognito UI unless `--incognito`/`--private` is explicit.
  Incognito/private mode stays inside anonymous managed sessions so target
  labels, CDP screenshots, console/network capture, and guarded actions remain
  available; shell-only OS opens are a visual fallback, not the normal contract.
- `tab ensure` and `tab new` are creation commands; `tab select` never creates.
- `tab navigate` requires a target and never falls back to selected/first tab.
- `session use` sets only the default context; it never implies a selected tab.
- Default context and labels are owner-scoped. Owner comes from
  `--owner`/`REALBROWSER_OWNER`, then agent/terminal session environment, then the
  project path fallback. This keeps parallel sessions from reusing labels
  such as `app` or `page` by accident.
- Element refs are also owner-scoped. A read-only query in one session must
  not replace the `b1`/`e1` ref table another session is about to use for a
  guarded action.
- Mutating commands must honor target leases. A tab can be inspected by explicit
  target, but navigation, focusing, closing, actions, reload captures, state
  changes, viewport/full screenshots, annotated screenshots/checkpoints,
  downloads, trace control, dialog arming, and mutating raw CDP calls are blocked
  when another owner has a fresh lease unless `--take-lease` or `--force` is
  explicit.
- Browser-wide state APIs need their own guard even after a target lease passes.
  Permission grant/reset changes Chrome-wide permission state, so it requires
  `--force` in addition to the target lease check.
- Anonymous daemons are owner-separated. Real signed-in browser endpoints are
  shared per physical browser endpoint to minimize Chrome approvals, while labels
  and leases remain owner-aware.
- Profile-scoped CDP and browser-scoped CDP are different. Browser-scoped CDP
  can inspect explicit browser-wide targets, but it is not proof that a target
  belongs to the requested Chrome profile. Under `--profile`, unproven
  browser-scoped targets cannot be selected, navigated, read, or acted on by
  default. Profile-specific creation prefers proven `browserContextId` reuse or
  a verified background probe; already-running browser-scoped profiles are not
  OS-launched in background.
- Profile-open provenance is target-based, not label-only. Labels are stable
  handles for agents, but a tab opened by `realbrowser` through a named profile
  remains proven even when the caller did not provide a label.
- Profile app launch is still an OS/browser launch. It is allowed only for
  explicit handoff or stopped-profile launch where focus risk is accepted.
  Already-running browser-scoped profiles return recovery hints instead of
  launching through the OS.
- Direct browser WebSocket endpoints from `DevToolsActivePort` are canonical for
  already-running Chrome. HTTP `/json/version` is a convenience fallback, not a
  prerequisite for considering the profile attachable.
- Discovery is passive. Profile/session listing may read `DevToolsActivePort`
  and check whether the loopback port is open, but it must not send CDP commands
  or trigger Chrome's Allow debugging prompt.
- `--background` must not mean "launch the OS app and hope it stays hidden".
- Reads/actions/debugging are target-bound.
- Exact-tab console copy is a first-class workflow: verify one tab, read/capture
  that target only, and paste console lines verbatim.
- Reuse one CDP daemon per browser endpoint. Like `chrome-cdp`, a starting daemon
  is kept and waited on while the user approves Chrome debugging; retries must
  not spawn parallel controllers for the same `browserUrl`. Request context still
  scopes labels and profile provenance.
- Chrome's signed-in-profile approval prompt is not permanently suppressible by a
  CLI after browser/computer restart. The reliable contract is one reused daemon
  per live browser endpoint, not a forever approval grant.
- Disruptive recovery is explicit, approval-gated, and last-resort. If a
  signed-in browser is already running without a direct WebSocket CDP endpoint,
  ask before `profile relaunch --confirm` instead of leaving the user to quit
  Chrome manually.
- Root-scoped upload and guarded final submit are first-class, not examples.
  Upload safety is structural/protocol-based: standalone click blocks actual
  file inputs/labels and intercepts `Page.fileChooserOpened`; visible picker
  controls use `action upload --trigger-ref` instead of language-specific label
  matching.
- Shared workflows must remain site-agnostic. They can rely on browser
  structure, ARIA roles, active roots, refs, exact observed labels, network
  entries, and artifact paths; they should not bake in a social site, language,
  or app-specific CSS selector. Site-specific selectors are allowed only as
  one-off last-mile choices after a scoped read proves the current page needs
  them.
- Active-root and final-candidate selection is visual and structural, not
  site-specific. The active root favors visible modal/form/editor/main surfaces
  with viewport intersection, and final candidates are only promoted when they
  are visible, enabled, pointer-enabled, in the viewport, and topmost.
- Screenshots are target-bound visual checkpoints, not a parser replacement.
  `action state --screenshot --annotate-refs` and `wait ready --screenshot`
  cover the high-value points in form/upload/final-action flows without making
  every read/action pay screenshot cost. These checkpoint screenshots capture
  only the visible root/viewport; `screenshot area/full` are the explicit
  commands for tall artifacts. Checkpoint screenshots use OpenClaw's normalized
  artifact contract by default even when `--out` names a `.png`; the CLI returns
  the final path after format normalization. The implementation uses Chrome
  canvas instead of `sharp` or a native dependency. Annotated refs use an
  in-page DOM overlay and CDP capture, not OS screenshots, so the path stays
  portable across macOS, Linux, and Windows. Responsive device screenshots force
  DPR 1 and set `screenWidth/screenHeight` so output dimensions match the
  requested CSS viewport. Full screenshots follow the old `realbrowser`
  fixed-shell rule: native document capture when the document scrolls, otherwise
  stitch a dominant internal scroll container or an explicit `--selector` panel.
  The whole-page stitch extends the old rule by preserving visible footer chrome
  below the container, because chat/comment apps often keep the composer outside
  the scroll pane.
  The overlay labels the active root,
  visible refs, and skipped-ref counts without relying on page language or site
  copy. When annotated refs are requested for action safety, the agent must
  inspect the generated image before the next mutating action.
- Submit labels are exact-match by default. If a final control cannot be named
  exactly, the agent must submit by the active-root button ref instead of a broad
  text contains query. Final submit does not scroll offscreen matching controls
  into view before the guard, because that can select an adjacent panel on
  complex apps.
- Native text input is available as `action type <ref> <text>` so rich editors
  can receive real CDP input after a guarded focus click.
- Console/network/dialog buffers are per target.
- Daemon monitoring exposes health metadata, target count, and buffer sizes, not
  raw page content.
- Default output is compact; full debug data goes to files.
- Repeated-content readers prefer size/items/item/query before snapshots; broad
  full-page HTML/snapshots are a last resort.
- `network body --full`, HTML dumps, HARs, traces, screenshots, downloads, and
  PDFs should produce paths/metadata, not large stdout.
- Metadata endpoint URLs and credential-bearing URLs are blocked unless a
  guarded command explicitly allows force.
- The runtime is portable across macOS, Linux, and Windows with Node 22+ and a
  Chromium-family browser. Shell wrappers are thin launchers; the browser
  protocol work lives in Node/CDP. It avoids shell-specific loops and quoting
  traps by supporting `chain`.
- `read tree` uses CDP `Accessibility.getFullAXTree` for compact ARIA-based page
  representation. This is preferred over in-page JavaScript DOM walking because:
  the browser computes correct accessible names (resolving `aria-labelledby`
  chains, `<label for>` associations, `title` fallbacks), correct implicit roles
  (HTML semantics), and correct state inheritance (disabled propagation, hidden
  subtrees). The resulting tree is 5-20x more compact than DOM-based snapshots
  for typical pages. Refs from `read tree` bridge back to DOM via
  `DOM.pushNodesByBackendIds` + `DOM.setAttributeValue` so existing click/fill/type
  code works unchanged. `read tree` and `read snapshot` maintain separate diff
  baselines so `--diff` on each diffs against its own history.
- Focus restore for explicit stopped-profile launches uses platform-native tools:
  `osascript` on macOS, `xdotool` on Linux, PowerShell on Windows. All degrade
  gracefully if the platform tool is not installed.
