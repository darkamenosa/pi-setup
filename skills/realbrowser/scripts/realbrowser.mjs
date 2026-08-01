#!/usr/bin/env node
// realbrowser - target-first local browser control.
//
// The runtime intentionally does not delegate to the old realbrowser CLI.
// It copies proven shapes from:
// - chrome-cdp: raw WebSocket CDP, unique target prefixes, persistent daemon.
// - gstack browse: command registry, auto-start loopback server, O(1) buffers.
// - OpenClaw browser: suggested targets, target-bound refs, guarded actions.

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const VERSION = "0.3.1";
const STATE_SCHEMA_VERSION = "owner-lease-1";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const DEFAULT_TIMEOUT = 15_000;
const START_TIMEOUT = IS_WINDOWS ? 15_000 : 8_000;
const DAEMON_START_TIMEOUT = Number(process.env.REALBROWSER_DAEMON_START_TIMEOUT_MS || 45_000);
const IDLE_TIMEOUT = Number(process.env.REALBROWSER_IDLE_TIMEOUT_MS || 20 * 60 * 1000);
const MIN_TARGET_PREFIX_LEN = 8;
const BUFFER_LIMIT = Number(process.env.REALBROWSER_BUFFER_LIMIT || 50_000);
const FILE_CHOOSER_CLICK_GUARD_MS = Math.max(50, Math.min(2_000, Number(process.env.REALBROWSER_FILE_CHOOSER_CLICK_GUARD_MS || 350)));
const FILE_CHOOSER_BACKGROUND_CLICK_GUARD_MS = Math.max(FILE_CHOOSER_CLICK_GUARD_MS, Math.min(2_000, Number(process.env.REALBROWSER_FILE_CHOOSER_BACKGROUND_CLICK_GUARD_MS || 2_000)));
const DEFAULT_SCREENSHOT_MAX_SIDE = parseOptionalIntegerEnv("REALBROWSER_SCREENSHOT_MAX_SIDE", 2000);
const DEFAULT_SCREENSHOT_MAX_BYTES = parseOptionalBytesEnv("REALBROWSER_SCREENSHOT_MAX_BYTES", 5 * 1024 * 1024);
const DEFAULT_SCREENSHOT_JPEG_QUALITY = parseOptionalIntegerEnv("REALBROWSER_SCREENSHOT_JPEG_QUALITY", 85);
const SCREENSHOT_QUALITY_STEPS = [85, 75, 65, 55, 45, 35];
const SCREENSHOT_SIDE_STEPS = [1800, 1600, 1400, 1200, 1000, 800];

if (!IS_WINDOWS) {
  try { process.umask(0o077); } catch {}
}

const STATE_DIR = process.env.REALBROWSER_STATE_DIR || defaultStateDir();
const ARTIFACT_DIR = process.env.REALBROWSER_ARTIFACT_DIR || path.join(os.tmpdir(), "realbrowser-artifacts");
const LABELS_FILE = path.join(STATE_DIR, "labels.json");
const LABEL_META_FILE = path.join(STATE_DIR, "label-meta.json");
const TARGET_META_FILE = path.join(STATE_DIR, "target-meta.json");
const LEASES_FILE = path.join(STATE_DIR, "target-leases.json");
const TASK_TABS_FILE = path.join(STATE_DIR, "task-tabs.json");
// v0.3.0: session-scoped registry. Keyed by Chrome instance (DevTools browser
// UUID from browserUrl, anonymous-dir for --anonymous, contextKey for fallback).
// Shared across all tasks/owners that talk to the SAME Chrome — fixes the
// "nested subagent each opens its own same-origin tab" failure mode.
const SESSION_REGISTRY_FILE = path.join(STATE_DIR, "session-registry.json");
const HANDLES_DIR = path.join(STATE_DIR, "handles");
const DEFAULT_CONTEXT_FILE = path.join(STATE_DIR, "default-context.json");
const DEFAULT_TASK_ID = "default";
const OWNER_ENV_KEYS = [
  "REALBROWSER_OWNER",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_SESSION",
  "OPENAI_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "TERM_SESSION_ID",
  "ITERM_SESSION_ID",
];
const OWNER_SCOPE_SEPARATOR = "@@owner:";
const LEASE_STALE_MS = parseOptionalIntegerEnv("REALBROWSER_LEASE_STALE_MS", 7 * 24 * 60 * 60 * 1000);
const TRUSTED_PROFILE_SOURCES = new Set([
  "profile-open",
  "profile-open-verified",
  "cdp-create-with-context",
  "cdp-create-verified-profile",
]);

function trustedProfileSource(source) {
  return TRUSTED_PROFILE_SOURCES.has(source || "");
}

const GROUPS = {
  profile: ["list", "inspect", "relaunch"],
  session: ["list", "use", "clear", "stop"],
  daemon: ["status", "doctor", "monitor", "restart", "stop"],
  tab: ["list", "select", "ensure", "new", "navigate", "label", "focus", "close", "handoff", "resume", "done"],
  handle: ["create", "list", "release"],
  read: ["observe", "size", "tree", "snapshot", "query", "query-selector", "items", "item", "text", "html", "links", "forms", "url", "is", "autocomplete", "overlay"],
  wait: ["ready", "selector", "text", "url", "load", "network"],
  action: ["state", "root", "click", "fill", "type", "press", "key", "upload", "submit", "hover", "select", "scroll", "drag"],
  screenshot: ["capture", "full", "area", "device", "responsive"],
  console: ["list", "get", "clear", "capture"],
  network: ["list", "get", "body", "export", "clear", "capture"],
  state: ["cookies", "storage", "cache", "headers", "permissions", "clipboard", "emulate"],
  dialog: ["list", "arm", "accept", "dismiss"],
  perf: ["timing", "vitals", "trace"],
  download: ["click", "wait"],
  export: ["pdf"],
  devtools: ["list", "raw"],
  chain: ["run"],
};

// Role classification adopted from openclaw's snapshot-roles.ts so the two
// drivers produce equivalent snapshots. Sets match openclaw verbatim — keep in
// sync if we ever update.

// Roles that represent user-interactive elements; always get a ref.
const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "radio", "searchbox", "slider",
  "spinbutton", "switch", "tab", "textbox", "treeitem",
]);

// Roles that carry meaningful content; get a ref when named. Render in compact
// mode regardless of name (openclaw does the same).
const CONTENT_ROLES = new Set([
  "article", "cell", "columnheader", "gridcell", "heading", "listitem",
  "main", "navigation", "region", "rowheader",
]);

// Structural/container roles — skipped in compact mode unless named.
const STRUCTURAL_ROLES = new Set([
  "application", "directory", "document", "generic", "grid", "group", "ignored",
  "list", "menu", "menubar", "none", "presentation", "row", "rowgroup", "table",
  "tablist", "toolbar", "tree", "treegrid",
]);

// Extra landmarks Chrome's AX tree emits that openclaw doesn't classify but
// we want to preserve as hierarchy anchors when they scope interactive
// descendants. These render even without a name.
const ALWAYS_LANDMARK_ROLES = new Set([
  "banner", "complementary", "contentinfo", "dialog", "alertdialog", "tabpanel",
  "form", "search",
]);

const TARGET_REQUIRED_GROUPS = new Set([
  "read", "wait", "action", "screenshot", "console", "network", "state", "dialog", "perf", "download", "export", "devtools",
]);

const VALUE_FLAGS = new Set([
  "-t", "--target", "-p", "--profile", "-o", "--out", "--output",
  "--context", "--owner",
  "--handle", "--handle-out", "--handle-name", "--browser", "--browser-url",
  "--session", "--label", "--timeout", "--max-chars", "--limit", "--selector",
  "--root", "--input", "--input-ref", "--element", "--trigger", "--trigger-ref", "--text", "--value-file", "--from", "--return", "--trace",
  "--to", "--to-ref", "--to-selector", "--to-point", "--from-point", "--by", "--button", "--steps", "--hold",
  "--devices", "--viewport", "--format", "--quality", "--max-side", "--max-bytes",
  "--dir", "--download-dir", "--filter", "--method", "--status", "--type",
  "--include", "--request-file", "--response-file", "--binary", "--header",
  "--name", "--url", "--origin", "--network", "--cpu", "--user-agent",
  "--color-scheme", "--geolocation", "--timezone", "--locale", "--contains",
  "--item", "--item-selector", "--card-selector", "--root-selector", "--collection",
	  "--index", "--collect-until-index", "--expand", "--expand-selector", "--fields", "--attr",
  "--href-filter", "--text-filter", "--max-text-chars", "--max-html-chars",
  "--min-text-chars", "--link-limit", "--min-items", "--max-items", "--ready-selector",
  "--ready-text", "--min-cards", "--params", "--var", "--set", "--ref",
  "--foreach", "--reuse", "--wait", "--duration", "--har", "--settle-ms",
  "-d", "--depth", "--max-nodes", "--max-labels", "--max-stitch-captures",
  "--near",
  "--task",
]);

const BOOLEAN_FLAGS = new Set([
  "-h", "--help", "--version", "--json", "--plain", "--quiet", "-q", "--verbose", "-i", "-c", "-D",
  "--debug", "--values", "--background", "--front", "--best-effort-background",
  "--allow-browser-scope-target",
  "--no-fallback", "--anonymous", "--incognito", "--private", "--headless", "--headed", "--full", "--full-page",
  "--raw-size", "--reload", "--failed", "--errors", "--clear", "--preserve",
  "--visible", "--enabled", "--topmost", "--active-root", "--compact",
  "--interactive", "--urls", "--diff", "--cursor-interactive", "--direct-children",
  "--request", "--response", "--decode", "--include-body", "--print-background",
  "--force", "--confirm", "--yes", "--continue-on-error", "--no-input", "--no-color",
  "--full-stdout", "--dry-run", "--dispatch-events", "--visual-stable",
  "--screenshot", "--annotate-refs", "--annotate", "--labels", "--mobile-emulation", "--mobile",
  "--no-skeletons", "--latest", "--active", "--stdin", "--final", "--cdp",
  "--system", "--deep", "--allow-file-dialog", "--no-normalize", "--normalize", "--bypass-overlay",
  "--require-change",
  "--take-lease", "--all", "--global",
  "--mine", "--owned", "--force-new", "--allow-user-tab-mutation", "--close",
]);

class CliError extends Error {
  constructor(message, { code = "error", exitCode = 1, next = [] } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.next = next;
  }
}

class CircularBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.size = 0;
    this.totalAdded = 0;
  }
  push(entry) {
    const index = (this.head + this.size) % this.capacity;
    this.buffer[index] = entry;
    if (this.size < this.capacity) this.size += 1;
    else this.head = (this.head + 1) % this.capacity;
    this.totalAdded += 1;
  }
  toArray() {
    const out = [];
    for (let i = 0; i < this.size; i += 1) out.push(this.buffer[(this.head + i) % this.capacity]);
    return out;
  }
  last(n) {
    return this.toArray().slice(-n);
  }
  clear() {
    this.head = 0;
    this.size = 0;
  }
}

class CDP {
  constructor() {
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closeHandlers = [];
  }
  async connect(wsUrl, timeoutMs = 10_000) {
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket handshake timed out: ${redactUrl(wsUrl)}`)), timeoutMs);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${event.message || event.type || "unknown"}`));
      };
      this.ws.onclose = () => {
        for (const handler of this.closeHandlers) handler();
      };
      this.ws.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          else pending.resolve(message.result ?? {});
          return;
        }
        if (message.method) {
          const handlers = this.handlers.get(message.method);
          if (handlers) for (const handler of [...handlers]) handler(message.params || {}, message);
        }
      };
    });
  }
  send(method, params = {}, sessionId = undefined, timeoutMs = DEFAULT_TIMEOUT) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("CDP socket is not connected");
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method)?.delete(handler);
  }
  waitFor(method, predicate = () => true, timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(method, (params, message) => {
        let matched = false;
        try { matched = predicate(params, message); } catch (error) {
          clearTimeout(timer);
          off();
          reject(error);
          return;
        }
        if (!matched) return;
        clearTimeout(timer);
        off();
        resolve({ params, message });
      });
    });
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function main(argv) {
  if (argv[0] === "__daemon") {
    await runDaemon(argv.slice(1));
    return 0;
  }
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help") || argv[0] === "help") {
    printHelp(argv);
    return 0;
  }
  if (argv[0] === "version" || argv.includes("--version")) {
    stdout(`realbrowser ${VERSION}\n`);
    return 0;
  }
  await ensureBaseDirs();
  const parsed = parseCli(argv);
  if (parsed.group === "completion") {
    stdout(completionScript(parsed.command || parsed.args[0] || "bash"));
    return 0;
  }
  if (parsed.group === "self-test") {
    await runSelfTest();
    return 0;
  }
  if (parsed.group === "profile") {
    printResult(await handleProfileCli(parsed), parsed.flags);
    return 0;
  }
  if (parsed.group === "session") {
    printResult(await handleSessionCli(parsed), parsed.flags);
    return 0;
  }
  if (parsed.group === "daemon" && ["status", "monitor", "stop", "restart", "doctor"].includes(parsed.command || "status")) {
    printResult(await handleDaemonCli(parsed), parsed.flags);
    return 0;
  }
  if (parsed.group === "handle" && parsed.command === "list") {
    printResult(await listHandles(), parsed.flags);
    return 0;
  }
  if (parsed.group === "handle" && parsed.command === "release") {
    printResult(await releaseHandleCli(parsed), parsed.flags);
    return 0;
  }
  if (parsed.group === "chain") {
    await hydrateChainInput(parsed);
  }
  validateBeforeContext(parsed);
  if (TARGET_REQUIRED_GROUPS.has(parsed.group)) requireTarget(parsed);
  const context = await resolveContext(parsed.flags, parsed);
  const response = await rpc(context, parsed);
  if (parsed.group === "handle" && parsed.command === "create") {
    printResult(await writeHandleFromResponse(parsed, response, context), parsed.flags);
  } else {
    printResult(response, parsed.flags);
  }
  return 0;
}

function parseCli(argv) {
  const { flags, rest } = parseFlags(argv);
  const group = rest.shift();
  if (!group) throw usage("missing command group");
  if (!GROUPS[group] && group !== "completion" && group !== "self-test") {
    throw usage(`unknown command group: ${group}`, ["realbrowser help"]);
  }
  let command;
  if (group === "chain") {
    command = rest[0] === "run" ? rest.shift() : "run";
  } else {
    command = rest[0] && !rest[0].startsWith("-") ? rest.shift() : defaultCommand(group);
  }
  if (GROUPS[group] && !GROUPS[group].includes(command)) {
    throw usage(`unknown command: ${group} ${command}`, [`realbrowser help ${group}`]);
  }
  normalizeFlags(flags);
  return { group, command, args: rest, flags };
}

function validateBeforeContext(parsed) {
  const { group, command, args = [], flags = {} } = parsed;
  if (group === "read") {
    if ((command === "query" || command === "query-selector") && !(args[0] || flags.selector)) throw usage("read query requires <selector>");
    if (command === "is" && !(args[0] && args[1])) throw usage("read is requires <state> <ref|selector>");
  }
  if (group === "wait") {
    if (command === "selector" && !(args[0] || flags.selector)) throw usage("wait selector requires <selector>");
    if (command === "text" && !(args.join(" ") || flags.text)) throw usage("wait text requires <text>");
    if (command === "url" && !(flags.contains || args[0])) throw usage("wait url requires --contains <text>");
  }
  if (group === "action") validateActionArgs(command, args, flags);
  if (group === "screenshot" && command === "area" && !(args[0] || flags.selector || flags.ref)) throw usage("screenshot area requires <ref|selector> [out.png] or --selector <css> <out.png>");
  if (group === "console" && command === "get" && !args[0]) throw usage("console get requires <message-id>");
  if (group === "network") validateNetworkArgs(command, args, flags);
  if (group === "download" && command === "click" && !args[0]) throw usage("download click requires <ref|selector>");
  if (group === "devtools" && command === "raw" && !args[0]) throw usage("devtools raw requires <CDP.method>");
}

function validateActionArgs(command, args = [], flags = {}) {
  if (command === "submit" && !args[0] && !flags.text && !flags.ref) throw new CliError("action submit requires <button-ref> or --text <exact label>", {
    code: "final_action_requires_target",
    exitCode: 2,
    next: ["realbrowser action state -t <target> --root active --compact"],
  });
  if ((command === "click" || command === "hover") && !(args[0] || flags.text || flags.ref)) throw usage(`action ${command} requires <ref|selector>`);
  if (command === "fill" || command === "select") {
    const hasRef = args[0] || flags.ref;
    const hasValue = (args[0] ? args.length > 1 : args.length >= 1) || flags.stdin || flags.valueFile;
    if (!hasRef || !hasValue) throw usage(`action ${command} requires <ref|selector> <value>`);
  }
  if (command === "type" && !(args.length || flags.stdin || flags.valueFile)) throw usage("action type requires <text> or --stdin/--value-file");
  if ((command === "press" || command === "key") && !args.join(" ")) throw usage(`action ${command} requires <key>`);
  if (command === "upload") validateUploadArgs(args, flags);
  if (command === "drag") validateDragArgs(args, flags);
}

function validateUploadArgs(args = [], flags = {}) {
  const input = flags.input || flags.inputRef || flags.element || flags.ref;
  const trigger = flags.trigger || flags.triggerRef;
  const files = args.filter((arg) => !arg.startsWith("-"));
  if (!files.length) throw usage("action upload requires <file...>");
  if (input && trigger) throw usage("action upload cannot combine --input-ref/--element with --trigger-ref");
}

function validateDragArgs(args = [], flags = {}) {
  const fromPoint = flags.fromPoint;
  const fromTarget = fromPoint ? "" : (args[0] || flags.ref || flags.from);
  const toTarget = args[fromPoint && !flags.to && !flags.toRef && !flags.toSelector && !flags.toPoint && !flags.by ? 0 : 1] ||
    flags.to || flags.toRef || flags.toSelector;
  const destinationCount = [toTarget, flags.toPoint, flags.by].filter(Boolean).length;
  if (!fromPoint && !fromTarget) throw usage("action drag requires <from-ref|selector> or --from-point <x,y>");
  if (destinationCount < 1) throw usage("action drag requires --to <ref|selector>, --to-point <x,y>, --by <dx,dy>, or a second positional target");
  if (destinationCount > 1) throw usage("action drag accepts only one destination: --to, --to-point, or --by");
}

function validateNetworkArgs(command, args = [], flags = {}) {
  if (command === "capture") assertNetworkCaptureBodyOut(flags);
  if (command === "export" && !(flags.out || args[0])) throw usage("network export requires --out <path>");
  if ((command === "get" || command === "body") && !(args[0] || flags.latest)) throw usage(`network request not found: ${args[0] || ""}`.trim());
  if (command === "body" && flags.full && !(flags.out || flags.responseFile || flags.requestFile || flags.force)) {
    throw new CliError("network body --full requires --out unless --force is explicit", {
      code: "large_stdout_guard",
      exitCode: 2,
      next: ["realbrowser network body -t app req_12 --response --out tmp/body.txt --full"],
    });
  }
}

function parseFlags(argv) {
  const flags = { json: false, values: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const valueFromEq = eq > 0 ? arg.slice(eq + 1) : undefined;
    if (VALUE_FLAGS.has(name)) {
      const value = valueFromEq ?? argv[++i];
      if (value === undefined) throw usage(`${name} requires a value`);
      setFlag(flags, name, value);
    } else if (BOOLEAN_FLAGS.has(name)) {
      setFlag(flags, name, true);
    } else {
      throw usage(`unknown flag: ${name}`);
    }
  }
  return { flags, rest };
}

function setFlag(flags, name, value) {
  const key = ({
    "-t": "target", "--target": "target",
    "-p": "profile", "--profile": "profile",
    "-o": "out", "--out": "out", "--output": "out",
    "-h": "help", "--help": "help",
    "-q": "quiet", "--quiet": "quiet",
    "-i": "interactive", "-c": "compact", "-D": "diff", "-d": "depth",
  })[name] || name.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (key === "set") {
    flags.set ??= [];
    flags.set.push(String(value));
  } else if (key === "header") {
    flags.header ??= [];
    flags.header.push(String(value));
  } else {
    flags[key] = value;
  }
}

function normalizeFlags(flags) {
  if (flags.output && !flags.out) flags.out = flags.output;
  if (flags.private) flags.incognito = true;
  if (flags.front) flags.background = false;
  if (flags.incognito && !flags.profile && !flags.browserUrl && !flags.context) flags.anonymous = true;
  if (flags.anonymous && !flags.session) {
    flags.session = "anonymous";
  }
  if (flags.session && !flags.profile && !flags.browserUrl && !flags.context) flags.anonymous = true;
  if (flags.timeout) flags.timeout = Number(flags.timeout);
  if (!Number.isFinite(flags.timeout)) flags.timeout = DEFAULT_TIMEOUT;
}

function normalizeOwner(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value.replace(/[^A-Za-z0-9_.:@/-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function explicitOwnerSelected(flags = {}) {
  return Boolean(flags.owner || flags.global || process.env.REALBROWSER_OWNER);
}

function resolveOwner(flags = {}) {
  if (flags.global) return "global";
  for (const key of OWNER_ENV_KEYS) {
    const value = key === "REALBROWSER_OWNER" ? flags.owner || process.env[key] : process.env[key];
    const owner = normalizeOwner(value);
    if (owner) return owner;
  }
  return fallbackOwner();
}

function fallbackOwner() {
  const root = nearestProjectRoot(process.cwd()) || process.cwd();
  const base = sanitizeOwnerComponent(path.basename(root) || "workspace");
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 10);
  return normalizeOwner(`${base}-${hash}`);
}

function sanitizeOwnerComponent(value) {
  return String(value || "workspace").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "workspace";
}

function nearestProjectRoot(start) {
  let current = path.resolve(start || process.cwd());
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return path.resolve(start || process.cwd());
}

function ownerScopedContextKey(contextKey, owner) {
  return `${contextKey}${OWNER_SCOPE_SEPARATOR}${normalizeOwner(owner) || "default"}`;
}

function baseContextKeyFromScopedKey(key) {
  return String(key || "").split(OWNER_SCOPE_SEPARATOR)[0];
}

function ownerFromScopedContextKey(key) {
  const index = String(key || "").indexOf(OWNER_SCOPE_SEPARATOR);
  return index >= 0 ? String(key).slice(index + OWNER_SCOPE_SEPARATOR.length) : "";
}

function resolveTaskId(flags = {}) {
  const candidates = [
    flags.task,
    process.env.REALBROWSER_TASK_ID,
    flags.owner,
    process.env.REALBROWSER_OWNER,
  ];
  for (const value of candidates) {
    const normalized = normalizeOwner(value);
    if (normalized) return normalized;
  }
  return DEFAULT_TASK_ID;
}

function canonicalOriginKey(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return `url:${String(rawUrl || "").trim()}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    parsed.hash = "";
    return `url:${parsed.href}`;
  }
  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}`;
}

function taskRegistryScopeKey(contextScopeKey, taskId) {
  const safeTask = normalizeOwner(taskId) || DEFAULT_TASK_ID;
  return `${contextScopeKey}@@task:${safeTask}`;
}

function taskTabRecordIsLive(record, liveById) {
  return Boolean(record?.targetId && liveById && liveById.has(record.targetId));
}

function duplicateTaskOriginError({ origin, existing, requestedLabel, url }) {
  const label = existing?.label || existing?.suggestedTarget || (existing?.targetId || "").slice(0, MIN_TARGET_PREFIX_LEN);
  const requested = requestedLabel || "new-label";
  return new CliError(`already have an agent tab for origin ${origin} in this task under label ${label}`, {
    code: "duplicate_task_origin",
    exitCode: 2,
    existing: {
      label,
      target: existing?.targetId || "",
      url: existing?.url || "",
      origin,
      owner: existing?.owner,
      task: existing?.taskId,
    },
    next: [
      `realbrowser action state -t ${label} --root active --compact`,
      `realbrowser tab navigate -t ${label} ${url}`,
      `realbrowser tab ensure ${url} --label ${requested} --force-new`,
    ],
  });
}

function anonymousContextKey(flags, session) {
  return flags.incognito ? `anonymous-incognito:${session}` : `anonymous:${session}`;
}

function defaultCommand(group) {
  return ({
    profile: "list",
    session: "list",
    daemon: "status",
    tab: "list",
    handle: "list",
    read: "observe",
    wait: "ready",
    action: "state",
    screenshot: "capture",
    console: "list",
    network: "list",
    dialog: "list",
    perf: "timing",
    chain: "run",
  })[group] || "";
}

function requireTarget(parsed) {
  if (parsed.flags.target || parsed.flags.handle) return;
  throw new CliError(`${parsed.group} ${parsed.command} requires --target/-t or --handle`, {
    code: "target_required",
    exitCode: 3,
    next: [
      "realbrowser tab list <query> --profile <profile>",
      "realbrowser tab ensure <url> --profile <profile> --label app --background",
      `realbrowser ${parsed.group} ${parsed.command} -t app`,
    ],
  });
}

async function resolveContext(flags, parsed = {}) {
  const ownerExplicit = explicitOwnerSelected(flags);
  flags.owner = resolveOwner(flags);
  const explicitBeforeDefaults = hasExplicitContext(flags) || Boolean(flags.handle);
  if (flags.context) {
    mergeContextFlags(flags, contextFlagsFromString(flags.context));
  }
  if (!explicitBeforeDefaults && !hasExplicitContext(flags) && flags.target) {
    mergeContextFlags(flags, contextFlagsForKnownTarget(flags.target, flags.owner));
  }
  if (!explicitBeforeDefaults && !hasExplicitContext(flags)) {
    mergeContextFlags(flags, await defaultContextFlags(flags.owner));
  }
  if (flags.session && !flags.profile && !flags.browserUrl) flags.anonymous = true;
  if (flags.handle) {
    const handle = await readHandle(flags.handle);
    if (!flags.target) flags.target = handle.target || handle.label || handle.targetId;
    if (handle.context?.owner && !ownerExplicit) flags.owner = normalizeOwner(handle.context.owner);
    validateHandleContext(flags, handle);
    if (handle.context?.profile && !flags.profile) flags.profile = handle.context.profile;
    if (handle.context?.browserUrl && !flags.browserUrl) flags.browserUrl = handle.context.browserUrl;
    if (handle.context?.session && !flags.session) flags.session = handle.context.session;
    if (handle.context?.anonymous) flags.anonymous = true;
  }
  if (flags.incognito && (flags.profile || flags.browserUrl)) {
    throw new CliError("--incognito/--private is only supported for anonymous managed browser contexts", {
      code: "context_conflict",
      exitCode: 2,
      next: ["realbrowser tab ensure https://example.com --anonymous --session private --label page --front --incognito"],
    });
  }
  if (flags.browserUrl) {
    return { kind: "endpoint", key: `endpoint:${flags.browserUrl}`, owner: flags.owner, browserUrl: flags.browserUrl, flags: publicContextFlags(flags) };
  }
  if (flags.anonymous) {
    const session = flags.session || "anonymous";
    return {
      kind: "anonymous",
      key: anonymousContextKey(flags, session),
      session,
      owner: flags.owner,
      incognito: Boolean(flags.incognito),
      headless: flags.headed ? false : !flags.front,
      flags: publicContextFlags(flags),
    };
  }
  if (flags.profile) {
    const profile = await resolveProfile(flags.profile, flags.browser);
    const endpoint = endpointFromProfile(profile);
    if (!endpoint) {
      if ((parsed.group === "tab" && ["ensure", "new"].includes(parsed.command)) && !profileUserDataInUse(profile.userDataDir)) {
        if (!flags.front && !flags.bestEffortBackground) {
          throw new CliError(`cannot safely create a background tab in profile ${profile.id}`, {
            code: "profile_background_launch_guard",
            exitCode: 4,
            next: [
              "profile app launch may steal focus when no DevToolsActivePort direct WebSocket endpoint exists",
              `realbrowser tab ensure <url> --profile "${profile.id}" --label app --best-effort-background`,
              `realbrowser tab ensure <url> --profile "${profile.id}" --label app --front`,
            ],
          });
        }
        return {
          kind: "profile-launch",
          key: `profile:${profile.id}`,
          owner: flags.owner,
          profile,
          allowFocusRisk: Boolean(flags.front || flags.bestEffortBackground),
          front: Boolean(flags.front),
          flags: publicContextFlags(flags),
        };
      }
      const running = profileUserDataInUse(profile.userDataDir);
      const next = running ? [
        `profile ${profile.id} is already running without a DevToolsActivePort direct WebSocket endpoint; --best-effort-background cannot attach to that existing browser`,
        "if Chrome is showing a debugging approval prompt, approve it and retry the same command",
        `only as a last resort, ask the user to approve quitting/relaunching ${profile.browserName || profile.browser} with remote debugging for this user data directory`,
        `realbrowser profile relaunch "${profile.id}" --confirm`,
        `realbrowser profile inspect ${profile.id} --json`,
        "realbrowser profile list",
      ] : [
        "start it with remote debugging enabled, or retry with explicit profile launch risk",
        `realbrowser profile inspect ${profile.id} --json`,
        `realbrowser tab ensure <url> --profile "${profile.id}" --label app --best-effort-background`,
        `realbrowser tab ensure <url> --profile "${profile.id}" --label app --front`,
      ];
      throw new CliError(`profile ${profile.id} is ${running ? "already running but not exposing" : "not exposing"} a DevToolsActivePort direct WebSocket endpoint`, {
        code: "profile_endpoint_unavailable",
        exitCode: 4,
        next,
      });
    }
    return {
      kind: "profile",
      key: `profile:${profile.id}`,
      owner: flags.owner,
      profile,
      browserUrl: endpointBrowserUrl(endpoint),
      endpointScope: endpoint.scope || "unknown",
      flags: publicContextFlags(flags),
    };
  }
  const endpoint = await findAnyDevtoolsEndpoint();
  if (endpoint) {
    return { kind: "endpoint", key: `endpoint:${endpoint}`, owner: flags.owner, browserUrl: endpoint, flags: publicContextFlags(flags) };
  }
  if (parsed.group === "tab" && ["ensure", "new"].includes(parsed.command)) {
    const session = flags.session || "default";
    return {
      kind: "anonymous",
      key: anonymousContextKey(flags, session),
      session,
      owner: flags.owner,
      incognito: Boolean(flags.incognito),
      headless: flags.headed ? false : !flags.front,
      flags: publicContextFlags(flags),
    };
  }
  throw new CliError("no browser context selected and no DevToolsActivePort found", {
    code: "context_required",
    exitCode: 4,
    next: [
      "realbrowser profile list --active",
      "realbrowser tab ensure https://example.com --anonymous --session check --label page",
      "realbrowser tab list --browser-url http://127.0.0.1:9222",
    ],
  });
}

function hasExplicitContext(flags = {}) {
  return Boolean(flags.context || flags.profile || flags.browserUrl || flags.anonymous || flags.session);
}

function mergeContextFlags(flags, contextFlags = {}) {
  if (!contextFlags || typeof contextFlags !== "object") return flags;
  for (const [key, value] of Object.entries(contextFlags)) {
    if (value === undefined || value === null || value === "") continue;
    if (flags[key] === undefined || flags[key] === false) flags[key] = value;
  }
  return flags;
}

function contextFlagsFromString(raw) {
  const value = String(raw || "").trim();
  if (!value) return {};
  if (/^https?:\/\//i.test(value) || /^wss?:\/\//i.test(value)) return { browserUrl: value };
  if (value.startsWith("endpoint:")) return { browserUrl: value.slice("endpoint:".length) };
  if (value.startsWith("browser-url:")) return { browserUrl: value.slice("browser-url:".length) };
  if (value.startsWith("profile:")) return { profile: value.slice("profile:".length) };
  if (/^(chrome|chromium|brave|edge):/i.test(value)) return { profile: value };
  if (value.startsWith("anonymous-incognito:")) return { anonymous: true, incognito: true, session: value.slice("anonymous-incognito:".length) || "anonymous" };
  if (value.startsWith("incognito:")) return { anonymous: true, incognito: true, session: value.slice("incognito:".length) || "anonymous" };
  if (value.startsWith("private:")) return { anonymous: true, incognito: true, session: value.slice("private:".length) || "anonymous" };
  if (value.startsWith("anonymous:")) return { anonymous: true, session: value.slice("anonymous:".length) || "anonymous" };
  if (value.startsWith("session:")) return { anonymous: true, session: value.slice("session:".length) || "anonymous" };
  return { anonymous: true, session: value };
}

function contextFlagsForKnownTarget(target, owner) {
  const raw = String(target || "").replace(/^label:/, "").trim();
  if (!raw || raw.startsWith("cdp:")) return {};
  const labels = readJson(LABELS_FILE) || {};
  // Two-tier resolution:
  //   1. Owner-scoped first (preserves existing behavior for parallel/scoped
  //      sessions where you don't want a stale-labeled tab from another agent
  //      to hijack your --target).
  //   2. Cross-owner fallback when no same-owner match exists. This is what
  //      rescues the "label persisted in terminal pane A but pane B has a fresh
  //      TERM_SESSION_ID-derived owner" case — the same base context (e.g.
  //      profile:chrome:Default) is unambiguous even across owners, so we
  //      apply it. The daemon-side label resolver does the same kind of
  //      fallback so the label itself also resolves to the right targetId.
  const sameOwner = [];
  const otherOwner = [];
  for (const [contextKey, contextLabels] of Object.entries(labels)) {
    if (!contextLabels || typeof contextLabels !== "object") continue;
    if (typeof contextLabels[raw] !== "string") continue;
    const scopedOwner = ownerFromScopedContextKey(contextKey);
    if (!scopedOwner || scopedOwner === owner) sameOwner.push(contextKey);
    else otherOwner.push(contextKey);
  }
  const sameUnique = [...new Set(sameOwner.map(baseContextKeyFromScopedKey))];
  if (sameUnique.length === 1) return contextFlagsFromString(sameUnique[0]);
  if (sameUnique.length > 1) return {};
  const otherUnique = [...new Set(otherOwner.map(baseContextKeyFromScopedKey))];
  if (otherUnique.length === 1) return contextFlagsFromString(otherUnique[0]);
  return {};
}

async function defaultContextFlags(owner) {
  const envContext = process.env.REALBROWSER_CONTEXT;
  if (envContext) return contextFlagsFromString(envContext);
  if (process.env.REALBROWSER_BROWSER_URL) {
    return { browserUrl: process.env.REALBROWSER_BROWSER_URL };
  }
  if (process.env.REALBROWSER_PROFILE) {
    return { profile: process.env.REALBROWSER_PROFILE };
  }
  if (process.env.REALBROWSER_SESSION) {
    return { anonymous: true, session: process.env.REALBROWSER_SESSION };
  }
  return defaultContextEntryForOwner(owner)?.flags || {};
}

function validateHandleContext(flags, handle) {
  const context = handle.context || {};
  const mismatches = [];
  if (flags.owner && context.owner && flags.owner !== context.owner) mismatches.push(`owner ${flags.owner} != ${context.owner}`);
  if (flags.profile && context.profile && flags.profile !== context.profile) mismatches.push(`profile ${flags.profile} != ${context.profile}`);
  if (flags.browserUrl && context.browserUrl && flags.browserUrl !== context.browserUrl) mismatches.push("browser-url differs");
  if (flags.session && context.session && flags.session !== context.session) mismatches.push(`session ${flags.session} != ${context.session}`);
  if (flags.anonymous && context.profile) mismatches.push("anonymous flag conflicts with profile handle");
  if (!mismatches.length) return;
  throw new CliError(`handle context mismatch: ${mismatches.join(", ")}`, {
    code: "handle_context_mismatch",
    exitCode: 4,
    next: ["use the handle without overriding context, or create a fresh handle in the desired context"],
  });
}

function publicContextFlags(flags) {
  return {
    owner: flags.owner,
    profile: flags.profile,
    browser: flags.browser,
    browserUrl: flags.browserUrl,
    anonymous: Boolean(flags.anonymous),
    session: flags.session,
    incognito: Boolean(flags.incognito),
    global: Boolean(flags.global),
    front: Boolean(flags.front),
    background: flags.background !== false,
  };
}

async function ensureBaseDirs() {
  await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(HANDLES_DIR, { recursive: true, mode: 0o700 });
}

async function rpc(context, payload) {
  const state = await ensureDaemon(context);
  const body = JSON.stringify({ payload: { ...payload, context } });
  const response = await httpRequest({
    method: "POST",
    url: `http://127.0.0.1:${state.port}/rpc`,
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${state.token}`,
      "content-length": Buffer.byteLength(body),
    },
    body,
    // CLI->daemon RPC timeout. Command --timeout bounds the browser operation;
    // the thin client must wait longer so a slow but successful daemon action
    // does not look like a failure and then succeed on retry.
    timeoutMs: Math.max(60_000, Number(payload.flags?.timeout || 0) + 30_000),
  });
  if (response.statusCode >= 400) {
    let parsed;
    try { parsed = JSON.parse(response.body); } catch {}
    throw new CliError(parsed?.error || response.body || `daemon error ${response.statusCode}`, {
      code: parsed?.code || "daemon_error",
      exitCode: parsed?.exitCode || 1,
      next: parsed?.next || [],
    });
  }
  return JSON.parse(response.body);
}

async function ensureDaemon(context) {
  const stateFile = stateFileForContext(context);
  const existing = await readyDaemonStateFromFile(stateFile, context);
  if (existing) return existing;
  const reusable = await reusableDaemonForContext(context, stateFile);
  if (reusable) return reusable;
  return await withDaemonStartLock(stateFile, context, async () => {
    const afterLock = await readyDaemonStateFromFile(stateFile, context);
    if (afterLock) return afterLock;
    const reusableAfterLock = await reusableDaemonForContext(context, stateFile);
    if (reusableAfterLock) return reusableAfterLock;
    await fsp.rm(stateFile, { force: true }).catch(() => {});
    const token = crypto.randomBytes(24).toString("hex");
    const contextPath = `${stateFile}.context.json`;
    await writeJsonFile(contextPath, { context, token, stateFile, labelsFile: LABELS_FILE, labelMetaFile: LABEL_META_FILE, targetMetaFile: TARGET_META_FILE, leasesFile: LEASES_FILE, taskTabsFile: TASK_TABS_FILE, sessionRegistryFile: SESSION_REGISTRY_FILE, artifactDir: ARTIFACT_DIR });
    const child = spawn(process.execPath, [SCRIPT_PATH, "__daemon", contextPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    await writeJsonFile(stateFile, {
      pid: child.pid,
      version: VERSION,
      runtimeSchema: STATE_SCHEMA_VERSION,
      startedAt: new Date().toISOString(),
      context,
      starting: true,
    }).catch(() => {});
    const ready = await waitForDaemonState(stateFile, daemonStartTimeout(context));
    if (ready) return ready;
    throw new CliError("realbrowser daemon failed to start", {
      code: "daemon_start_failed",
      next: [
        "if Chrome is showing an Allow debugging prompt, approve it and retry; the existing starting daemon will be reused",
        `state: ${stateFile}`,
      ],
    });
  });
}

async function readyDaemonStateFromFile(stateFile, context) {
  const existing = readJson(stateFile);
  if (!existing) return null;
  if (existing.version !== VERSION || existing.runtimeSchema !== STATE_SCHEMA_VERSION) {
    if (processAlive(existing.pid)) await stopDaemonState(existing).catch(() => {});
    await fsp.rm(stateFile, { force: true }).catch(() => {});
    return null;
  }
  if (existing.port && existing.token && processAlive(existing.pid)) {
    try {
      const health = await daemonHealth(existing, 1200);
      if (daemonReadyForContext(health, context)) return existing;
    } catch {}
  }
  if (existing.starting) {
    const ready = await waitForDaemonState(stateFile, daemonStartTimeout(context));
    if (ready?.version === VERSION) return ready;
  }
  return null;
}

async function withDaemonStartLock(stateFile, context, fn) {
  const lockDir = `${stateFile}.lock`;
  const timeoutMs = daemonStartTimeout(context);
  const start = Date.now();
  while (true) {
    try {
      await fsp.mkdir(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ready = await readyDaemonStateFromFile(stateFile, context);
      if (ready) return ready;
      const stat = await fsp.stat(lockDir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > timeoutMs) {
        await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new CliError("timed out waiting for realbrowser daemon start lock", {
          code: "daemon_start_lock_timeout",
          next: [`state: ${stateFile}`, "realbrowser daemon monitor --json"],
        });
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function reusableDaemonForContext(context, preferredStateFile = "") {
  const browserUrl = contextBrowserUrl(context);
  if (!browserUrl) return null;
  for (const file of listStateFiles()) {
    if (file === preferredStateFile) continue;
    const state = readJson(file);
    if (!state || state.version !== VERSION || state.runtimeSchema !== STATE_SCHEMA_VERSION || !processAlive(state.pid)) continue;
    if (!browserEndpointsMatch(contextBrowserUrl(state), browserUrl)) continue;
    try {
      const health = await daemonHealth(state, 1200);
      if (daemonReadyForContext(health, context)) return state;
    } catch {}
  }
  return null;
}

function daemonReadyForContext(health, context = {}) {
  if (health?.ok !== true || health?.cdpReady !== true) return false;
  const browserUrl = contextBrowserUrl(context);
  if (browserUrl && health.browserUrl && !browserEndpointsMatch(health.browserUrl, browserUrl)) return false;
  return true;
}

function daemonStartTimeout(context = {}) {
  const requested = Number(context.flags?.timeout || 0);
  return Math.max(START_TIMEOUT, DAEMON_START_TIMEOUT, Number.isFinite(requested) ? requested : 0);
}

async function waitForDaemonState(stateFile, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const next = readJson(stateFile);
    if (next?.error) {
      throw new CliError(next.error.message || "realbrowser daemon failed to start", {
        code: next.error.code || "daemon_start_failed",
        next: next.error.next || [`state: ${stateFile}`],
      });
    }
    if (next?.port && next?.token && next.version === VERSION && next.runtimeSchema === STATE_SCHEMA_VERSION && processAlive(next.pid)) return next;
    if (next?.pid && !processAlive(next.pid)) return null;
    await sleep(100);
  }
  return null;
}

async function runDaemon(args) {
  const contextPath = args[0];
  if (!contextPath) throw new Error("__daemon requires context path");
  const boot = readJson(contextPath);
  if (!boot) throw new Error(`cannot read daemon context: ${contextPath}`);
  await fsp.rm(contextPath, { force: true }).catch(() => {});
  const daemon = new BrowserDaemon(boot);
  try {
    await writeJsonFile(boot.stateFile, {
      pid: process.pid,
      version: VERSION,
      runtimeSchema: STATE_SCHEMA_VERSION,
      startedAt: new Date().toISOString(),
      context: boot.context,
      starting: true,
    }).catch(() => {});
    await daemon.start();
  } catch (error) {
    await writeJsonFile(boot.stateFile, {
      pid: process.pid,
      version: VERSION,
      runtimeSchema: STATE_SCHEMA_VERSION,
      startedAt: new Date().toISOString(),
      context: boot.context,
      error: {
        code: error.code || "daemon_start_failed",
        message: error.message || String(error),
        next: error.next || [],
      },
    }).catch(() => {});
    throw error;
  }
}

// CLI command groups → BrowserDaemon method dispatcher. One entry per
// top-level group; replaces a 16-line if/else-if chain that drifted as
// new groups were added. To add a new group: register the handler here
// and define the corresponding method on BrowserDaemon.
const DAEMON_GROUP_HANDLERS = {
  tab: (d, command, args, flags) => d.tab(command, args, flags),
  handle: (d, command, args, flags) => d.handle(command, args, flags),
  read: (d, command, args, flags) => d.read(command, args, flags),
  wait: (d, command, args, flags) => d.wait(command, args, flags),
  action: (d, command, args, flags) => d.action(command, args, flags),
  screenshot: (d, command, args, flags) => d.screenshot(command, args, flags),
  console: (d, command, args, flags) => d.console(command, args, flags),
  network: (d, command, args, flags) => d.network(command, args, flags),
  state: (d, command, args, flags) => d.state(command, args, flags),
  dialog: (d, command, args, flags) => d.dialog(command, args, flags),
  perf: (d, command, args, flags) => d.perf(command, args, flags),
  download: (d, command, args, flags) => d.download(command, args, flags),
  export: (d, command, args, flags) => d.export(command, args, flags),
  devtools: (d, command, args, flags) => d.devtools(command, args, flags),
  chain: (d, _command, args, flags) => d.chain(args, flags),
  daemon: (d, command, args, flags) => d.daemon(command, args, flags),
};

class BrowserDaemon {
  constructor(boot) {
    this.boot = boot;
    this.context = boot.context;
    this.token = boot.token;
    this.stateFile = boot.stateFile;
    this.labelsFile = boot.labelsFile || LABELS_FILE;
    this.labelMetaFile = boot.labelMetaFile || LABEL_META_FILE;
    this.targetMetaFile = boot.targetMetaFile || TARGET_META_FILE;
    this.leasesFile = boot.leasesFile || LEASES_FILE;
    this.taskTabsFile = boot.taskTabsFile || TASK_TABS_FILE;
    this.sessionRegistryFile = boot.sessionRegistryFile || SESSION_REGISTRY_FILE;
    this.artifactDir = boot.artifactDir || ARTIFACT_DIR;
    this.cdp = new CDP();
    this.browserUrl = "";
    this.browserWsUrl = "";
    this.sessions = new Map();
    this.consoleBuffers = new Map();
    this.networkBuffers = new Map();
    this.dialogBuffers = new Map();
    this.refStores = new Map();
    this.dialogArms = new Map();
    this.downloadWaiters = new Map();
    this.dispatchQueue = Promise.resolve();
    this.labels = readJson(this.labelsFile) || {};
    this.labelMeta = readJson(this.labelMetaFile) || {};
    this.targetMeta = readJson(this.targetMetaFile) || {};
    this.leases = readJson(this.leasesFile) || {};
    this.taskTabs = readJson(this.taskTabsFile) || {};
    this.sessionRegistry = readJson(this.sessionRegistryFile) || {};
    this.anonymousProcess = null;
    this.anonymousDir = null;
    this.server = null;
  }
  async start() {
    await ensureBaseDirs();
    const endpoint = await resolveEndpoint(await this.ensureBrowserEndpoint());
    this.browserUrl = endpointBrowserUrl(endpoint);
    this.browserWsUrl = endpoint.wsUrl;
    await this.cdp.connect(this.browserWsUrl);
    await this.installTargetLifecycleHooks();
    const token = this.token;
    this.server = http.createServer(async (req, res) => {
      try {
        if (req.headers.authorization !== `Bearer ${token}`) return sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
        if (req.method === "GET" && req.url === "/health") {
          return sendJson(res, 200, await this.healthPayload());
        }
        if (req.method === "POST" && req.url === "/rpc") {
          const body = await readRequestJson(req);
          const result = await this.enqueueDispatch(body.payload);
          return sendJson(res, 200, result);
        }
        return sendJson(res, 404, { error: "not found" });
      } catch (error) {
        return sendJson(res, error.exitCode === 2 ? 400 : 500, {
          error: error.message || String(error),
          code: error.code || "daemon_error",
          exitCode: error.exitCode || 1,
          next: error.next || [],
        });
      }
    });
    const port = await listenLoopback(this.server);
    await writeJsonFile(this.stateFile, {
      pid: process.pid,
      port,
      token,
      version: VERSION,
      runtimeSchema: STATE_SCHEMA_VERSION,
      startedAt: new Date().toISOString(),
      context: this.publicContext(),
      browserUrl: this.browserUrl,
    });
    let idle = setTimeout(() => this.shutdown(), IDLE_TIMEOUT);
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => this.shutdown(), IDLE_TIMEOUT);
    };
    this.server.on("request", resetIdle);
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }
  async ensureBrowserEndpoint() {
    if (this.context.browserUrl) {
      return normalizeEndpoint(this.context.browserUrl);
    }
    if (this.context.kind === "anonymous") {
      return await this.launchAnonymous();
    }
    if (this.context.kind === "profile-launch") {
      return await this.launchProfile();
    }
    throw new Error("daemon context has no browser endpoint");
  }
  async launchAnonymous() {
    const executable = findBrowserExecutable(this.context.flags?.browser);
    if (!executable) {
      throw new CliError("could not find a Chromium-family browser executable for anonymous mode", {
        code: "browser_not_found",
        next: ["install Chrome/Chromium or pass --browser-url"],
      });
    }
    this.anonymousDir = await fsp.mkdtemp(path.join(os.tmpdir(), "realbrowser-anon-"));
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.anonymousDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--window-size=1280,800",
      ...(this.context.incognito ? ["--incognito"] : []),
      ...(this.context.headless ? ["--headless=new", "--disable-gpu"] : []),
      "about:blank",
    ];
    this.anonymousProcess = spawn(executable, args, { detached: true, stdio: "ignore" });
    this.anonymousProcess.unref();
    return await waitForDevtoolsPortFile(path.join(this.anonymousDir, "DevToolsActivePort"), START_TIMEOUT, {
      errorMessage: "anonymous browser did not expose DevToolsActivePort",
      pollMs: 100,
    });
  }
  async launchProfile() {
    const profile = this.context.profile;
    if (!this.context.allowFocusRisk) {
      throw new CliError(`cannot launch profile ${profile.id} without explicit --best-effort-background or --front`, {
        code: "profile_background_launch_guard",
        exitCode: 4,
      });
    }
    const executable = findBrowserExecutable(profile.browser);
    if (!executable) throw new Error(`could not find executable for ${profile.browser}`);
    const port = await findFreePort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--profile-directory=${profile.profileDirName}`,
      "--new-tab",
      "about:blank",
    ];
    if (profile.userDataDir) args.unshift(`--user-data-dir=${profile.userDataDir}`);
    const focusRestore = await captureForegroundAppForBackgroundLaunch({ front: this.context.front });
    // Spawn Chrome/Chromium directly so --user-data-dir and --profile-directory
    // stay attached to this launch even when the app is already running.
    this.anonymousProcess = spawn(executable, args, { detached: true, stdio: "ignore" });
    this.anonymousProcess.unref();
    await restoreForegroundAppAfterBackgroundLaunch(focusRestore, { delayMs: 250 }).catch(() => {});
    const endpoint = await waitForProfileDevtoolsEndpoint(profile, `http://127.0.0.1:${port}`, START_TIMEOUT);
    await restoreForegroundAppAfterBackgroundLaunch(focusRestore, { delayMs: 50 }).catch(() => {});
    return endpoint;
  }
  async launchProfileTab(url, { front = false } = {}) {
    const profile = this.context.profile;
    const executable = findBrowserExecutable(profile.browser);
    if (!executable) throw new Error(`could not find executable for ${profile.browser}`);
    const args = [
      `--profile-directory=${profile.profileDirName}`,
      "--new-tab",
      url,
    ];
    if (profile.userDataDir) args.unshift(`--user-data-dir=${profile.userDataDir}`);
    const focusRestore = await captureForegroundAppForBackgroundLaunch({ front });
    // Spawn the Chrome executable directly. macOS `open --args` can drop or
    // misroute --profile-directory when the app is already running.
    const child = spawn(executable, args, { detached: true, stdio: "ignore" });
    child.unref();
    await restoreForegroundAppAfterBackgroundLaunch(focusRestore, { delayMs: 250 }).catch(() => {});
    return { focusRestore };
  }
  owner() {
    return normalizeOwner(this.context.owner) || "default";
  }
  contextScopeKey() {
    return ownerScopedContextKey(this.context.key, this.owner());
  }
  labelsForContext({ includeLegacy = true, includeCrossOwner = false } = {}) {
    const scoped = this.labels[this.contextScopeKey()] || {};
    let merged = includeLegacy ? { ...(this.labels[this.context.key] || {}), ...scoped } : { ...scoped };
    if (includeCrossOwner) {
      // Fallback: include labels from OTHER owners under the same base context
      // (e.g. profile:chrome:Default). Same-owner labels still win on conflict.
      // Surfaces label-set-in-pane-A from pane-B when TERM_SESSION_ID changed.
      const baseKey = this.context.key;
      const crossOwner = {};
      for (const [storedKey, storedLabels] of Object.entries(this.labels || {})) {
        if (!storedLabels || typeof storedLabels !== "object") continue;
        if (baseContextKeyFromScopedKey(storedKey) !== baseKey) continue;
        for (const [label, targetId] of Object.entries(storedLabels)) {
          if (typeof targetId === "string" && !(label in crossOwner)) crossOwner[label] = targetId;
        }
      }
      merged = { ...crossOwner, ...merged };
    }
    return merged;
  }
  labelMetaForContext({ includeLegacy = true } = {}) {
    const scoped = this.labelMeta[this.contextScopeKey()] || {};
    if (!includeLegacy) return scoped;
    return { ...(this.labelMeta[this.context.key] || {}), ...scoped };
  }
  leaseContextKey() {
    return this.context.key;
  }
  targetMetaForTarget(targetId) {
    return this.targetMeta?.[this.contextScopeKey()]?.[targetId] || this.targetMeta?.[this.context.key]?.[targetId];
  }
  profileProofMetaForTarget(targetId) {
    if (!targetId) return [];
    const baseKey = this.context.key;
    const sameOwnerKey = this.contextScopeKey();
    const matched = Object.keys(this.targetMeta || {}).filter(
      (key) => baseContextKeyFromScopedKey(key) === baseKey,
    );
    const orderedKeys = [
      ...matched.filter((key) => key === sameOwnerKey),
      ...matched.filter((key) => key !== sameOwnerKey && key !== baseKey),
      ...matched.filter((key) => key === baseKey),
    ];
    const out = [];
    for (const key of orderedKeys) {
      const meta = this.targetMeta?.[key]?.[targetId];
      if (meta) out.push(meta);
    }
    return out;
  }
  leasesForContext() {
    return this.leases[this.leaseContextKey()] || {};
  }
  leaseForTarget(targetId) {
    const matches = [];
    const direct = this.leasesForContext()[targetId];
    if (direct) matches.push(direct);
    for (const contextLeases of Object.values(this.leases || {})) {
      if (!contextLeases || typeof contextLeases !== "object") continue;
      const lease = contextLeases[targetId];
      if (!lease) continue;
      if (!lease.browserUrl || !this.browserUrl || browserEndpointsMatch(lease.browserUrl, this.browserUrl)) matches.push(lease);
    }
    return newestLease(matches);
  }
  publicContext() {
    return {
      kind: this.context.kind,
      key: this.context.key,
      owner: this.owner(),
      profile: this.context.profile?.id,
      anonymous: this.context.kind === "anonymous",
      session: this.context.session,
      incognito: Boolean(this.context.incognito),
      browserUrl: this.browserUrl,
      endpointScope: this.context.endpointScope,
    };
  }
  async healthPayload() {
    // v0.3.0 (codex P1 fix): report ok=false when the CDP WebSocket is no
    // longer open. Previously tabs() failures were swallowed and the daemon
    // returned ok=true even after Chrome crashed / the socket closed, causing
    // stale daemons to coexist with live ones (and HTTP timeouts for callers).
    const cdpReady = this.cdp?.ws?.readyState === 1; // WebSocket.OPEN
    const targets = cdpReady ? await this.tabs().catch(() => null) : null;
    const bufferSizes = (map) => Object.fromEntries([...map.entries()].map(([targetId, buffer]) => [targetId.slice(0, MIN_TARGET_PREFIX_LEN), { size: buffer.size, totalAdded: buffer.totalAdded }]));
    return {
      ok: cdpReady && targets !== null,
      cdpReady,
      pid: process.pid,
      version: VERSION,
      runtimeSchema: STATE_SCHEMA_VERSION,
      context: this.publicContext(),
      browserUrl: this.browserUrl,
      targets: (targets || []).map((target) => ({ suggestedTarget: target.suggestedTarget, title: target.title, url: target.url })),
      targetCount: targets?.length ?? 0,
      owner: this.owner(),
      buffers: {
        console: bufferSizes(this.consoleBuffers),
        network: bufferSizes(this.networkBuffers),
        dialog: bufferSizes(this.dialogBuffers),
      },
      sessions: this.sessions.size,
    };
  }
  async installTargetLifecycleHooks() {
    this.cdp.on("Target.targetDestroyed", ({ targetId }) => {
      this.sessions.delete(targetId);
      for (const [key, store] of this.refStores.entries()) {
        if (key.endsWith(`:${targetId}`)) store.stale = true;
      }
      this.releaseTargetLeaseEverywhere(targetId).catch(() => {});
      this.removeTaskTab(targetId).catch(() => {});
    });
    await this.cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
  }
  async dispatch(payload) {
    const previousContext = this.context;
    if (payload.context) {
      this.assertRequestContextCompatible(payload.context);
      this.context = payload.context;
    }
    try {
      this.labels = readJson(this.labelsFile) || {};
      this.labelMeta = readJson(this.labelMetaFile) || {};
      this.targetMeta = readJson(this.targetMetaFile) || {};
      this.leases = readJson(this.leasesFile) || {};
      this.taskTabs = readJson(this.taskTabsFile) || {};
      // v0.3.0 (codex P1 fix): hot-reload session registry too. Parallel
      // daemons sharing the same Chrome instance write the same file, and
      // the constructor-only load left this daemon with stale data.
      this.sessionRegistry = readJson(this.sessionRegistryFile) || {};
      const { group, command, args = [], flags = {} } = payload;
      const handler = DAEMON_GROUP_HANDLERS[group];
      if (!handler) throw usage(`unsupported daemon command: ${group} ${command}`);
      return await handler(this, command, args, flags);
    } finally {
      this.context = previousContext;
    }
  }
  async enqueueDispatch(payload) {
    const run = this.dispatchQueue.then(() => this.dispatch(payload));
    this.dispatchQueue = run.catch(() => {});
    return await run;
  }
  assertRequestContextCompatible(context = {}) {
    const requestBrowserUrl = contextBrowserUrl(context);
    if (!requestBrowserUrl || !this.browserUrl || browserEndpointsMatch(requestBrowserUrl, this.browserUrl)) return;
    throw new CliError("request context does not match daemon browser endpoint", {
      code: "daemon_context_mismatch",
      exitCode: 4,
      next: ["run realbrowser daemon monitor --json and retry with the target context"],
    });
  }
  async findActiveTabsByWindow(tabs) {
    if (!tabs.length) return new Map();
    const visibleByWindow = new Map();
    const probe = async (tab) => {
      let sessionId = this.sessions.get(tab.targetId);
      let weAttached = false;
      try {
        if (!sessionId) {
          const att = await this.cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true }, undefined, 3000);
          sessionId = att.sessionId;
          weAttached = true;
        }
        const visRes = await this.cdp.send("Runtime.evaluate", {
          expression: "document.visibilityState",
          returnByValue: true,
        }, sessionId, 2000);
        if (visRes.result?.value === "visible") {
          const winRes = await this.cdp.send("Browser.getWindowForTarget", { targetId: tab.targetId }, undefined, 2000).catch(() => null);
          const windowId = winRes?.windowId;
          const key = windowId !== undefined ? windowId : "__no_window__";
          if (!visibleByWindow.has(key)) visibleByWindow.set(key, tab.targetId);
        }
      } catch {}
      if (weAttached && sessionId) {
        await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    };
    await Promise.all(tabs.slice(0, 30).map(probe));
    return visibleByWindow;
  }
  async findTabToRestore(visibleByWindow, newTabId) {
    if (!visibleByWindow || !visibleByWindow.size) return null;
    try {
      const winRes = await this.cdp.send("Browser.getWindowForTarget", { targetId: newTabId }, undefined, 2000);
      const windowId = winRes?.windowId;
      if (windowId !== undefined) {
        const candidate = visibleByWindow.get(windowId);
        if (candidate && candidate !== newTabId) return candidate;
      }
    } catch {}
    for (const targetId of visibleByWindow.values()) {
      if (targetId !== newTabId) return targetId;
    }
    return null;
  }
  async tabsRaw() {
    const { targetInfos } = await this.cdp.send("Target.getTargets", {}, undefined, DEFAULT_TIMEOUT);
    return targetInfos
      .filter((target) => target.type === "page")
      .filter((target) => !String(target.url || "").startsWith("devtools://"))
      .map((target) => ({ ...target }));
  }
  async tabs() {
    const raw = await this.tabsRaw();
    // Display labels include cross-owner same-base-context entries so a label
    // set in another terminal pane (different TERM_SESSION_ID) still surfaces in
    // tab list. Mutations (setLabel) still write under the current owner, so
    // session-local label registry behavior is preserved.
    const labelsForContext = this.labelsForContext({ includeCrossOwner: true });
    const targetIds = raw.map((tab) => tab.targetId);
    const prefixLen = getDisplayPrefixLength(targetIds);
    return raw.map((tab) => {
      const label = Object.entries(labelsForContext).find(([, id]) => id === tab.targetId)?.[0];
      const lease = this.leaseForTarget(tab.targetId);
      const targetPrefix = tab.targetId.slice(0, prefixLen);
      const targetMeta = this.targetMetaForTarget(tab.targetId);
      const base = {
        id: `cdp:${targetPrefix}`,
        targetId: tab.targetId,
        targetPrefix,
        label,
        lease,
        suggestedTarget: label || targetPrefix,
        title: tab.title || "",
        url: tab.url || "",
        requestedUrl: targetMeta?.requestedUrl || "",
        attached: Boolean(tab.attached),
        context: this.publicContext(),
      };
      const profileOwned = this.profileTargetProven(base);
      const ownership = this.classifyTabOwnership(base, {});
      const taskRecord = this.taskRecordForTarget(tab.targetId);
      return {
        ...base,
        profileOwned,
        ownership,
        taskId: taskRecord?.taskId || "",
        origin: taskRecord?.origin || canonicalOriginKey(base.url || base.requestedUrl || ""),
        profileOwnership: this.isBrowserScopedProfileContext()
          ? (profileOwned ? "profile-open-proven" : "unproven-browser-scope")
          : "proven",
      };
    });
  }
  taskRecordForTarget(targetId) {
    if (!targetId) return null;
    const baseScope = this.contextScopeKey();
    for (const [scopeKey, origins] of Object.entries(this.taskTabs || {})) {
      if (typeof scopeKey !== "string" || !scopeKey.startsWith(baseScope)) continue;
      if (!origins || typeof origins !== "object") continue;
      for (const record of Object.values(origins)) {
        if (record?.targetId === targetId) return record;
      }
    }
    return null;
  }
  taskId(flags = {}) {
    return resolveTaskId({ ...flags, owner: flags.owner || this.owner() });
  }
  taskTabsScopeKey(flags = {}) {
    return taskRegistryScopeKey(this.contextScopeKey(), this.taskId(flags));
  }
  taskTabsForScope(flags = {}) {
    return this.taskTabs[this.taskTabsScopeKey(flags)] || {};
  }
  async reconcileTaskTabs(flags = {}) {
    const scopeKey = this.taskTabsScopeKey(flags);
    const raw = await this.tabsRaw().catch(() => []);
    const liveById = new Map(raw.map((tab) => [tab.targetId, tab]));
    let changed = false;
    this.taskTabs = await updateJsonFile(this.taskTabsFile, {}, (current) => {
      const data = current || {};
      const scoped = data[scopeKey];
      if (!scoped || typeof scoped !== "object") return data;
      for (const [origin, record] of Object.entries(scoped)) {
        if (!taskTabRecordIsLive(record, liveById)) {
          delete scoped[origin];
          changed = true;
        }
      }
      if (Object.keys(scoped).length === 0) delete data[scopeKey];
      return data;
    });
    return changed;
  }
  async findTaskTabForOrigin(url, flags = {}, tabs = null) {
    await this.reconcileTaskTabs(flags);
    this.taskTabs = readJson(this.taskTabsFile) || {};
    const origin = canonicalOriginKey(url);
    const scoped = this.taskTabsForScope(flags);
    const record = scoped[origin];
    if (!record?.targetId) return null;
    const liveTabs = tabs || await this.tabs();
    const tab = liveTabs.find((candidate) => candidate.targetId === record.targetId);
    if (!tab) return null;
    return {
      origin,
      record,
      tab: {
        ...tab,
        label: record.label || tab.label,
        suggestedTarget: record.label || tab.suggestedTarget,
        ownership: "mine",
        taskId: this.taskId(flags),
      },
    };
  }
  async recordTaskTab(tab, url, label, flags = {}, source = "ensure") {
    if (!tab?.targetId) return null;
    // v0.3.0: every taskTab write also writes a session-registry entry.
    // Cheap, idempotent; gives cross-task/cross-owner reuse for free without
    // any caller change.
    await this.recordSessionTab(tab, url, label, flags, source).catch(() => {});
    const origin = canonicalOriginKey(url || tab.url || tab.requestedUrl || "");
    const scopeKey = this.taskTabsScopeKey(flags);
    const now = new Date().toISOString();
    const taskId = this.taskId(flags);
    const owner = this.owner();
    this.taskTabs = await updateJsonFile(this.taskTabsFile, {}, (current) => {
      const data = current || {};
      data[scopeKey] = data[scopeKey] || {};
      const previous = data[scopeKey][origin] || {};
      data[scopeKey][origin] = {
        ...previous,
        targetId: tab.targetId,
        label: label || tab.label || previous.label || tab.suggestedTarget || "",
        suggestedTarget: label || tab.suggestedTarget || previous.suggestedTarget || "",
        owner,
        taskId,
        origin,
        url: tab.url || url || previous.url || "",
        requestedUrl: url || previous.requestedUrl || "",
        contextKey: this.context.key,
        contextScopeKey: this.contextScopeKey(),
        source,
        status: "active",
        createdBy: "realbrowser",
        createdAt: previous.createdAt || now,
        updatedAt: now,
        secondary: Boolean(flags.forceNew || flags.force_new),
      };
      return data;
    });
    return this.taskTabs[scopeKey]?.[origin] || null;
  }
  async removeTaskTab(targetId, flags = {}) {
    if (!targetId) return;
    this.taskTabs = await updateJsonFile(this.taskTabsFile, {}, (current) => {
      const data = current || {};
      for (const [scopeKey, scoped] of Object.entries(data)) {
        if (!scoped || typeof scoped !== "object") continue;
        for (const [origin, record] of Object.entries(scoped)) {
          if (record?.targetId === targetId) delete scoped[origin];
        }
        if (Object.keys(scoped).length === 0) delete data[scopeKey];
      }
      return data;
    });
    await this.removeSessionTab(targetId).catch(() => {});
  }
  // v0.3.0: session identity is per Chrome instance — stable across nested
  // subagent processes that share the same daemon/Chrome. browserUrl carries
  // a DevTools-assigned UUID per Chrome process; anonymous mode uses the
  // temp-dir path. Falls back to context.key if neither is available (e.g.
  // self-test fakes), so callers always get SOMETHING stable.
  canonicalSessionKey() {
    if (this.context?.anonymous) {
      const dir = this.anonymousDir || this.context?.flags?.anonymousDir;
      if (dir) return `anon:${dir}`;
    }
    const m = String(this.browserUrl || "").match(/\/devtools\/browser\/([0-9a-f-]+)/i);
    if (m) return `cdp:${m[1]}`;
    if (this.browserUrl) return `cdp:${this.browserUrl}`;
    return `ctx:${this.context?.key || "unknown"}`;
  }
  sessionRegistryBucket() {
    const key = this.canonicalSessionKey();
    return { key, bucket: this.sessionRegistry?.[key] || { tabs: {}, labels: {} } };
  }
  sessionRecordForTarget(targetId) {
    if (!targetId) return null;
    const { bucket } = this.sessionRegistryBucket();
    for (const record of Object.values(bucket.tabs || {})) {
      if (record?.targetId === targetId) return record;
    }
    return null;
  }
  async reconcileSessionRegistry() {
    const { key: sessionKey } = this.sessionRegistryBucket();
    const raw = await this.tabsRaw().catch(() => []);
    const liveById = new Map(raw.map((tab) => [tab.targetId, tab]));
    this.sessionRegistry = await updateJsonFile(this.sessionRegistryFile, {}, (current) => {
      const data = current || {};
      const bucket = data[sessionKey];
      if (!bucket || typeof bucket !== "object") return data;
      const tabs = bucket.tabs || {};
      for (const [origin, record] of Object.entries(tabs)) {
        if (!record?.targetId || !liveById.has(record.targetId)) delete tabs[origin];
      }
      const labels = bucket.labels || {};
      for (const [label, targetId] of Object.entries(labels)) {
        if (!targetId || !liveById.has(targetId)) delete labels[label];
      }
      bucket.tabs = tabs;
      bucket.labels = labels;
      if (Object.keys(tabs).length === 0 && Object.keys(labels).length === 0) delete data[sessionKey];
      return data;
    });
  }
  // Codex review: reuse only realbrowser-owned tabs in the same session, not
  // arbitrary user tabs. Same-origin match + non-user ownership + recorded in
  // session registry = safe cross-task reuse. Returns null if not found OR if
  // the recorded tab is no longer live.
  async findSessionTabForOrigin(url, flags = {}, tabs = null) {
    await this.reconcileSessionRegistry();
    const { key: sessionKey } = this.sessionRegistryBucket();
    const origin = canonicalOriginKey(url);
    const bucket = this.sessionRegistry?.[sessionKey] || {};
    const record = bucket.tabs?.[origin];
    if (!record?.targetId) return null;
    const liveTabs = tabs || await this.tabs();
    const tab = liveTabs.find((c) => c.targetId === record.targetId);
    if (!tab) return null;
    return {
      origin,
      record,
      tab: {
        ...tab,
        label: record.label || tab.label,
        suggestedTarget: record.label || tab.suggestedTarget,
        // v0.3.0 (codex P0 fix): accurate ownership for output. The
        // immediately-following recordTaskTab in the reuse code path turns
        // this into "mine" for the current task — but until that write
        // lands, the tab still belongs to a sibling task. Report honestly.
        ownership: "session-shareable",
        taskId: record.taskId || this.taskId(flags),
      },
    };
  }
  async recordSessionTab(tab, url, label, flags = {}, source = "ensure") {
    if (!tab?.targetId) return null;
    const origin = canonicalOriginKey(url || tab.url || tab.requestedUrl || "");
    const { key: sessionKey } = this.sessionRegistryBucket();
    const now = new Date().toISOString();
    const taskId = this.taskId(flags);
    const owner = this.owner();
    this.sessionRegistry = await updateJsonFile(this.sessionRegistryFile, {}, (current) => {
      const data = current || {};
      data[sessionKey] = data[sessionKey] || { tabs: {}, labels: {} };
      const bucket = data[sessionKey];
      bucket.tabs = bucket.tabs || {};
      bucket.labels = bucket.labels || {};
      const prev = bucket.tabs[origin] || {};
      const incomingSource = source || "";
      const nextSource = trustedProfileSource(prev.source)
        ? (trustedProfileSource(incomingSource) ? incomingSource : prev.source)
        : (incomingSource || prev.source || "");
      bucket.tabs[origin] = {
        ...prev,
        targetId: tab.targetId,
        label: label || prev.label || "",
        origin,
        sessionKey,
        contextScopeKey: this.contextScopeKey(),
        contextKey: this.context.key,
        owner,
        taskId,
        pid: process.pid,
        url: tab.url || url || prev.url || "",
        requestedUrl: url || prev.requestedUrl || "",
        source: nextSource,
        status: "active",
        createdAt: prev.createdAt || now,
        updatedAt: now,
      };
      if (label) bucket.labels[label] = tab.targetId;
      return data;
    });
    return this.sessionRegistry[sessionKey]?.tabs?.[origin] || null;
  }
  async removeSessionTab(targetId) {
    if (!targetId) return;
    this.sessionRegistry = await updateJsonFile(this.sessionRegistryFile, {}, (current) => {
      const data = current || {};
      for (const [sessionKey, bucket] of Object.entries(data)) {
        if (!bucket || typeof bucket !== "object") continue;
        const tabs = bucket.tabs || {};
        for (const [origin, record] of Object.entries(tabs)) {
          if (record?.targetId === targetId) delete tabs[origin];
        }
        const labels = bucket.labels || {};
        for (const [label, tid] of Object.entries(labels)) {
          if (tid === targetId) delete labels[label];
        }
        if (Object.keys(tabs).length === 0 && Object.keys(labels).length === 0) delete data[sessionKey];
      }
      return data;
    });
  }
  // Session-wide label lookup. Returns targetId of the existing holder (if
  // any), null otherwise. Used to detect cross-task `--label X` collisions
  // BEFORE the script silently allows an `X2` invention from the caller.
  sessionLabelHolder(label) {
    if (!label) return null;
    const { bucket } = this.sessionRegistryBucket();
    return bucket?.labels?.[label] || null;
  }
  classifyTabOwnership(tab, flags = {}) {
    if (!tab?.targetId) return "user";
    const taskId = this.taskId(flags);
    const baseScope = this.contextScopeKey();
    for (const [scopeKey, origins] of Object.entries(this.taskTabs || {})) {
      if (typeof scopeKey !== "string" || !scopeKey.startsWith(baseScope)) continue;
      if (!origins || typeof origins !== "object") continue;
      for (const record of Object.values(origins)) {
        if (record?.targetId !== tab.targetId) continue;
        if (record.owner === this.owner() && record.taskId === taskId) return "mine";
        if (record.owner === this.owner()) return "my-other-task";
        return "other-agent";
      }
    }
    // v0.3.0 (codex P0 fix): session-registry hits are REUSABLE but NOT "mine".
    // A sibling task's recorded tab can be reused via `tab ensure`, but
    // `tab close --mine` / `tab done --close` MUST NOT close it — that's the
    // sibling's tab to close. Return "session-shareable" so:
    //  - reuse path (tab ensure) treats != "user" as eligible (existing logic)
    //  - close-mine path filters strictly to ownership === "mine"
    const { bucket } = this.sessionRegistryBucket();
    for (const record of Object.values(bucket?.tabs || {})) {
      if (record?.targetId === tab.targetId) return "session-shareable";
    }
    if (this.leaseForTarget?.(tab.targetId)?.owner) return "leased";
    return "user";
  }
  async assertAgentOwnedForMutation(tab, flags = {}, operation = "mutation") {
    const ownership = this.classifyTabOwnership(tab, flags);
    if (ownership === "mine") return;
    if (flags.takeLease || flags.force || flags.allowUserTabMutation) return;
    const handle = tab.suggestedTarget || tab.label || (tab.targetId || "").slice(0, MIN_TARGET_PREFIX_LEN);
    throw new CliError(`${operation} refused: tab ${handle} is not owned by this realbrowser task (ownership=${ownership})`, {
      code: "user_tab_mutation_refused",
      exitCode: 5,
      ownership,
      next: [
        `realbrowser tab ensure ${tab.url || "<url>"} --label ${flags.label || "app"} --background`,
        `realbrowser tab select ${handle} --take-lease --label ${flags.label || "app"}`,
        `realbrowser tab list --mine`,
      ],
    });
  }
  isBrowserScopedProfileContext() {
    return this.context.kind === "profile" && this.context.profile && this.context.endpointScope === "browser";
  }
  labelForTarget(tab) {
    const labelsForContext = this.labelsForContext();
    return Object.entries(labelsForContext).find(([, id]) => id === tab.targetId)?.[0] || "";
  }
  // Browser-scoped CDP serves multiple Chrome profiles through one endpoint.
  // Without browserContextId, Target.createTarget opens the new tab in whichever
  // profile is currently focused — which may not be the one the user requested
  // via --profile. Find a live tab whose targetMeta we PROVED belongs to the
  // requested profile (only source=profile-open or cdp-create-with-context are
  // trustworthy: those came from Chrome's --profile-directory at OS level or
  // from Target.createTarget called with a known-correct browserContextId) and
  // reuse its browserContextId. Cross-owner same-base-context fallback rescues
  // terminal-pane / multi-session use where TERM_SESSION_ID-derived owner has
  // changed between calls.
  //
  // We deliberately do NOT trust user-set labels or older
  // "browser-scope-cdp-create" entries here: under multi-profile Chrome, labels
  // and pre-0.3.0 cdp-create entries can point to tabs in any profile (the
  // user can label any tab they happen to select; pre-0.3.0 cdp-create lied
  // about ownership). Using them as a context anchor would silently land new
  // tabs in the wrong profile — exactly the bug 0.3.0 was meant to fix.
  //
  // Returns null when no live trusted tab matches. The caller may try a verified
  // background probe, but must not OS-launch an already-running browser-scoped
  // Chrome profile just to bootstrap. OpenClaw's "managed" profiles sidestep
  // this by dedicating one Chrome process per profile; attached Chrome can't.
  async resolveBrowserContextIdForProfile(profileId) {
    if (!profileId) return null;
    const raw = await this.tabsRaw().catch(() => []);
    const liveById = new Map(raw.map((tab) => [tab.targetId, tab]));
    const baseKey = this.context.key;
    const sameOwnerKey = this.contextScopeKey();
    // Iterate keys in priority order: same-owner first, then cross-owner under
    // the same base context, then the legacy unscoped key (pre-owner-scoping).
    const matched = Object.keys(this.targetMeta || {}).filter(
      (k) => baseContextKeyFromScopedKey(k) === baseKey,
    );
    const orderedKeys = [
      ...matched.filter((k) => k === sameOwnerKey),
      ...matched.filter((k) => k !== sameOwnerKey && k !== baseKey),
      ...matched.filter((k) => k === baseKey),
    ];
    for (const storedKey of orderedKeys) {
      const store = this.targetMeta?.[storedKey];
      if (!store || typeof store !== "object") continue;
      for (const [targetId, meta] of Object.entries(store)) {
        if (!meta || meta.profile !== profileId || meta.profileOwned !== true) continue;
        if (!trustedProfileSource(meta.source)) continue;
        const live = liveById.get(targetId);
        if (live?.browserContextId) return live.browserContextId;
      }
    }
    return null;
  }
  // Enumerate distinct live browser-context IDs visible to the current CDP
  // endpoint. Browser-scoped CDP (one endpoint, multiple profiles) returns
  // multiple distinct browserContextId values — one per profile. Profile-
  // scoped CDP (the OpenClaw-managed shape) returns exactly one context.
  //
  // Returns a Set of strings. The "default" context can appear as an empty
  // string for some Chrome builds; we filter those out so the size reflects
  // distinct named contexts. Used by the tab-ensure profile branch to
  // detect multi-profile ambiguity before falling back to default-context
  // creation (which would land in the currently-active profile, not the
  // requested one).
  async enumerateLiveBrowserContexts() {
    const contexts = new Set();
    // Prefer Target.getBrowserContexts when available — explicit list of
    // currently-allocated contexts, independent of whether any page targets
    // exist in them yet.
    try {
      const result = await this.cdp.send("Target.getBrowserContexts", {}, undefined, 2000).catch(() => null);
      if (result && Array.isArray(result.browserContextIds)) {
        for (const id of result.browserContextIds) {
          if (typeof id === "string" && id.length > 0) contexts.add(id);
        }
      }
    } catch {}
    // Always also union with browserContextIds visible on live page targets
    // (Target.getTargets). Some Chrome versions omit the "default" context
    // from Target.getBrowserContexts but it shows up here.
    const raw = await this.tabsRaw().catch(() => []);
    for (const tab of raw) {
      if (typeof tab.browserContextId === "string" && tab.browserContextId.length > 0) {
        contexts.add(tab.browserContextId);
      }
    }
    return contexts;
  }
  async browserContextCandidates(exclude = new Set()) {
    const counts = new Map();
    try {
      const result = await this.cdp.send("Target.getBrowserContexts", {}, undefined, 2000).catch(() => null);
      if (result && Array.isArray(result.browserContextIds)) {
        for (const id of result.browserContextIds) {
          if (typeof id === "string" && id.length > 0 && !exclude.has(id)) counts.set(id, 0);
        }
      }
    } catch {}
    const rawTabs = await this.tabsRaw().catch(() => []);
    for (const tab of rawTabs) {
      const bcid = tab.browserContextId;
      if (typeof bcid !== "string" || bcid.length === 0 || exclude.has(bcid)) continue;
      const tabUrl = tab.url || "";
      if (tabUrl.startsWith("devtools://") || tabUrl.startsWith("chrome-extension://")) continue;
      counts.set(bcid, (counts.get(bcid) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([bcid]) => bcid);
  }
  async discoverBrowserContextIdForProfile(profileId, expectedDir, exclude = new Set()) {
    if (!profileId || !expectedDir || !this.isBrowserScopedProfileContext()) return null;
    const candidates = await this.browserContextCandidates(exclude);
    const checked = [];
    for (const bcid of candidates) {
      let targetId = null;
      try {
        const created = await this.cdp.send("Target.createTarget", {
          url: "chrome://version/",
          background: true,
          focus: false,
          browserContextId: bcid,
        }, undefined, 5000);
        targetId = created?.targetId || null;
        if (!targetId) continue;
        await waitForUrl(this, targetId, "chrome://version", 2500).catch(() => {});
        await waitForReadyState(this, targetId, "interactive", 2500).catch(() => {});
        const actualDir = await this.readTargetProfileDir(targetId, 2500);
        checked.push({ browserContextId: bcid, profileDir: actualDir || "" });
        if (actualDir === expectedDir) {
          return { browserContextId: bcid, profileDir: actualDir, checked };
        }
      } catch (err) {
        checked.push({ browserContextId: bcid, error: err?.message || String(err) });
      } finally {
        if (targetId) await this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    }
    return { browserContextId: null, checked };
  }
  profileTargetProven(tab) {
    if (!this.isBrowserScopedProfileContext()) return true;
    for (const targetMeta of this.profileProofMetaForTarget(tab.targetId)) {
      if (
        targetMeta &&
        targetMeta.profileOwned === true &&
        targetMeta.profile === this.context.profile.id &&
        trustedProfileSource(targetMeta.source)
      ) return true;
    }
    const sessionRecord = this.sessionRecordForTarget(tab.targetId);
    if (
      sessionRecord &&
      sessionRecord.contextKey === this.context.key &&
      trustedProfileSource(sessionRecord.source)
    ) return true;
    const label = tab.label || this.labelForTarget(tab);
    if (!label) return false;
    const meta = this.labelMetaForContext()[label];
    return Boolean(
      meta &&
      meta.targetId === tab.targetId &&
      meta.profileOwned === true &&
      meta.profile === this.context.profile.id &&
      trustedProfileSource(meta.source)
    );
  }
  unprovenProfileTargetError(tab, operation = "target") {
    const profile = this.context.profile?.id || "profile";
    return new CliError(`${operation} refused: target profile ownership is not proven for ${profile}`, {
      code: "profile_target_unproven",
      exitCode: 4,
      next: [
        `The current CDP endpoint is browser-scoped and may list tabs from other Chrome profiles.`,
        `Open a new tab through the requested profile instead: realbrowser tab new <url> --profile "${profile}" --label app --background`,
        `Use --browser-url ${this.browserUrl || "<endpoint>"} only for intentional browser-wide debugging.`,
        `Use --allow-browser-scope-target only when you explicitly accept cross-profile target risk.`,
      ],
    });
  }
  assertProfileTargetProven(tab, flags = {}, operation = "target") {
    if (!this.isBrowserScopedProfileContext()) return;
    if (flags.allowBrowserScopeTarget) return;
    if (this.profileTargetProven(tab)) return;
    throw this.unprovenProfileTargetError(tab, operation);
  }
  async resolveTargetForOperation(ref, flags = {}, operation = "target", options = {}) {
    return await this.resolveTarget(ref, {
      ...options,
      allowUnprovenProfileTarget: Boolean(flags.allowBrowserScopeTarget),
      operation,
    });
  }
  async resolveTarget(ref, { allowQuery = false, allowUnprovenProfileTarget = false, operation = "target" } = {}) {
    const tabs = await this.tabs();
    const labelsForContext = this.labelsForContext();
    const raw = String(ref || "").replace(/^label:/, "").replace(/^cdp:/, "");
    if (!raw) throw new CliError("target is required", { code: "target_required", exitCode: 3 });
    const labelId = labelsForContext[raw];
    if (labelId) {
      const tab = tabs.find((candidate) => candidate.targetId === labelId);
      if (tab) {
        if (!allowUnprovenProfileTarget && !this.profileTargetProven(tab)) throw this.unprovenProfileTargetError(tab, operation);
        return tab;
      }
      // Same-owner label points to a dead/closed tab. Try cross-owner fallback
      // before declaring stale — another pane may have an alive labeling.
    }
    // Cross-owner label fallback: same base context (e.g. profile:chrome:Default)
    // but a different owner stored the label. Only used when the same-owner
    // lookup did not return a live tab. Rescues terminal-pane / multi-session use.
    const crossLabels = this.labelsForContext({ includeCrossOwner: true });
    const crossLabelId = crossLabels[raw];
    if (crossLabelId && crossLabelId !== labelId) {
      const tab = tabs.find((candidate) => candidate.targetId === crossLabelId);
      if (tab) {
        if (!allowUnprovenProfileTarget && !this.profileTargetProven(tab)) throw this.unprovenProfileTargetError(tab, operation);
        return tab;
      }
    }
    if (labelId) {
      throw new CliError(`target label "${raw}" is stale`, { code: "target_stale", exitCode: 3, next: ["realbrowser tab list"] });
    }
    if (crossLabelId) {
      // Cross-owner label exists but points to a dead tab — surface this
      // explicitly rather than falling through to the generic not-found path.
      throw new CliError(`target label "${raw}" is stale (resolved across owners; the underlying tab was closed)`, {
        code: "target_stale",
        exitCode: 3,
        next: ["realbrowser tab list", `realbrowser tab ensure <url> --label ${raw}`],
      });
    }
    const exact = tabs.find((tab) => tab.targetId === raw || tab.targetPrefix === raw || tab.id === ref || tab.suggestedTarget === raw);
    if (exact) {
      if (!allowUnprovenProfileTarget && !this.profileTargetProven(exact)) throw this.unprovenProfileTargetError(exact, operation);
      return exact;
    }
    const prefixMatches = tabs.filter((tab) => tab.targetId.toUpperCase().startsWith(raw.toUpperCase()));
    if (prefixMatches.length === 1) {
      if (!allowUnprovenProfileTarget && !this.profileTargetProven(prefixMatches[0])) throw this.unprovenProfileTargetError(prefixMatches[0], operation);
      return prefixMatches[0];
    }
    if (prefixMatches.length > 1) throw ambiguousTarget(raw, prefixMatches);
    if (allowQuery) {
      const matches = tabs.filter((tab) => `${tab.label || ""} ${tab.title || ""} ${tab.url || ""}`.toLowerCase().includes(raw.toLowerCase()));
      if (matches.length === 1) {
        if (!allowUnprovenProfileTarget && !this.profileTargetProven(matches[0])) throw this.unprovenProfileTargetError(matches[0], operation);
        return matches[0];
      }
      if (matches.length > 1) throw ambiguousTarget(raw, matches);
    }
    throw new CliError(`target not found: ${ref}`, { code: "target_not_found", exitCode: 3, next: ["realbrowser tab list"] });
  }
  async setTargetMeta(targetId, meta = {}) {
    if (!targetId) return;
    const scopeKey = this.contextScopeKey();
    this.targetMeta = await updateJsonFile(this.targetMetaFile, {}, (current) => {
      current[scopeKey] ??= {};
      const previous = current[scopeKey][targetId] || {};
      // Preserve trusted source so resolveBrowserContextIdForProfile keeps
      // working after subsequent navigate/label/reuse calls. Only allow
      // the source to be overwritten when the new source is itself trusted.
      const incomingSource = meta.source || "";
      const nextSource = trustedProfileSource(previous.source)
        ? (trustedProfileSource(incomingSource) ? incomingSource : previous.source)
        : (incomingSource || previous.source || "");
      // v0.3.0: profileOwned is monotonic. A tab's profile is fixed by Chrome
      // at create-time — once we verified ownership (chrome://version or
      // launch-through-named-profile), that proof should not be downgraded by
      // a subsequent navigate / reuse / label call whose profileTargetProven
      // happens to return false due to label-cache miss or context shift.
      const nextProfileOwned = previous.profileOwned === true ? true : Boolean(meta.profileOwned);
      current[scopeKey][targetId] = {
        ...previous,
        targetId,
        profileOwned: nextProfileOwned,
        profile: meta.profile || previous.profile || this.context.profile?.id,
        source: nextSource,
        requestedUrl: meta.requestedUrl !== undefined ? meta.requestedUrl : previous.requestedUrl,
        updatedAt: new Date().toISOString(),
      };
      return current;
    });
  }
  async setLabel(label, targetId, meta = {}) {
    if (!label) return;
    const existing = this.labelsForContext()[label];
    if (existing && existing !== targetId && !meta.force) {
      throw new CliError(`label already exists: ${label}`, {
        code: "label_exists",
        exitCode: 2,
        next: [`realbrowser tab label <target> ${label} --force`],
      });
    }
    const scopeKey = this.contextScopeKey();
    this.labels = await updateJsonFile(this.labelsFile, {}, (current) => {
      const lockedExisting = current[scopeKey]?.[label] || current[this.context.key]?.[label];
      if (lockedExisting && lockedExisting !== targetId && !meta.force) {
        throw new CliError(`label already exists: ${label}`, {
          code: "label_exists",
          exitCode: 2,
          next: [`realbrowser tab label <target> ${label} --force`],
        });
      }
      current[scopeKey] ??= {};
      current[scopeKey][label] = targetId;
      return current;
    });
    this.labelMeta = await updateJsonFile(this.labelMetaFile, {}, (current) => {
      current[scopeKey] ??= {};
      const previous = current[scopeKey][label];
      // v0.3.0: profileOwned is monotonic — same reasoning as setTargetMeta.
      // Once a label was set on a verified target, navigate/reuse-cycle
      // updates should not be able to flip it back to unproven.
      const nextProfileOwned = previous?.profileOwned === true && previous?.targetId === targetId
        ? true
        : Boolean(meta.profileOwned);
      const incomingSource = meta.source || "";
      const nextSource = trustedProfileSource(previous?.source)
        ? (trustedProfileSource(incomingSource) ? incomingSource : previous.source)
        : (incomingSource || previous?.source || "");
      current[scopeKey][label] = {
        targetId,
        profileOwned: nextProfileOwned,
        profile: meta.profile || previous?.profile || this.context.profile?.id,
        owner: this.owner(),
        source: nextSource,
        updatedAt: new Date().toISOString(),
      };
      return current;
    });
    // setTargetMeta enforces monotonic profileOwned, so always propagating is
    // safe: an existing `true` cannot be downgraded by a fresh setLabel with
    // a transient `profileOwned: false`.
    await this.setTargetMeta(targetId, meta);
    await this.claimTarget({ targetId, label, suggestedTarget: label, url: meta.url || "" }, meta, meta.source || "label");
  }
  leaseIsStale(lease) {
    if (!lease) return true;
    const timestamp = Date.parse(lease.updatedAt || lease.lastUsedAt || lease.createdAt || "");
    if (!Number.isFinite(timestamp)) return true;
    return Date.now() - timestamp > LEASE_STALE_MS;
  }
  targetLeaseConflict(tab, lease, operation) {
    return new CliError(`${operation} refused: target is leased by owner ${lease.owner}`, {
      code: "target_lease_conflict",
      exitCode: 5,
      next: [
        `current owner: ${this.owner()}`,
        "rerun with --take-lease only when intentionally taking this tab",
        "use --owner <id> or REALBROWSER_OWNER=<id> to keep related Codex sessions in the same namespace",
        "use realbrowser tab list --json to inspect target leases",
      ],
    });
  }
  async assertTargetLease(tab, flags = {}, operation = "target") {
    const lease = this.leaseForTarget(tab.targetId);
    if (!lease || lease.owner === this.owner() || flags.force || this.leaseIsStale(lease)) {
      await this.claimTarget(tab, flags, operation);
      return;
    }
    if (flags.takeLease) {
      await this.claimTarget(tab, flags, operation);
      return;
    }
    throw this.targetLeaseConflict(tab, lease, operation);
  }
  targetLeaseWouldConflict(tab, flags = {}) {
    const lease = this.leaseForTarget(tab.targetId);
    return Boolean(lease && lease.owner !== this.owner() && !flags.force && !flags.takeLease && !this.leaseIsStale(lease));
  }
  async claimTarget(tab, flags = {}, source = "claim") {
    if (!tab?.targetId) return null;
    const scopeKey = this.contextScopeKey();
    const leaseKey = this.leaseContextKey();
    const owner = this.owner();
    const now = new Date().toISOString();
    const existing = this.leaseForTarget(tab.targetId);
    if (existing && existing.owner !== owner && !flags.force && !flags.takeLease && !this.leaseIsStale(existing)) {
      return existing;
    }
    this.leases = await updateJsonFile(this.leasesFile, {}, (current) => {
      const matches = [];
      if (current[leaseKey]?.[tab.targetId]) matches.push(current[leaseKey][tab.targetId]);
      for (const contextLeases of Object.values(current || {})) {
        const candidate = contextLeases?.[tab.targetId];
        if (!candidate) continue;
        if (!candidate.browserUrl || !this.browserUrl || browserEndpointsMatch(candidate.browserUrl, this.browserUrl)) matches.push(candidate);
      }
      const previous = newestLease(matches) || {};
      if (previous.owner && previous.owner !== owner && !flags.force && !flags.takeLease && !this.leaseIsStale(previous)) {
        throw this.targetLeaseConflict(tab, previous, source);
      }
      for (const contextLeases of Object.values(current || {})) {
        if (contextLeases && typeof contextLeases === "object") delete contextLeases[tab.targetId];
      }
      current[leaseKey] ??= {};
      current[leaseKey][tab.targetId] = {
        ...previous,
        targetId: tab.targetId,
        owner,
        browserUrl: this.browserUrl,
        contextKey: this.context.key,
        contextScopeKey: scopeKey,
        label: tab.label || previous.label || "",
        suggestedTarget: tab.suggestedTarget || tab.label || previous.suggestedTarget || "",
        title: tab.title || previous.title || "",
        url: tab.url || previous.url || "",
        source,
        createdAt: previous.createdAt || now,
        updatedAt: now,
        lastUsedAt: now,
      };
      return current;
    });
    return this.leaseForTarget(tab.targetId);
  }
  async releaseTargetLease(targetId) {
    if (!targetId) return;
    this.leases = await updateJsonFile(this.leasesFile, {}, (current) => {
      const leaseKey = this.leaseContextKey();
      if (current[leaseKey]) delete current[leaseKey][targetId];
      return current;
    });
  }
  async releaseTargetLeaseEverywhere(targetId) {
    if (!targetId) return;
    this.leases = await updateJsonFile(this.leasesFile, {}, (current) => {
      for (const value of Object.values(current || {})) {
        if (value && typeof value === "object") delete value[targetId];
      }
      return current;
    });
  }
  async attach(targetId) {
    if (this.sessions.has(targetId)) return this.sessions.get(targetId);
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessions.set(targetId, sessionId);
    await Promise.all([
      this.cdp.send("Runtime.enable", {}, sessionId).catch(() => {}),
      this.cdp.send("Page.enable", {}, sessionId).catch(() => {}),
      this.cdp.send("DOM.enable", {}, sessionId).catch(() => {}),
      this.cdp.send("Network.enable", {}, sessionId).catch(() => {}),
      this.cdp.send("Accessibility.enable", {}, sessionId).catch(() => {}),
      // Auto-enable focus emulation so SPAs gating on document.hasFocus()
      // fire their submit/click handlers correctly when the tab is in OS
      // background — eliminates the need for `tab focus --front`, which
      // would steal keyboard focus from the user's other apps. Common
      // pattern: booking/checkout pages that defer form submission until
      // the tab regains focus. Opt out: REALBROWSER_DISABLE_FOCUS_EMULATION=1.
      process.env.REALBROWSER_DISABLE_FOCUS_EMULATION
        ? Promise.resolve()
        : this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {}),
    ]);
    this.cdp.on("Runtime.consoleAPICalled", (params, message) => {
      if (message.sessionId !== sessionId) return;
      this.consoleBuffer(targetId).push(normalizeConsoleEvent(params));
    });
    this.cdp.on("Runtime.exceptionThrown", (params, message) => {
      if (message.sessionId !== sessionId) return;
      this.consoleBuffer(targetId).push(normalizeExceptionEvent(params));
    });
    this.cdp.on("Network.requestWillBeSent", (params, message) => {
      if (message.sessionId !== sessionId) return;
      this.recordNetwork(targetId, "request", params);
    });
    this.cdp.on("Network.responseReceived", (params, message) => {
      if (message.sessionId !== sessionId) return;
      this.recordNetwork(targetId, "response", params);
    });
    this.cdp.on("Network.loadingFinished", (params, message) => {
      if (message.sessionId !== sessionId) return;
      this.recordNetwork(targetId, "finished", params);
    });
    this.cdp.on("Network.loadingFailed", (params, message) => {
      if (message.sessionId !== sessionId) return;
      this.recordNetwork(targetId, "failed", params);
    });
    this.cdp.on("Page.javascriptDialogOpening", async (params, message) => {
      if (message.sessionId !== sessionId) return;
      const arm = this.dialogArms.get(targetId) || { action: "accept" };
      this.dialogBuffer(targetId).push({
        id: `dlg_${Date.now()}`,
        timestamp: Date.now(),
        type: params.type,
        message: params.message,
        defaultPrompt: params.defaultPrompt,
        action: arm.action,
      });
      await this.cdp.send("Page.handleJavaScriptDialog", {
        accept: arm.action !== "dismiss",
        promptText: arm.text || undefined,
      }, sessionId).catch(() => {});
      this.dialogArms.delete(targetId);
    });
    return sessionId;
  }
  consoleBuffer(targetId) {
    if (!this.consoleBuffers.has(targetId)) this.consoleBuffers.set(targetId, new CircularBuffer(BUFFER_LIMIT));
    return this.consoleBuffers.get(targetId);
  }
  networkBuffer(targetId) {
    if (!this.networkBuffers.has(targetId)) this.networkBuffers.set(targetId, new CircularBuffer(BUFFER_LIMIT));
    return this.networkBuffers.get(targetId);
  }
  dialogBuffer(targetId) {
    if (!this.dialogBuffers.has(targetId)) this.dialogBuffers.set(targetId, new CircularBuffer(BUFFER_LIMIT));
    return this.dialogBuffers.get(targetId);
  }
  async sendToTarget(targetId, method, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
    const sessionId = await this.attach(targetId);
    return await this.cdp.send(method, params, sessionId, timeoutMs);
  }
  // v0.3.0: read chrome://version's "Profile Path:" to identify which Chrome
  // profile a target actually lives in. Some Chrome/Chromium builds with
  // multiple profiles and a browser-scoped CDP endpoint can ignore
  // --profile-directory when the app is already running: new tabs route to the
  // current browser context, not necessarily the one requested.
  // chrome://version's Profile Path line is the definitive answer; no deps.
  async readTargetProfileDir(targetId, timeoutMs = 8000) {
    // chrome://version can render Profile Path as a table cell or as
    // label/value text split across lines. Only accept path-like values; broad
    // regex matching can otherwise capture unrelated version/variation text.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(targetId,
          `(()=>{
            const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
            const pathLike = (value) => /^([A-Za-z]:[\\\\/]|\\\\\\\\|\\/)/.test(clean(value));
            const fromCell = document.querySelector("#profile_path,#profile-path");
            if (fromCell && pathLike(fromCell.textContent)) return clean(fromCell.textContent);
            for (const row of document.querySelectorAll("tr")) {
              const cells = [...row.children].map((cell) => clean(cell.textContent));
              if (cells.length >= 2 && /^Profile Path:?$/i.test(cells[0]) && pathLike(cells.slice(1).join(" "))) {
                return cells.slice(1).join(" ");
              }
            }
            const lines = String(document.body?.innerText || "").split(/[\\n\\r]+/).map(clean).filter(Boolean);
            for (let i = 0; i < lines.length; i += 1) {
              const inline = lines[i].match(/^Profile Path:?\\s+(.+)$/i);
              if (inline && pathLike(inline[1])) return clean(inline[1]);
              if (/^Profile Path:?$/i.test(lines[i]) && pathLike(lines[i + 1])) return clean(lines[i + 1]);
            }
            return null;
          })()`,
          { timeoutMs: 2000 });
        if (typeof value === "string" && value.length > 0) {
          return path.basename(value);
        }
      } catch {}
      await sleep(200);
    }
    return null;
  }
  async verifyTargetProfile(targetId, expectedDir, intendedUrl, options = {}) {
    if (!expectedDir) return null;
    const strict = Boolean(options.strict);
    const profileId = options.profileId || `chrome:${expectedDir}`;
    const failUnverified = async (reason) => {
      await this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw new CliError(`could not verify profile routing for ${profileId}: ${reason}`, {
        code: "profile_verification_unavailable",
        exitCode: 4,
        next: [
          `closed the unverified tab before navigating to ${intendedUrl || "the requested URL"}`,
          "profile verification requires reading chrome://version Profile Path; it was unavailable before timeout",
          `realbrowser tab list --profile "${profileId}"`,
          `realbrowser tab ensure ${intendedUrl || "<url>"} --profile "${profileId}" --label app --front`,
        ],
      });
    };
    const session = await this.attach(targetId).catch(() => null);
    if (!session) {
      if (strict) await failUnverified("could not attach to the created target");
      return null;
    }
    // Navigate to chrome://version, read Profile Path, then navigate to intended URL.
    const probeNavigated = await this.cdp.send("Page.navigate", { url: "chrome://version/" }, session).then(() => true).catch(() => false);
    if (strict && !probeNavigated) {
      await failUnverified("could not navigate the created target to chrome://version");
    }
    await waitForUrl(this, targetId, "chrome://version", 5000).catch(() => {});
    await waitForReadyState(this, targetId, "interactive", 5000).catch(() => {});
    const actualDir = await this.readTargetProfileDir(targetId, 6000);
    if (actualDir && actualDir !== expectedDir) {
      await this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw new CliError(`tab routing failed: requested chrome:${expectedDir} but tab landed in chrome:${actualDir}`, {
        code: "profile_routing_failed",
        exitCode: 4,
        next: [
          `Chrome/CDP routed the new tab away from the requested profile ${profileId}.`,
          `the wrong-profile tab was closed via CDP; no user tabs were touched`,
          `do not switch to anonymous or another profile unless the user approves`,
          `ask whether to use anonymous for a clean public-page check, or continue with ${profileId}`,
          `if continuing with ${profileId}, use explicit visual handoff: realbrowser tab ensure ${intendedUrl || "<url>"} --profile "${profileId}" --label app --front`,
          `OR list existing tabs in the target profile: realbrowser tab list --profile "${profileId}"`,
          `for read-only existing-tab inspection only, attach with: realbrowser tab select <target> --profile "${profileId}" --label app --allow-browser-scope-target`,
        ],
      });
    }
    if (!actualDir && strict) {
      await failUnverified("chrome://version did not expose Profile Path before timeout");
    }
    // Profile matches, or non-strict callers accept an unproven legacy result.
    if (intendedUrl) {
      await this.cdp.send("Page.navigate", { url: intendedUrl }, session).catch(() => {});
    }
    return actualDir;
  }
  async evaluate(targetId, expression, { awaitPromise = true, returnByValue = true, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    const result = await this.sendToTarget(targetId, "Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
    }, timeoutMs);
    if (result.exceptionDetails) throw new Error(formatCdpException(result.exceptionDetails));
    return cdpValue(result.result);
  }
  async callFunction(targetId, fnSource, args = [], options = {}) {
    const expression = `(() => {
      ${PAGE_HELPERS}
      const __realbrowser_fn = ${String(fnSource)};
      return __realbrowser_fn(...${JSON.stringify(args)});
    })()`;
    return await this.evaluate(targetId, expression, options);
  }
  recordNetwork(targetId, kind, params) {
    const buffer = this.networkBuffer(targetId);
    const existing = buffer.toArray().find((entry) => entry.backendRequestId === params.requestId);
    if (kind === "request") {
      buffer.push({
        id: `req_${buffer.totalAdded + 1}`,
        backendRequestId: params.requestId,
        timestamp: Date.now(),
        method: params.request?.method,
        url: params.request?.url,
        type: params.type,
        requestHeaders: params.request?.headers,
        postData: params.request?.postData,
        status: "pending",
      });
    } else if (existing && kind === "response") {
      existing.status = params.response?.status;
      existing.statusText = params.response?.statusText;
      existing.mimeType = params.response?.mimeType;
      existing.responseHeaders = params.response?.headers;
      existing.remoteIPAddress = params.response?.remoteIPAddress;
      existing.protocol = params.response?.protocol;
      existing.type = params.type || existing.type;
    } else if (existing && kind === "finished") {
      existing.encodedDataLength = params.encodedDataLength;
      existing.finishedAt = Date.now();
      existing.durationMs = Math.max(0, existing.finishedAt - existing.timestamp);
    } else if (existing && kind === "failed") {
      existing.failed = true;
      existing.errorText = params.errorText;
      existing.status = "ERR";
    }
  }
  async shutdown() {
    try { this.cdp.close(); } catch {}
    try { this.server?.close(); } catch {}
    if (this.anonymousProcess && this.context.kind === "anonymous") {
      // v0.3.0 (codex P1 fix): Windows doesn't honor negative-PID group kill
      // and Chrome detaches into its own process tree. Use taskkill /T (tree)
      // to clean up child renderers/zygotes. On macOS/Linux keep the
      // negative-PID SIGTERM which targets the detached process group.
      if (IS_WINDOWS) {
        await runProcess("taskkill", ["/PID", String(this.anonymousProcess.pid), "/T", "/F"], 5_000).catch(() => {});
      } else {
        try { process.kill(-this.anonymousProcess.pid, "SIGTERM"); } catch {}
      }
    }
    if (this.anonymousDir && this.context.kind === "anonymous") {
      await fsp.rm(this.anonymousDir, { recursive: true, force: true }).catch(() => {});
    }
    await fsp.rm(this.stateFile, { force: true }).catch(() => {});
    process.exit(0);
  }
}

BrowserDaemon.prototype.tab = async function tab(command, args, flags) {
  if (command === "list") {
    await this.reconcileTaskTabs(flags).catch(() => {});
    const query = args[0] || "";
    const tabs = await this.tabs();
    let filtered = query
      ? tabs.filter((tab) => `${tab.label || ""} ${tab.title || ""} ${tab.url || ""} ${tab.targetId}`.toLowerCase().includes(query.toLowerCase()))
      : tabs;
    if (flags.mine || flags.owned) {
      filtered = filtered.filter((tab) => this.classifyTabOwnership(tab, flags) === "mine");
    }
    const warning = this.isBrowserScopedProfileContext()
      ? `browser-scoped CDP cannot prove these targets belong to ${this.context.profile.id}; use tab new/ensure through the profile for mutations`
      : undefined;
    return result({
      text: [warning ? `warning: ${warning}` : "", formatTabs(filtered)].filter(Boolean).join("\n"),
      targets: filtered,
      taskId: this.taskId(flags),
      context: this.publicContext(),
      warning,
      suggestedNext: warning ? undefined : (filtered[0]?.suggestedTarget ? `realbrowser read observe -t ${filtered[0].suggestedTarget}` : undefined),
    });
  }
  if (command === "done") {
    await this.reconcileTaskTabs(flags);
    const scopeKey = this.taskTabsScopeKey(flags);
    const now = new Date().toISOString();
    let count = 0;
    this.taskTabs = await updateJsonFile(this.taskTabsFile, {}, (current) => {
      const data = current || {};
      const scoped = data[scopeKey] || {};
      for (const record of Object.values(scoped)) {
        if (!record || typeof record !== "object") continue;
        record.status = "complete";
        record.updatedAt = now;
        count += 1;
      }
      return data;
    });
    if (flags.close) {
      const tabs = await this.tabs();
      const mine = tabs.filter((tab) => this.classifyTabOwnership(tab, flags) === "mine");
      for (const tab of mine) {
        await this.cdp.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
        await this.releaseTargetLease(tab.targetId).catch(() => {});
        await this.removeTaskTab(tab.targetId, flags);
      }
      return result({
        text: `closed ${mine.length} agent-owned tab${mine.length === 1 ? "" : "s"} for task ${this.taskId(flags)}`,
        closed: mine.length,
        completed: count,
        taskId: this.taskId(flags),
      });
    }
    return result({
      text: `marked ${count} agent tab${count === 1 ? "" : "s"} complete; kept open for inspection\ncleanup: realbrowser tab close --mine`,
      completed: count,
      taskId: this.taskId(flags),
    });
  }
  if (command === "select") {
    const query = args[0] || flags.target;
    if (!query) throw usage("tab select requires a target/query");
    const tab = await this.resolveTarget(query, { allowQuery: true, allowUnprovenProfileTarget: true, operation: "tab select" });
    this.assertProfileTargetProven(tab, flags, "tab select");
    if (flags.front || flags.label || flags.takeLease) await this.assertTargetLease(tab, flags, "tab select");
    if (flags.label) await this.setLabel(flags.label, tab.targetId, { profileOwned: this.profileTargetProven(tab), source: "select", force: Boolean(flags.force), takeLease: Boolean(flags.takeLease), url: tab.url });
    else if (flags.takeLease) await this.claimTarget(tab, flags, "select");
    const updated = flags.label ? { ...tab, label: flags.label, suggestedTarget: flags.label } : tab;
    if (flags.front) await this.cdp.send("Target.activateTarget", { targetId: tab.targetId });
    await this.attach(tab.targetId);
    return result({
      text: `selected ${updated.suggestedTarget} ${updated.url}`,
      target: updated,
      context: this.publicContext(),
    });
  }
  if (command === "ensure" || command === "new") {
    const url = args[0];
    if (!url) throw usage(`tab ${command} requires <url>`);
    assertNavigationUrl(url, flags.force);
    const forceNew = Boolean(flags.forceNew || flags.force_new || flags.forceNewTab);
    let existing = null;
    let existingFromLabel = false;
    const tabs = await this.tabs();
    // Phase 2: task-origin dedup. If this task already has a tab for the
    // same origin, alias the new label and reuse — or refuse with a
    // teaching error so a confused agent stops creating duplicate tabs.
    if (command === "ensure" && !forceNew && flags.reuse !== "none") {
      const taskHit = await this.findTaskTabForOrigin(url, flags, tabs);
      if (taskHit?.tab) {
        const requestedLabel = flags.label;
        const currentLabel = taskHit.record?.label || taskHit.tab.label || taskHit.tab.suggestedTarget;
        if (requestedLabel) {
          const labelTarget = this.labelsForContext()[requestedLabel];
          if (labelTarget && labelTarget !== taskHit.tab.targetId) {
            throw duplicateTaskOriginError({
              origin: taskHit.origin,
              existing: { ...taskHit.tab, ...taskHit.record, label: currentLabel },
              requestedLabel,
              url,
            });
          }
          // setTargetMeta preserves trusted target-meta source (profile-open /
          // cdp-create-with-context). setLabel still records the alias source
          // in label-meta for diagnostics.
          await this.setLabel(requestedLabel, taskHit.tab.targetId, {
            profileOwned: this.profileTargetProven(taskHit.tab),
            profile: this.context.profile?.id,
            source: "task-origin-alias",
            force: true,
            takeLease: Boolean(flags.takeLease),
            url: taskHit.tab.url,
          });
          await this.recordTaskTab(taskHit.tab, url, requestedLabel, flags, "ensure-reuse-origin");
        } else {
          await this.claimTarget(taskHit.tab, flags, "ensure-reuse-origin");
          await this.recordTaskTab(taskHit.tab, url, currentLabel, flags, "ensure-reuse-origin");
        }
        await this.attach(taskHit.tab.targetId);
        const label = requestedLabel || currentLabel || taskHit.tab.suggestedTarget;
        const reused = {
          ...taskHit.tab,
          label,
          suggestedTarget: label,
          lease: this.leaseForTarget(taskHit.tab.targetId),
        };
        return result({
          text: [
            `reused ${label} ${reused.url}`,
            `task-tab origin=${taskHit.origin} label=${label} target=${reused.targetPrefix} status=active`,
            `next: retry on this tab with \`realbrowser action state -t ${label} --root active --compact\` or navigate it with \`realbrowser tab navigate -t ${label} <url>\``,
          ].join("\n"),
          target: reused,
          reused: true,
          taskTab: taskHit.record,
          taskId: this.taskId(flags),
          context: this.publicContext(),
        });
      }
    }
    // v0.3.0: session-scoped reuse. Before falling through to create, look for
    // a same-origin tab anywhere in the SAME Chrome session that realbrowser
    // recorded (any task / any owner). This prevents nested subagents from each
    // opening their own same-origin tab. Only matches tabs
    // we previously recorded — user tabs are still classified as "user" and
    // skipped here.
    if (command === "ensure" && !forceNew && !existing && flags.reuse !== "none") {
      const sessionHit = await this.findSessionTabForOrigin(url, flags, tabs).catch(() => null);
      if (sessionHit?.tab && this.classifyTabOwnership(sessionHit.tab, flags) !== "user") {
        existing = sessionHit.tab;
        existingFromLabel = false;
      }
    }
    if (command === "ensure") {
      if (!existing && flags.label) {
        const labelTarget = this.labelsForContext()[flags.label];
        existing = tabs.find((tab) => tab.targetId === labelTarget) || null;
        existingFromLabel = Boolean(existing);
        if (existing && !this.profileTargetProven(existing)) {
          existing = null;
          existingFromLabel = false;
        }
      }
      const urlMatches = (tab) => sameUrl(tab.url, url) || (tab.requestedUrl && sameUrl(tab.requestedUrl, url));
      if (!existing && flags.reuse !== "none" && !this.isBrowserScopedProfileContext()) {
        existing = tabs.find((tab) => urlMatches(tab) && this.classifyTabOwnership(tab, flags) !== "user") || null;
      } else if (!existing && flags.reuse !== "none" && this.isBrowserScopedProfileContext()) {
        existing = tabs.find((tab) => urlMatches(tab) && this.profileTargetProven(tab) && this.classifyTabOwnership(tab, flags) !== "user") || null;
      }
      if (existing && !existingFromLabel && this.targetLeaseWouldConflict(existing, flags)) {
        existing = null;
      }
    }
    if (existing) {
      await this.assertTargetLease(existing, flags, `tab ${command}`);
      if (flags.label) await this.setLabel(flags.label, existing.targetId, { profileOwned: this.profileTargetProven(existing), source: "ensure-reuse", force: Boolean(flags.force), takeLease: Boolean(flags.takeLease), url: existing.url });
      else await this.claimTarget(existing, flags, "ensure-reuse");
      await this.recordTaskTab(existing, url, flags.label || existing.label, flags, "ensure-reuse");
      const leased = { ...existing, lease: this.leaseForTarget(existing.targetId) };
      await this.attach(existing.targetId);
      return result({
        text: `reused ${flags.label || leased.suggestedTarget} ${leased.url}`,
        target: { ...leased, label: flags.label || leased.label, suggestedTarget: flags.label || leased.suggestedTarget },
        reused: true,
        taskId: this.taskId(flags),
        context: this.publicContext(),
      });
    }
    if (command === "new" && flags.label && this.labelsForContext()[flags.label] && !flags.force) {
      throw new CliError(`label already exists: ${flags.label}`, {
        code: "label_exists",
        exitCode: 2,
        next: [`realbrowser tab label <target> ${flags.label} --force`],
      });
    }
    // v0.3.0: session-wide label collision. The local label store is keyed by
    // contextScopeKey (owner-aware), so nested subagent processes with
    // different owners or task IDs share NOTHING — that's how a confused
    // caller historically ended up inventing `app2`. Detect the collision
    // at the session level (same Chrome) and refuse before a duplicate tab
    // is created.
    if (flags.label && !flags.force && !forceNew) {
      const sessionHolder = this.sessionLabelHolder(flags.label);
      if (sessionHolder) {
        const holderTab = tabs.find((t) => t.targetId === sessionHolder);
        if (holderTab) {
          throw new CliError(`label already exists in this Chrome session: ${flags.label}`, {
            code: "duplicate_session_label",
            exitCode: 2,
            existingTargetId: sessionHolder,
            next: [
              `another task in this Chrome session already owns label ${flags.label} at target ${sessionHolder.slice(0, MIN_TARGET_PREFIX_LEN)}`,
              `reuse the existing tab: realbrowser tab select ${sessionHolder.slice(0, MIN_TARGET_PREFIX_LEN)} --label ${flags.label}`,
              `or list session tabs: realbrowser tab list --mine`,
              `or use a different label, or pass --force to override (will remap the label to a new target)`,
              `or pass --force-new for a fresh same-origin tab without label conflict`,
            ],
          });
        }
      }
    }
    const visibleByWindow = !flags.front ? await this.findActiveTabsByWindow(tabs).catch(() => new Map()) : new Map();
    if (this.context.kind === "profile" && this.context.profile && this.context.endpointScope !== "profile") {
      if (!flags.front && !flags.bestEffortBackground && !flags.background) {
        throw new CliError(`cannot safely create a background tab in profile ${this.context.profile.id}`, {
          code: "profile_background_launch_guard",
          exitCode: 4,
          next: [
            "the available DevTools endpoint is browser-scoped; choose a no-focus background attempt or explicit visual handoff",
            `realbrowser tab list --profile "${this.context.profile.id}"`,
            `realbrowser tab ensure ${url} --profile "${this.context.profile.id}" --label ${flags.label || "app"} --background`,
            `realbrowser tab ensure ${url} --profile "${this.context.profile.id}" --label ${flags.label || "app"} --front`,
          ],
        });
      }
      // Try CDP Target.createTarget first — no focus steal, true background.
      // OS launch is guarded below and refused for already-running browser-
      // scoped profiles because it can steal focus or route to another profile.
      if (!flags.front) {
        // CDP create is always attempted before any explicit handoff path.
        // Three paths:
        //   (a) trusted: a prior `profile-open` or `cdp-create-with-context`
        //       record gives us this profile's browserContextId — use it.
        //   (b) discovery: probe live browserContextIds with chrome://version
        //       in background, close mismatches, then use the proven id.
        //   (c) default-context: no proven id yet — call Target.createTarget
        //       WITHOUT browserContextId, which lands the tab in Chrome's
        //       currently-active browser context. For single-profile users
        //       this is correct; for multi-profile setups it can land in
        //       a different profile than `--profile` requested. We tag those
        //       tabs as `cdp-create-default-context` (NOT trusted by
        //       resolveBrowserContextIdForProfile) so a wrong-profile tab
        //       can never poison future context resolution.
        // Either path avoids the launchProfileTab subprocess and macOS focus
        // flash. launchProfileTab below is guarded and refused for running
        // browser-scoped profiles.
        let browserContextId = await this.resolveBrowserContextIdForProfile(this.context.profile.id).catch(() => null);
        let bcidIsTrusted = Boolean(browserContextId);
        if (!browserContextId && this.isBrowserScopedProfileContext() && this.context.profile?.profileDirName) {
          const discovered = await this.discoverBrowserContextIdForProfile(
            this.context.profile.id,
            this.context.profile.profileDirName,
          ).catch(() => null);
          if (discovered?.browserContextId) {
            browserContextId = discovered.browserContextId;
            bcidIsTrusted = true;
          }
        }
        // If discovery still cannot prove the requested profile in a
        // browser-scoped multi-profile endpoint, refuse instead of creating in
        // whatever profile Chrome considers current. The caller should ask the
        // user for --front/relaunch/anonymous consent rather than switching.
        if (!browserContextId && !flags.front && this.isBrowserScopedProfileContext()) {
          const liveContexts = await this.enumerateLiveBrowserContexts().catch(() => new Set());
          if (liveContexts.size > 1) {
            throw new CliError(`cannot disambiguate background tab for profile ${this.context.profile.id} across ${liveContexts.size} live browser contexts`, {
              code: "background_create_unavailable",
              exitCode: 4,
              next: [
                `${liveContexts.size} distinct browserContextIds visible on the endpoint, but none was proven as ${this.context.profile.id}`,
                "do not switch to anonymous or another profile unless the user approves",
                `realbrowser tab ensure ${url} --profile "${this.context.profile.id}" --label ${flags.label || "app"} --front`,
                "or ask for one-shot profile relaunch approval, then retry --background",
              ],
            });
          }
        }
        {
          const cdpFocusRestore = await captureForegroundAppForBackgroundLaunch({ front: false }).catch(() => null);
          for (let cdpAttempt = 0; cdpAttempt < 2; cdpAttempt += 1) {
            try {
              // v0.3.0: when no proven browserContextId, open chrome://version
              // FIRST so we can read the actual profile path before committing.
              // If chrome://version reveals a profile mismatch, the tab is closed
              // and we throw profile_routing_failed — no orphan tabs in the wrong
              // profile, ever. With a known browserContextId we skip the probe
              // (Target.createTarget honors the context id deterministically).
              // v0.3.0: probe when bcid is unTRUSTED (NULL bcid OR heuristic-
              // derived bcid). Only skip the probe when bcid came from a prior
              // proven tab (resolveBrowserContextIdForProfile returned non-null).
              const probeProfile = !bcidIsTrusted && Boolean(this.context.profile?.profileDirName);
              const initialUrl = probeProfile ? "chrome://version/" : url;
              const createParams = { url: initialUrl, background: true, focus: false };
              if (browserContextId) createParams.browserContextId = browserContextId;
              const created = await this.cdp.send("Target.createTarget", createParams, undefined, flags.timeout || 30_000);
              const targetId = created.targetId;
              if (targetId) {
                // Tab is created. Commit to it. Every metadata/label/attach step
                // below is best-effort: if a downstream call throws, the tab is
                // STILL real and we MUST NOT fall through to launchProfileTab
                // (which would spawn Chrome and steal focus). Wrap every call
                // in .catch and return success regardless.
                await restoreForegroundAppAfterBackgroundLaunch(cdpFocusRestore, { delayMs: 50 }).catch(() => {});
                // v0.3.0: if we probed chrome://version, verify the actual
                // profile path matches what was requested. Mismatch closes the
                // tab and throws profile_routing_failed (propagates to the
                // caller; nothing else needs cleanup). Match yields a proven
                // tab AND navigates to the user's intended URL.
                let verifiedProfileDir = null;
                if (probeProfile) {
                  verifiedProfileDir = await this.verifyTargetProfile(targetId, this.context.profile.profileDirName, url, {
                    strict: true,
                    profileId: this.context.profile.id,
                  });
                }
                // profileOwned reflects whether we KNOW this tab is in the
                // requested profile. Either:
                //  - browserContextId was known (trusted source), OR
                //  - chrome://version probe confirmed the profile dir matches.
                // v0.3.0: profileProven requires TRUSTED bcid (from prior
                // proof) OR fresh chrome://version verification — NOT just
                // "we passed some bcid to createTarget", which may have been a
                // heuristic pick that landed in the wrong profile.
                const profileProven = bcidIsTrusted || Boolean(verifiedProfileDir);
                const trustedSource = bcidIsTrusted
                  ? "cdp-create-with-context"
                  : (verifiedProfileDir ? "cdp-create-verified-profile" : "cdp-create-default-context");
                await this.setTargetMeta(targetId, { profileOwned: profileProven, profile: this.context.profile.id, source: trustedSource, requestedUrl: url }).catch(() => {});
                if (flags.label) await this.setLabel(flags.label, targetId, { profileOwned: profileProven, profile: this.context.profile.id, source: trustedSource, force: command === "ensure" || Boolean(flags.force), takeLease: Boolean(flags.takeLease) }).catch(() => {});
                else await this.claimTarget({ targetId, suggestedTarget: targetId }, flags, trustedSource).catch(() => {});
                await this.recordTaskTab({ targetId, suggestedTarget: flags.label || targetId, label: flags.label || "", url }, url, flags.label, flags, trustedSource).catch(() => {});
                await this.attach(targetId).catch(() => {});
                await waitForUrl(this, targetId, url, Math.min(flags.timeout || 10_000, 10_000)).catch(() => {});
                await waitForReadyState(this, targetId, "interactive", Math.min(flags.timeout || 10_000, 10_000)).catch(() => {});
                await restoreForegroundAppAfterBackgroundLaunch(cdpFocusRestore, { delayMs: 50 }).catch(() => {});
                const tab = await this.resolveTarget(flags.label || targetId, { operation: `tab ${command}` }).catch(() => ({ targetId, suggestedTarget: flags.label || targetId, targetPrefix: targetId.slice(0, 8), label: flags.label || "", url }));
                return result({
                  text: [
                    `created ${tab.suggestedTarget} ${url}`,
                    `task-tab origin=${canonicalOriginKey(url)} label=${tab.suggestedTarget} target=${tab.targetPrefix} status=active`,
                    `next: realbrowser read observe -t ${tab.suggestedTarget}`,
                  ].join("\n"),
                  target: tab,
                  created: true,
                  launch: bcidIsTrusted ? "cdp-background" : (verifiedProfileDir ? "cdp-verified-profile" : "cdp-default-context"),
                  taskId: this.taskId(flags),
                  context: this.publicContext(),
                });
              }
            } catch (cdpErr) {
              if (cdpErr instanceof CliError && ["profile_routing_failed", "profile_verification_unavailable"].includes(cdpErr.code)) {
                throw cdpErr;
              }
              const message = cdpErr?.message || String(cdpErr);
              if (/Failed to find browser context/i.test(message) && browserContextId && this.isBrowserScopedProfileContext()) {
                const staleBcid = browserContextId;
                const discovered = cdpAttempt === 0 && this.context.profile?.profileDirName
                  ? await this.discoverBrowserContextIdForProfile(
                    this.context.profile.id,
                    this.context.profile.profileDirName,
                    new Set([staleBcid]),
                  ).catch(() => null)
                  : null;
                if (discovered?.browserContextId) {
                  browserContextId = discovered.browserContextId;
                  bcidIsTrusted = true;
                  continue;
                }
                throw new CliError(`cannot create a non-disruptive background tab for profile ${this.context.profile.id}: Chrome rejected stale browserContextId ${staleBcid}`, {
                  code: "background_create_unavailable",
                  exitCode: 4,
                  next: [
                    "No OS profile launch was attempted because it may open a new Chrome window.",
                    `realbrowser tab list --profile "${this.context.profile.id}"`,
                    `realbrowser tab ensure ${url} --profile "${this.context.profile.id}" --label ${flags.label || "app"} --front`,
                    "or relaunch the target profile once, then retry --background",
                  ],
                });
              }
              // CDP create itself failed (the Target.createTarget call threw).
              // Record the error to /tmp so we can diagnose; the guarded launch
              // path below will decide whether handoff is allowed.
              try {
                const dbg = `[${new Date().toISOString()}] CDP create failed: ${cdpErr?.message || cdpErr} url=${url} bcid=${browserContextId || "(default)"}\n`;
                fs.appendFileSync("/tmp/realbrowser-cdp-create-errors.log", dbg);
              } catch {}
              break;
            } finally {
              await restoreForegroundAppAfterBackgroundLaunch(cdpFocusRestore, { delayMs: 50 }).catch(() => {});
            }
            break;
          }
        }
      }
      // Phase 4: refuse OS Chrome launch for browser-scoped profile endpoints.
      // launchProfileTab uses --profile-directory through the OS/browser app. If
      // Chrome is already running with multiple profiles, the OS can route that
      // request to the frontmost profile or open a visible window. That violates
      // the background/no-focus contract even under --best-effort-background.
      const osLaunchWouldViolateBackgroundContract = !flags.front && this.isBrowserScopedProfileContext();
      if (!flags.front && (!flags.bestEffortBackground || osLaunchWouldViolateBackgroundContract)) {
        const next = [
          "No Chrome launch was attempted.",
          `realbrowser tab list --mine --profile "${this.context.profile.id}"`,
          `realbrowser tab list --profile "${this.context.profile.id}"`,
          `realbrowser tab ensure ${url} --profile "${this.context.profile.id}" --label ${flags.label || "app"} --front`,
          "if a proven tab in this profile already exists, select it or read it first to reuse its browserContextId, then retry --background",
        ];
        if (!osLaunchWouldViolateBackgroundContract) {
          next.splice(3, 0, `realbrowser tab ensure ${url} --profile "${this.context.profile.id}" --label ${flags.label || "app"} --best-effort-background`);
        }
        throw new CliError(`cannot create a non-disruptive background tab for profile ${this.context.profile.id} because no proven browserContextId is available`, {
          code: "background_create_unavailable",
          exitCode: 4,
          next,
        });
      }
      const beforeIds = new Set(tabs.map((tab) => tab.targetId));
      // v0.3.0: open chrome://version via the Chrome subprocess so we can
      // verify profile routing BEFORE committing to the user's URL. On macOS
      // with multiple profiles, --profile-directory is unreliable when Chrome
      // is already running; the subprocess command is routed to the frontmost
      // window's profile. chrome://version is a free probe.
      const launch = await this.launchProfileTab("chrome://version/", { front: Boolean(flags.front) });
      const tab = await waitForOpenedTab(this, "chrome://version", beforeIds, flags.timeout || 30_000, { requireFresh: true });
      if (flags.front) {
        await this.cdp.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => {});
      }
      // No --front: do NOT activateTarget on a "restore" tab. activateTarget
      // brings Chrome.app to the macOS foreground; restoring user-visible focus
      // is handled by restoreForegroundAppAfterBackgroundLaunch (osascript) which
      // returns the previous foreground app or browser tab to
      // its prior state without touching any Chrome tab.
      await restoreForegroundAppAfterBackgroundLaunch(launch?.focusRestore, { delayMs: 50 }).catch(() => {});
      // v0.3.0+: verify chrome://version then navigate to the intended URL.
      // Mismatches or unreadable Profile Path close the probe tab before the
      // user's URL is loaded; correctness is preferred over a wrong-profile tab.
      const verifiedProfileDir = await this.verifyTargetProfile(tab.targetId, this.context.profile.profileDirName, url, {
        strict: true,
        profileId: this.context.profile.id,
      });
      const profileOwnedAfterLaunch = Boolean(verifiedProfileDir);
      await this.setTargetMeta(tab.targetId, { profileOwned: profileOwnedAfterLaunch, profile: this.context.profile.id, source: profileOwnedAfterLaunch ? "profile-open-verified" : "profile-open", requestedUrl: url });
      const launchSource = profileOwnedAfterLaunch ? "profile-open-verified" : "profile-open";
      if (flags.label) await this.setLabel(flags.label, tab.targetId, { profileOwned: profileOwnedAfterLaunch, profile: this.context.profile.id, source: launchSource, force: command === "ensure" || Boolean(flags.force), takeLease: Boolean(flags.takeLease), url: tab.url });
      else await this.claimTarget(tab, flags, launchSource);
      await this.recordTaskTab(tab, url, flags.label, flags, "profile-open");
      await this.attach(tab.targetId);
      await waitForReadyState(this, tab.targetId, "interactive", Math.min(flags.timeout || 10_000, 10_000)).catch(() => {});
      const updated = await this.resolveTarget(flags.label || tab.targetId, { operation: `tab ${command}` });
      return result({
        text: [
          `created ${updated.suggestedTarget} ${url}`,
          `task-tab origin=${canonicalOriginKey(url)} label=${updated.suggestedTarget} target=${updated.targetPrefix} status=active`,
          `next: realbrowser read observe -t ${updated.suggestedTarget}`,
        ].join("\n"),
        target: updated,
        created: true,
        launch: "profile-open",
        taskId: this.taskId(flags),
        warning: this.context.endpointScope === "browser" ? "browser-scoped CDP cannot prove existing-tab profile ownership; new tab was opened through the named profile launcher" : undefined,
        context: this.publicContext(),
      });
    }
    const focusRestore = !flags.front ? await captureForegroundAppForBackgroundLaunch({ front: false }).catch(() => null) : null;
    try {
      const created = await this.cdp.send("Target.createTarget", {
        url,
        background: !flags.front,
        focus: flags.front ? undefined : false,
      }, undefined, flags.timeout || 30_000);
      const targetId = created.targetId;
      if (!targetId) throw new Error("Target.createTarget returned no targetId");
      if (flags.front) {
        await this.cdp.send("Target.activateTarget", { targetId }).catch(() => {});
      }
      // No --front: do NOT call activateTarget — see same-comment above. The
      // background:true / focus:false flags on createTarget keep the new tab
      // out of the visible viewport without our help.
      const profileOwnedCreate = this.context.kind === "profile" && this.context.endpointScope === "profile";
      await this.setTargetMeta(targetId, { profileOwned: profileOwnedCreate, profile: this.context.profile?.id, source: "target-create", requestedUrl: url });
      if (flags.label) await this.setLabel(flags.label, targetId, { profileOwned: profileOwnedCreate, profile: this.context.profile?.id, source: "target-create", force: command === "ensure" || Boolean(flags.force), takeLease: Boolean(flags.takeLease) });
      else await this.claimTarget({ targetId, suggestedTarget: targetId }, flags, "target-create");
      await this.recordTaskTab({ targetId, suggestedTarget: flags.label || targetId, label: flags.label || "", url }, url, flags.label, flags, "target-create");
      await this.attach(targetId);
      await waitForUrl(this, targetId, url, Math.min(flags.timeout || 10_000, 10_000)).catch(() => {});
      await waitForReadyState(this, targetId, "interactive", Math.min(flags.timeout || 10_000, 10_000)).catch(() => {});
      const tab = await this.resolveTarget(flags.label || targetId, { operation: `tab ${command}` });
      return result({
        text: [
          `created ${tab.suggestedTarget} ${url}`,
          `task-tab origin=${canonicalOriginKey(url)} label=${tab.suggestedTarget} target=${tab.targetPrefix} status=active`,
          `next: realbrowser read observe -t ${tab.suggestedTarget}`,
        ].join("\n"),
        target: tab,
        created: true,
        taskId: this.taskId(flags),
        context: this.publicContext(),
      });
    } finally {
      await restoreForegroundAppAfterBackgroundLaunch(focusRestore, { delayMs: 50 }).catch(() => {});
    }
  }
  if (command === "navigate") {
    const targetRef = flags.target || args[0];
    let url = flags.target ? args[0] : args[1];
    if (!targetRef || !url) throw usage("tab navigate requires <target> <url|link-ref>");
    let resolvedFromRef = "";
    const tab = await this.resolveTargetForOperation(targetRef, flags, "tab navigate");
    await this.assertTargetLease(tab, flags, "tab navigate");
    await this.assertAgentOwnedForMutation(tab, flags, "tab navigate");
    if (/^l\d+$/i.test(url)) {
      const ref = this.refMetadataFor(tab.targetId, url);
      if (!ref?.href) throw new CliError(`ref ${url} has no href`, { code: "ref_not_navigable", exitCode: 2 });
      resolvedFromRef = url;
      url = ref.href;
    }
    assertNavigationUrl(url, flags.force);
    await this.sendToTarget(tab.targetId, "Page.navigate", { url }, flags.timeout || 30_000);
    await this.setTargetMeta(tab.targetId, { profileOwned: this.profileTargetProven(tab), source: "navigate", requestedUrl: url });
    await waitForUrl(this, tab.targetId, url, Math.min(flags.timeout || 10_000, 10_000)).catch(() => {});
    await waitForReadyState(this, tab.targetId, "interactive", Math.min(flags.timeout || 10_000, 10_000)).catch(() => {});
    const updated = await this.resolveTargetForOperation(tab.suggestedTarget, flags, "tab navigate");
    // Update task registry: if we owned this tab and origin changed, move
    // the registry entry from the old origin to the new one.
    if (this.classifyTabOwnership(updated, flags) === "mine") {
      const oldOrigin = canonicalOriginKey(tab.url || "");
      const newOrigin = canonicalOriginKey(url);
      if (oldOrigin && oldOrigin !== newOrigin) {
        await this.removeTaskTab(updated.targetId, flags).catch(() => {});
      }
      await this.recordTaskTab(updated, url, updated.label || tab.label || tab.suggestedTarget, flags, "navigate").catch(() => {});
    }
    const liveTitle = await this.callFunction(tab.targetId, () => ({ title: document.title || "" }), []).then((r) => r?.title || updated.title || "").catch(() => updated.title || "");
    const errorPagePattern = /(?:^|[^a-z0-9])(?:404|500|503|not[\s-]?found|page[\s-]?not[\s-]?found|không[\s-]?tìm[\s-]?thấy|trang[\s-]?không[\s-]?tồn[\s-]?tại|seite[\s-]?nicht[\s-]?gefunden|p[áa]gina[\s-]?no[\s-]?encontrada)(?:[^a-z0-9]|$)/i;
    const errorPageHint = errorPagePattern.test(liveTitle) ? liveTitle.slice(0, 120) : "";
    const baseText = `navigated ${updated.suggestedTarget} to ${url}`;
    const text = errorPageHint
      ? `${baseText}\nWARN: page title looks like an error page (${errorPageHint}). The URL responded but the rendered page is an error/not-found template — verify with: read tree -t ${updated.suggestedTarget} -i -c`
      : baseText;
    return result({ text, target: updated, resolvedFromRef: resolvedFromRef || undefined, errorPageHint: errorPageHint || undefined, title: liveTitle || undefined });
  }
  if (command === "label") {
    const targetRef = args[0] || flags.target;
    const label = args[1] || flags.label;
    if (!targetRef || !label) throw usage("tab label requires <target> <label>");
    const tab = await this.resolveTargetForOperation(targetRef, flags, "tab label");
    await this.assertTargetLease(tab, flags, "tab label");
    await this.setLabel(label, tab.targetId, { profileOwned: this.profileTargetProven(tab), source: "label", force: Boolean(flags.force), takeLease: Boolean(flags.takeLease), url: tab.url });
    return result({ text: `labeled ${tab.targetPrefix} as ${label}`, target: { ...tab, label, suggestedTarget: label } });
  }
  if (command === "focus" || command === "handoff") {
    const tab = await this.resolveTargetForOperation(args[0] || flags.target, flags, `tab ${command}`);
    await this.assertTargetLease(tab, flags, `tab ${command}`);
    await this.cdp.send("Target.activateTarget", { targetId: tab.targetId });
    return result({ text: `focused ${tab.suggestedTarget}`, target: tab });
  }
  if (command === "resume") {
    const tab = await this.resolveTargetForOperation(args[0] || flags.target, flags, "tab resume");
    return await this.read("observe", [], { ...flags, target: tab.suggestedTarget });
  }
  if (command === "close") {
    if (flags.mine) {
      await this.reconcileTaskTabs(flags);
      const tabs = await this.tabs();
      const mine = tabs.filter((tab) => this.classifyTabOwnership(tab, flags) === "mine");
      for (const tab of mine) {
        await this.cdp.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
        await this.releaseTargetLease(tab.targetId).catch(() => {});
        await this.removeTaskTab(tab.targetId, flags);
      }
      return result({
        text: `closed ${mine.length} agent-owned tab${mine.length === 1 ? "" : "s"} for task ${this.taskId(flags)}`,
        closed: mine.length,
        taskId: this.taskId(flags),
      });
    }
    const tab = await this.resolveTargetForOperation(args[0] || flags.target, flags, "tab close");
    await this.assertTargetLease(tab, flags, "tab close");
    await this.assertAgentOwnedForMutation(tab, flags, "tab close");
    await this.cdp.send("Target.closeTarget", { targetId: tab.targetId });
    await this.releaseTargetLease(tab.targetId);
    await this.removeTaskTab(tab.targetId, flags);
    return result({ text: `closed ${tab.suggestedTarget}`, target: tab });
  }
  throw usage(`unknown tab command: ${command}`);
};

BrowserDaemon.prototype.handle = async function handle(command, args, flags) {
  if (command === "create") {
    const tab = await this.resolveTargetForOperation(flags.target || args[0], flags, "handle create");
    return result({ text: `handle target ${tab.suggestedTarget}`, target: tab, context: this.publicContext() });
  }
  if (command === "release") {
    const name = args[0];
    if (!name) throw usage("handle release requires <name>");
    await fsp.rm(handlePath(name), { force: true });
    return result({ text: `released handle ${name}`, released: name });
  }
  return result({ text: "use CLI handle list for local handles" });
};

BrowserDaemon.prototype.read = async function read(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `read ${command}`);
  await this.attach(tab.targetId);
  if (command === "observe") {
    const payload = await this.callFunction(tab.targetId, pageObserveFunction, [Number(flags.maxChars || 1800)]);
    return await maybeWriteReadOut(result({ text: formatObserve(payload, tab), target: tab, observe: payload }), flags, payload, "observe", { omit: ["observe"] });
  }
  if (command === "size") {
    const payload = await this.callFunction(tab.targetId, pageSizeFunction, []);
    return await maybeWriteReadOut(result({ text: formatJsonCompact(payload), target: tab, size: payload }), flags, payload, "size");
  }
  if (command === "query" || command === "query-selector") {
    const selector = args[0] || flags.selector;
    if (!selector) throw usage("read query requires <selector>");
    const opts = queryOptions(flags);
    if (flags.root && /^[riefblco]\d+$/i.test(flags.root)) opts.rootSelector = this.selectorFor(tab.targetId, flags.root);
    const payload = await this.callFunction(tab.targetId, queryFunction, [selector, opts]);
    if (flags.fields) payload.matches = payload.matches.map((entry) => pickFields(entry, flags.fields));
    this.storeRefs(tab.targetId, payload.refs || {});
    return await maybeWriteReadOut(result({ text: formatQuery(payload), target: tab, ...payload }), flags, payload, "query", { omit: ["matches", "refs"] });
  }
  if (command === "items") {
    const opts = itemsOptions(args, flags);
    if (flags.root && /^[riefblco]\d+$/i.test(flags.root)) opts.root = this.selectorFor(tab.targetId, flags.root);
    const payload = await this.callFunction(tab.targetId, itemsFunction, [opts]);
    this.storeRefs(tab.targetId, payload.refs || {});
    return await maybeWriteReadOut(result({ text: formatItems(payload), target: tab, ...payload }), flags, payload, "items", { omit: ["items", "refs"] });
  }
  if (command === "item") {
    const opts = itemsOptions(args, flags);
    if (flags.root && /^[riefblco]\d+$/i.test(flags.root)) opts.root = this.selectorFor(tab.targetId, flags.root);
    const payload = await this.callFunction(tab.targetId, itemFunction, [opts]);
    this.storeRefs(tab.targetId, payload.refs || {});
    return await maybeWriteReadOut(result({ text: payload.found ? payload.text : `item ${payload.index} not found`, target: tab, ...payload }), flags, payload, "item", { omit: ["links", "media", "refs"] });
  }
  if (command === "snapshot") {
    if (flags.selector && /^[riefblco]\d+$/i.test(flags.selector)) flags.selector = this.selectorFor(tab.targetId, flags.selector);
    if (flags.root && /^[riefblco]\d+$/i.test(flags.root)) flags.root = `selector:${this.selectorFor(tab.targetId, flags.root)}`;
    const payload = await this.snapshot(tab.targetId, flags);
    return await maybeWriteReadOut(result({ text: payload.snapshot, target: tab, ...payload }), flags, payload.snapshot, "snapshot", { text: true, omit: ["snapshot", "refs"] });
  }
  if (command === "text") {
    const selector = args[0] || flags.selector || "";
    const payload = await this.callFunction(tab.targetId, textFunction, [selector, Number(flags.maxChars || 6000)]);
    return await maybeWriteReadOut(result({ text: payload.text, target: tab, ...payload }), flags, payload.text, "text", { text: true });
  }
  if (command === "html") {
    const selector = args[0] || flags.selector || "";
    const payload = await this.callFunction(tab.targetId, htmlFunction, [selector, Number(flags.maxChars || 12000)]);
    if (flags.out) await writeTextArtifact(flags.out, payload.html);
    const responsePayload = flags.out ? { ...payload, html: undefined } : payload;
    return result({ text: flags.out ? `html written: ${flags.out}` : payload.html, target: tab, ...responsePayload, outPath: flags.out });
  }
  if (command === "links" || command === "forms" || command === "url") {
    const fn = command === "links" ? linksFunction : command === "forms" ? formsFunction : urlFunction;
    const payload = await this.callFunction(tab.targetId, fn, [Number(flags.limit || 50)]);
    return await maybeWriteReadOut(result({ text: formatValue(payload), target: tab, [command]: payload }), flags, payload, command, { omit: [command] });
  }
  if (command === "tree") {
    if (flags.selector && /^[riefblco]\d+$/i.test(flags.selector)) flags.selector = this.selectorFor(tab.targetId, flags.selector);
    const payload = await this.ariaTree(tab.targetId, flags);
    return await maybeWriteReadOut(result({ text: payload.tree, target: tab, ...payload }), flags, payload.tree, "tree", { text: true, omit: ["tree", "refs"] });
  }
  if (command === "is") {
    const [state, ref] = args;
    if (!state || !ref) throw usage("read is requires <state> <ref|selector>");
    const payload = await this.callFunction(tab.targetId, isFunction, [state, this.selectorFor(tab.targetId, ref)]);
    return await maybeWriteReadOut(result({ text: String(payload.ok), target: tab, ...payload }), flags, payload, "is");
  }
  if (command === "autocomplete" || command === "overlay") {
    const opts = { limit: Number(flags.limit || 30) };
    if (flags.near) opts.anchorSelector = this.selectorFor(tab.targetId, flags.near);
    const payload = await this.callFunction(tab.targetId, readOverlayFunction, [opts]);
    if (!payload?.ok) {
      const reasonLine = payload?.reason ? `(${payload.reason})` : "(no floating layer found)";
      const hint = "if a dropdown should be open, focus the field first (action click <ref>), type to filter (action type <ref> \"<text>\"), then retry with --near <ref> to anchor at the field you clicked";
      return result({ text: `${reasonLine}\n${hint}`, target: tab, ok: false, reason: payload?.reason });
    }
    this.storeRefs(tab.targetId, payload.refs || {}, { merge: true });
    const layerHeader = `floating layer: ${payload.layer.tag}${payload.layer.role ? `[${payload.layer.role}]` : ""} z=${payload.layer.zIndex}${payload.layer.isListLike ? ` listItems=${payload.layer.listItems}` : ""}${payload.layer.isRoleLayer ? " role-layer" : ""}${typeof payload.layer.distance === "number" ? ` dist=${payload.layer.distance}` : ""} ${payload.layer.rect.width}x${payload.layer.rect.height}@${payload.layer.rect.x},${payload.layer.rect.y}`;
    const headerParts = [layerHeader];
    if (payload.anchor) {
      const f = payload.anchor;
      headerParts.push(`anchor (${f.source || "auto"}): ${f.tag}${f.role ? `[${f.role}]` : ""}${f.name ? ` "${f.name}"` : ""}${f.value ? ` value="${f.value}"` : ""}`);
    }
    if (payload.skippedLayers) headerParts.push(`(skipped ${payload.skippedLayers} ineligible layer${payload.skippedLayers === 1 ? "" : "s"})`);
    const lines = payload.options.map((o) => `- ${o.ref} ${o.tag}${o.role ? `[${o.role}]` : ""} "${o.text}"`);
    const truncatedNote = payload.truncated ? `\n(${payload.totalFound - payload.options.length} more; pass --limit N to expand)` : "";
    const text = `${headerParts.join("\n")}\n${lines.join("\n")}${truncatedNote}`;
    return await maybeWriteReadOut(result({ text, target: tab, ...payload }), flags, payload, "autocomplete", { text: true, omit: ["refs"] });
  }
  throw usage(`unknown read command: ${command}`);
};

BrowserDaemon.prototype.storeRefs = function storeRefs(targetId, refs, opts = {}) {
  const key = this.refStoreKey(targetId);
  const store = this.refStores.get(key) || { generation: 0, refs: {}, snapshot: "", ariaSnapshot: "" };
  store.generation += 1;
  store.refs = opts.merge ? { ...store.refs, ...refs } : refs;
  store.stale = false;
  this.refStores.set(key, store);
};

BrowserDaemon.prototype.refStoreKey = function refStoreKey(targetId) {
  return `${this.owner()}:${targetId}`;
};

BrowserDaemon.prototype.selectorFor = function selectorFor(targetId, refOrSelector) {
  const raw = String(refOrSelector || "");
  if (/^[ebfrilco]\d+$/i.test(raw)) {
    const store = this.refStores.get(this.refStoreKey(targetId));
    const ref = store?.refs?.[raw];
    if (!ref) {
      const available = store?.refs ? Object.keys(store.refs).slice(0, 8).join(",") : "(none)";
      throw new CliError(`ref ${raw} is stale or unknown`, {
        code: "ref_stale",
        exitCode: 5,
        next: [
          `refs from a tree-file (--out) become invalid after the next read tree on this target`,
          `available refs: ${available}${store?.refs && Object.keys(store.refs).length > 8 ? "..." : ""}`,
          `recovery: realbrowser read tree -t <target> -i -c   (without --out, then use refs from that output)`,
          `or:        realbrowser action state -t <target> --root active --compact`,
        ],
      });
    }
    return ref.selector;
  }
  if (raw.startsWith("selector:")) return raw.slice("selector:".length);
  return raw;
};

BrowserDaemon.prototype.refMetadataFor = function refMetadataFor(targetId, refName) {
  const store = this.refStores.get(this.refStoreKey(targetId));
  return store?.refs?.[String(refName || "")] || null;
};

BrowserDaemon.prototype.snapshot = async function snapshot(targetId, flags) {
  const payload = await this.callFunction(targetId, snapshotFunction, [snapshotOptions(flags)]);
  const text = payload.snapshot || "";
  const previous = this.refStores.get(this.refStoreKey(targetId)) || { generation: 0, refs: {}, snapshot: "" };
  let output = text;
  if (flags.diff) {
    output = lineDiff(previous.snapshot || "", text);
  }
  this.storeRefs(targetId, payload.refs || {});
  const store = this.refStores.get(this.refStoreKey(targetId));
  if (store) store.snapshot = text;
  return { ...payload, snapshot: output, stats: { ...(payload.stats || {}), chars: output.length, diff: Boolean(flags.diff) } };
};

BrowserDaemon.prototype.ariaTree = async function ariaTree(targetId, flags) {
  const sessionId = await this.attach(targetId);
  const depthLimit = Number(flags.depth || 0) || undefined;
  let axNodes;
  if (flags.selector) {
    const doc = await this.cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
    const { nodeId } = await this.cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: flags.selector }, sessionId);
    if (!nodeId) throw new CliError(`selector not found: ${flags.selector}`, { code: "not_found", exitCode: 3 });
    const described = await this.cdp.send("DOM.describeNode", { nodeId }, sessionId);
    const result = await this.cdp.send("Accessibility.getPartialAXTree", { backendNodeId: described.node.backendNodeId, depth: depthLimit || 12 }, sessionId);
    axNodes = result.nodes;
  } else {
    const result = await this.cdp.send("Accessibility.getFullAXTree", { depth: depthLimit }, sessionId);
    axNodes = result.nodes;
  }
  const formatted = formatAxTreeV2(axNodes, {
    interactive: Boolean(flags.interactive),
    compact: Boolean(flags.compact),
    depth: Number(flags.depth || 50),
    limit: Number(flags.limit || flags.maxNodes || 800),
  });
  const previous = this.refStores.get(this.refStoreKey(targetId)) || { generation: 0, refs: {}, snapshot: "", ariaSnapshot: "" };
  const refs = {};
  if (formatted.interactiveNodes.length > 0) {
    await this.assignAriaRefs(targetId, sessionId, formatted.interactiveNodes, refs);
  }
  const cleanedText = stripUnstampedRefs(formatted.text, refs);
  // Walk the visible DOM for non-ARIA clickable elements (cursor:pointer
  // divs, tabindex containers, onclick wrappers, contenteditable blocks,
  // aria-haspopup triggers) that the AX tree cannot see. These are
  // common in React/Vue UIs (recent-search bubbles, custom date pickers,
  // option chips). The cursor-clickables function stamps `c1, c2, ...`
  // refs and skips anything already in the AX tree (via
  // `[data-realbrowser-ref]` ancestor/self check).
  let cursorPayload = { lines: [], refs: {}, count: 0 };
  if (!flags.selector) {
    cursorPayload = await this.callFunction(targetId, cursorClickablesFunction, [{ max: 100, startIndex: 0 }]).catch(() => cursorPayload);
  }
  let combined = cleanedText;
  if (cursorPayload.lines && cursorPayload.lines.length) {
    const recentSearchHint = detectRecentSearchHint(cursorPayload.lines);
    const header = `\n# cursor-clickables (non-ARIA, DOM-detected; ${cursorPayload.count} item${cursorPayload.count === 1 ? "" : "s"})${recentSearchHint ? `\n${recentSearchHint}` : ""}`;
    combined = `${cleanedText}\n${header}\n${cursorPayload.lines.join("\n")}`;
    Object.assign(refs, cursorPayload.refs || {});
  }
  let output = combined;
  if (flags.diff) {
    output = lineDiff(previous.ariaSnapshot || "", combined);
  }
  this.storeRefs(targetId, refs);
  const store = this.refStores.get(this.refStoreKey(targetId));
  if (store) store.ariaSnapshot = combined;
  const unstamped = formatted.interactiveNodes.filter((n) => n._stampFailed).length;
  return {
    tree: output,
    refs,
    stats: { lines: formatted.lines + (cursorPayload.lines?.length || 0), chars: output.length, refs: Object.keys(refs).length, unstamped, nodes: axNodes.length, diff: Boolean(flags.diff), truncated: formatted.truncated, cursorClickables: cursorPayload.count || 0 },
  };
};

BrowserDaemon.prototype.assignAriaRefs = async function assignAriaRefs(targetId, sessionId, interactiveNodes, refs) {
  // Clear prior stamps everywhere (light DOM + shadow DOM).
  await this.cdp.send("Runtime.evaluate", {
    expression: `
      (function clear(root) {
        if (!root || !root.querySelectorAll) return;
        for (const el of root.querySelectorAll("[data-realbrowser-ref]")) el.removeAttribute("data-realbrowser-ref");
        for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) clear(el.shadowRoot); }
      })(document);
    `,
  }, sessionId).catch(() => {});
  await this.cdp.send("DOM.enable", {}, sessionId).catch(() => {});

  const targets = interactiveNodes.filter((n) => n.ref && n.backendDOMNodeId);
  if (targets.length === 0) return;
  const backendIds = targets.map((n) => Math.floor(n.backendDOMNodeId));

  // Light-DOM path: batch backend->nodeId resolution. CDP method name is
  // pushNodesByBackendIdsToFrontend (proven openclaw pattern).
  const pushed = await this.cdp.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: backendIds }, sessionId).catch(() => null);
  const nodeIds = Array.isArray(pushed?.nodeIds) ? pushed.nodeIds : [];

  // Stamp each node. nodeId > 0 → cheap setAttributeValue (no JS execution).
  // nodeId 0 or batch failed → resolveNode + callFunctionOn pierces shadow DOM
  // by operating on the element's JS reference directly.
  await Promise.all(targets.map(async (node, i) => {
    const ref = node.ref;
    let stamped = false;
    const nodeId = nodeIds[i];
    if (nodeId && nodeId > 0) {
      try {
        await this.cdp.send("DOM.setAttributeValue", { nodeId, name: "data-realbrowser-ref", value: ref }, sessionId);
        stamped = true;
      } catch { /* fall through */ }
    }
    if (!stamped) {
      try {
        const resolved = await this.cdp.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId }, sessionId);
        const objectId = resolved?.object?.objectId;
        if (objectId) {
          try {
            await this.cdp.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: 'function(value) { this.setAttribute && this.setAttribute("data-realbrowser-ref", value); }',
              arguments: [{ value: ref }],
            }, sessionId);
            stamped = true;
          } finally {
            await this.cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
          }
        }
      } catch { /* mark below */ }
    }
    if (stamped) {
      refs[ref] = {
        ref,
        selector: `[data-realbrowser-ref="${ref}"]`,
        role: node.role,
        name: node.name || undefined,
        backendDOMNodeId: node.backendDOMNodeId,
      };
    } else {
      node._stampFailed = true;
    }
  }));
};

BrowserDaemon.prototype.wait = async function wait(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `wait ${command}`);
  if (command === "ready" && flags.screenshot && screenshotAnnotates(flags)) await this.assertTargetLease(tab, flags, "wait ready screenshot");
  await this.attach(tab.targetId);
  const timeout = flags.timeout || DEFAULT_TIMEOUT;
  if (command === "ready") {
    const payload = await this.callFunction(tab.targetId, waitReadyFunction, [waitReadyOptions(args, flags, timeout)], { timeoutMs: timeout + 1000 });
    if (flags.screenshot) {
      payload.screenshot = await captureCheckpointScreenshot(this, tab.targetId, flags, screenshotPath(this.artifactDir, "ready", tab, flags), {
        selector: flags.selector || flags.readySelector || "",
        root: flags.root,
        checkpoint: true,
      });
    }
    return result({ text: [`ready: ${payload.reason}`, payload.screenshot ? `screenshot: ${payload.screenshot.path} ${payload.screenshot.width}x${payload.screenshot.height}` : ""].filter(Boolean).join("\n"), target: tab, ...payload });
  }
  if (command === "selector") {
    const selector = args[0] || flags.selector;
    if (!selector) throw usage("wait selector requires <selector>");
    const payload = await this.callFunction(tab.targetId, waitSelectorFunction, [selector, timeout, Boolean(flags.visible)], { timeoutMs: timeout + 1000 });
    return result({ text: `selector ready: ${selector}`, target: tab, ...payload });
  }
  if (command === "text") {
    const text = args.join(" ") || flags.text;
    if (!text) throw usage("wait text requires <text>");
    const payload = await this.callFunction(tab.targetId, waitTextFunction, [text, timeout, Boolean(flags.visible)], { timeoutMs: timeout + 1000 });
    return result({ text: `text ready: ${text}`, target: tab, ...payload });
  }
  if (command === "url") {
    const contains = flags.contains || args[0];
    if (!contains) throw usage("wait url requires --contains <text>");
    const payload = await this.callFunction(tab.targetId, waitUrlFunction, [contains, timeout], { timeoutMs: timeout + 1000 });
    return result({ text: `url matched: ${payload.url}`, target: tab, ...payload });
  }
  if (command === "load") {
    const state = args[0] === "domcontentloaded" ? "interactive" : "complete";
    await waitForReadyState(this, tab.targetId, state, timeout);
    return result({ text: `load state reached: ${state}`, target: tab });
  }
  if (command === "network") {
    const payload = await this.callFunction(tab.targetId, waitNetworkIdleFunction, [timeout], { timeoutMs: timeout + 1000 });
    return result({ text: "network idle", target: tab, ...payload });
  }
  throw usage(`unknown wait command: ${command}`);
};

BrowserDaemon.prototype.action = async function action(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `action ${command}`);
  if (!["state", "root"].includes(command) || (flags.screenshot && screenshotAnnotates(flags))) await this.assertTargetLease(tab, flags, `action ${command}`);
  await this.attach(tab.targetId);
  const preflight = await this.callFunction(tab.targetId, actionPreflightFunction, []);
  if (command === "state" || command === "root") {
    const opts = actionOptions(args, flags);
    if (opts.rootSelector && /^[riefblco]\d+$/i.test(opts.rootSelector)) opts.rootSelector = this.selectorFor(tab.targetId, opts.rootSelector);
    const payload = await this.callFunction(tab.targetId, actionStateFunction, [opts]);
    this.storeRefs(tab.targetId, payload.refs || {});
    if (flags.screenshot) {
      const ssFlags = args[0] ? { ...flags, out: args[0] } : flags;
      payload.screenshot = await captureCheckpointScreenshot(this, tab.targetId, flags, screenshotPath(this.artifactDir, "action-state", tab, ssFlags), {
        selector: "",
        root: flags.root || "active",
        checkpoint: true,
      });
    }
    return result({ text: formatActionState(payload), target: tab, preflight, ...payload });
  }
  if (command === "click" || command === "hover" || command === "submit") {
    const submitArg = command === "submit" ? (args[0] || "") : "";
    const submitArgIsTarget = submitArg ? looksLikeActionTargetToken(submitArg) : false;
    if (command === "submit" && !submitArg && !flags.text) {
      throw new CliError("action submit requires <button-ref> or --text <exact label>", {
        code: "final_action_requires_target",
        exitCode: 2,
        next: ["realbrowser action state -t <target> --root active --compact"],
      });
    }
    const ref = command === "submit"
      ? (submitArgIsTarget ? submitArg : (looksLikeActionTargetToken(flags.ref || "") ? flags.ref : "final"))
      : (args[0] || flags.ref || flags.text);
    if ((command === "click" || command === "hover") && !ref) throw usage(`action ${command} requires <ref|selector>`);
    const options = actionOptions(args, flags);
    options.final = command === "submit" || Boolean(flags.final);
    options.text = flags.text || (command === "submit" && submitArg && !submitArgIsTarget ? submitArg : "");
    const selector = ref === "final" ? "" : this.selectorFor(tab.targetId, ref);
    let payload;
    try {
      payload = command === "hover"
        ? await this.callFunction(tab.targetId, clickFunction, [selector, options], { timeoutMs: flags.timeout || DEFAULT_TIMEOUT })
        : await callAndDispatchMouseClickWithFileChooserGuard(this, tab.targetId, selector, options, {
          allowFileDialog: Boolean(flags.allowFileDialog),
          command,
          ref,
          guardMs: preflight.visibility === "visible" && preflight.hasFocus ? FILE_CHOOSER_CLICK_GUARD_MS : FILE_CHOOSER_BACKGROUND_CLICK_GUARD_MS,
          timeoutMs: flags.timeout || DEFAULT_TIMEOUT,
        });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(cleanActionErrorMessage(error), {
        code: options.final ? "final_action_guard" : "action_guard",
        exitCode: 5,
        next: ["realbrowser action state -t <target> --root active --compact"],
      });
    }
    if (command === "hover") {
      await this.sendToTarget(tab.targetId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: payload.center.x, y: payload.center.y });
    }
    const postState = command === "submit" ? await sleep(500).then(() => this.callFunction(tab.targetId, actionPreflightFunction, [])).catch(() => null) : undefined;
    return result({ target: tab, preflight, postState, ...payload, elementText: payload.text, text: `${command === "submit" ? "submitted" : "clicked"} ${payload.ref || ref || payload.text || ""}`.trim() });
  }
  if (command === "drag") {
    const spec = dragArgs(args, flags, tab.targetId, this);
    let from;
    let to;
    try {
      from = spec.fromPoint
        ? { point: spec.fromPoint, entry: { center: spec.fromPoint, kind: "point" } }
        : await this.callFunction(tab.targetId, dragPointFunction, [spec.fromSelector, {
          ...actionOptions(args, flags),
          role: "drag source",
          scroll: true,
          requireEnabled: true,
          requirePointer: true,
          requireTopmost: true,
        }], { timeoutMs: flags.timeout || DEFAULT_TIMEOUT });
      if (spec.by) {
        to = { point: { x: from.point.x + spec.by.x, y: from.point.y + spec.by.y }, entry: { center: { x: from.point.x + spec.by.x, y: from.point.y + spec.by.y }, kind: "delta" } };
      } else if (spec.toPoint) {
        to = { point: spec.toPoint, entry: { center: spec.toPoint, kind: "point" } };
      } else {
        to = await this.callFunction(tab.targetId, dragPointFunction, [spec.toSelector, {
          ...actionOptions(args, flags),
          role: "drop target",
          scroll: false,
          requireEnabled: false,
          requirePointer: false,
          requireTopmost: false,
        }], { timeoutMs: flags.timeout || DEFAULT_TIMEOUT });
      }
      await dispatchMouseDrag(this, tab.targetId, from.point, to.point, spec);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(cleanActionErrorMessage(error), {
        code: "action_guard",
        exitCode: 5,
        next: ["realbrowser action state -t <target> --root active --compact"],
      });
    }
    return result({
      text: `dragged ${spec.fromLabel} to ${spec.toLabel}`,
      target: tab,
      preflight,
      from: { ...from.entry, point: from.point },
      to: { ...to.entry, point: to.point },
      steps: spec.steps,
      duration: spec.duration,
      hold: spec.hold,
      button: spec.button,
    });
  }
  if (command === "fill" || command === "select") {
    const ref = args[0] || flags.ref;
    const value = valueFromArgs(args.slice(args[0] ? 1 : 0), flags);
    if (!ref || value === undefined) throw usage(`action ${command} requires <ref|selector> <value>`);
    let payload;
    try {
      payload = await this.callFunction(tab.targetId, fillFunction, [this.selectorFor(tab.targetId, ref), value, command === "select", actionOptions(args, flags)]);
    } catch (error) {
      throw new CliError(cleanActionErrorMessage(error), {
        code: "action_guard",
        exitCode: 5,
        next: ["realbrowser action state -t <target> --root active --compact"],
      });
    }
    return result({ text: `${command === "select" ? "selected" : "filled"} ${ref}`, target: tab, preflight, ...payload });
  }
  if (command === "type") {
    const typeTarget = args[0] && looksLikeActionTargetToken(args[0]) && (args.length > 1 || flags.stdin || flags.valueFile) ? args[0] : "";
    const text = valueFromArgs(typeTarget ? args.slice(1) : args, flags);
    if (!text) throw usage("action type requires <text> or --stdin/--value-file");
    if (typeTarget) {
      try {
        await callAndDispatchMouseClickWithFileChooserGuard(this, tab.targetId, this.selectorFor(tab.targetId, typeTarget), actionOptions(args, flags), {
          allowFileDialog: Boolean(flags.allowFileDialog),
          command: "type",
          ref: typeTarget,
          guardMs: preflight.visibility === "visible" && preflight.hasFocus ? FILE_CHOOSER_CLICK_GUARD_MS : FILE_CHOOSER_BACKGROUND_CLICK_GUARD_MS,
          timeoutMs: flags.timeout || DEFAULT_TIMEOUT,
        });
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(cleanActionErrorMessage(error), {
          code: "action_guard",
          exitCode: 5,
          next: ["realbrowser action state -t <target> --root active --compact"],
        });
      }
    }
    await this.sendToTarget(tab.targetId, "Input.insertText", { text });
    return result({ text: `typed ${text.length} chars${typeTarget ? ` into ${typeTarget}` : ""}`, target: tab, preflight, chars: text.length, ref: typeTarget || undefined });
  }
  if (command === "press" || command === "key") {
    const key = args.join(" ");
    if (!key) throw usage(`action ${command} requires <key>`);
    await dispatchKey(this, tab.targetId, key);
    return result({ text: `pressed ${key}`, target: tab, preflight, key });
  }
  if (command === "scroll") {
    const direction = (args[0] || "down").toLowerCase();
    const amount = Number(args[1] || 500);
    const scrollMap = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] };
    const [deltaX, deltaY] = scrollMap[direction] || scrollMap.down;
    if (flags.selector || args[0] && /^[riefblco]\d+$/i.test(args[0])) {
      const sel = flags.selector || this.selectorFor(tab.targetId, args[0]);
      await this.callFunction(tab.targetId, (s, dx, dy) => {
        const el = document.querySelector(s);
        if (el) el.scrollBy(dx, dy);
        else window.scrollBy(dx, dy);
      }, [sel, deltaX, deltaY]);
    } else {
      await this.callFunction(tab.targetId, (dx, dy) => window.scrollBy(dx, dy), [deltaX, deltaY]);
    }
    return result({ text: `scrolled ${direction} ${amount}px`, target: tab, preflight, direction, amount, deltaX, deltaY });
  }
  if (command === "upload") {
    const { selector, triggerSelector, files } = uploadArgs(args, flags, tab.targetId, this);
    const resolvedFiles = files.map((file) => path.resolve(expandHome(file)));
    for (const file of resolvedFiles) {
      if (!fs.existsSync(file)) throw new CliError(`upload file not found: ${file}`, { code: "file_not_found", exitCode: 2 });
    }
    if (triggerSelector) {
      try {
        const payload = await this.uploadViaFileChooserTrigger(tab.targetId, triggerSelector, resolvedFiles, flags);
        const verify = await this.callFunction(tab.targetId, uploadVerifyFunction, [path.basename(resolvedFiles[0]), actionOptions(args, flags)]);
        return result({ text: `uploaded ${resolvedFiles.map((file) => path.basename(file)).join(", ")}`, target: tab, preflight, files: resolvedFiles, trigger: payload, verify });
      } catch (error) {
        throw new CliError(cleanActionErrorMessage(error), {
          code: "upload_guard",
          exitCode: 5,
          next: ["realbrowser action state -t <target> --root active --compact --screenshot --annotate-refs"],
        });
      }
    }
    let object;
    try {
      object = await this.evaluate(tab.targetId, `(() => {
        ${PAGE_HELPERS}
        const selector = ${JSON.stringify(selector)};
        const scoped = ${!flags.root || flags.root === "active" || flags.activeRoot ? "true" : "false"};
        const root = scoped ? activeRootElementSourceEval() : document;
        const el = root.querySelector(selector);
        if (!el) throw new Error("file input not found: " + selector);
        if (!(el instanceof HTMLInputElement) || el.type !== "file") throw new Error("target is not a file input");
        el.setAttribute("data-realbrowser-upload-target", "true");
        return el;
      })()`, { returnByValue: false });
    } catch (error) {
      throw new CliError(cleanActionErrorMessage(error), {
        code: "upload_guard",
        exitCode: 5,
        next: ["realbrowser action state -t <target> --root active --compact"],
      });
    }
    await this.sendToTarget(tab.targetId, "DOM.setFileInputFiles", { objectId: object.objectId, files: resolvedFiles });
    await this.callFunction(tab.targetId, uploadEventsFunction, [selector]).catch(() => {});
    const verify = await this.callFunction(tab.targetId, uploadVerifyFunction, [path.basename(resolvedFiles[0]), actionOptions(args, flags)]);
    return result({ text: `uploaded ${resolvedFiles.map((file) => path.basename(file)).join(", ")}`, target: tab, preflight, files: resolvedFiles, verify });
  }
  throw usage(`unknown action command: ${command}`);
};

BrowserDaemon.prototype.screenshot = async function screenshot(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `screenshot ${command}`);
  if (screenshotCommandMutates(command, flags)) await this.assertTargetLease(tab, flags, `screenshot ${command}`);
  await this.attach(tab.targetId);
  if (command === "device" || command === "responsive") {
    const prefix = args[0] || flags.out || path.join(this.artifactDir, `shot-${Date.now()}`);
    const devices = parseDevices(flags.devices);
    const results = [];
    const original = await this.callFunction(tab.targetId, viewportInfoFunction, []);
    try {
      for (const device of devices) {
        const mobile = Boolean(flags.mobile || flags.mobileEmulation || device.mobile);
        await this.sendToTarget(tab.targetId, "Emulation.setDeviceMetricsOverride", {
          width: device.width,
          height: device.height,
          deviceScaleFactor: device.dpr || 1,
          mobile,
          screenWidth: device.width,
          screenHeight: device.height,
        });
        await this.sendToTarget(tab.targetId, "Emulation.setTouchEmulationEnabled", { enabled: mobile }).catch(() => {});
        await sleep(Number(flags.settleMs || 250));
        if (flags.visualStable || flags.selector || flags.readyText || flags.minItems || flags.minCards || flags.noSkeletons) {
          await this.callFunction(tab.targetId, waitReadyFunction, [waitReadyOptions([], flags, flags.timeout || DEFAULT_TIMEOUT)], { timeoutMs: (flags.timeout || DEFAULT_TIMEOUT) + 1000 });
        }
        const filePath = `${prefix}.${device.name}.png`;
        const capture = await captureCheckpointScreenshot(this, tab.targetId, flags, filePath, {
          fullPage: Boolean(flags.full || flags.fullPage),
          selector: flags.selector || "",
        });
        results.push({ ...device, mobile, ...dimensionCheck(capture, device, { fullPage: Boolean(flags.full || flags.fullPage), selector: flags.selector || "" }), ...capture });
      }
    } finally {
      // Clear emulation so user-owned profile tabs return to the real window viewport.
      // Re-applying the old dimensions with setDeviceMetricsOverride leaves the tab emulated.
      await this.sendToTarget(tab.targetId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
      await this.sendToTarget(tab.targetId, "Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    }
    const restored = await this.callFunction(tab.targetId, viewportInfoFunction, []).catch(() => null);
    return result({ text: results.map((entry) => `${entry.name}: ${entry.path} ${entry.width}x${entry.height}${entry.dimensionOk === false ? ` expected ${entry.expected.width}x${entry.expected.height}` : ""}`).join("\n"), target: tab, screenshots: results, viewport: { original, restored, restoredBy: "Emulation.clearDeviceMetricsOverride" } });
  }
  const area = screenshotAreaArgs(command, args, flags);
  const out = area.out || flags.out || path.join(this.artifactDir, `screenshot-${Date.now()}.${extensionForFormat(defaultScreenshotFormat(flags))}`);
  const selector = area.selector ? this.selectorFor(tab.targetId, area.selector) : "";
  const capture = await captureCheckpointScreenshot(this, tab.targetId, flags, out, { fullPage: command === "full" || flags.full || flags.fullPage, selector });
  return result({ text: `${capture.path} ${capture.width}x${capture.height}`, target: tab, screenshot: capture });
};

function screenshotCommandMutates(command, flags = {}) {
  return command === "device" ||
    command === "responsive" ||
    command === "full" ||
    Boolean(flags.full || flags.fullPage) ||
    screenshotAnnotates(flags);
}

function screenshotAnnotates(flags = {}) {
  return Boolean(flags.annotateRefs || flags.annotate || flags.labels);
}

BrowserDaemon.prototype.console = async function consoleCommand(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `console ${command}`);
  if (command === "clear" || (command === "capture" && (flags.clear || flags.reload))) await this.assertTargetLease(tab, flags, `console ${command}`);
  await this.attach(tab.targetId);
  const buffer = this.consoleBuffer(tab.targetId);
  if (command === "clear") {
    buffer.clear();
    return result({ text: "console cleared", target: tab });
  }
  if (command === "capture") {
    if (flags.clear) buffer.clear();
    if (flags.reload) await this.sendToTarget(tab.targetId, "Page.reload", {});
    await sleep(Number(flags.duration || 3000));
  }
  const entries = buffer.toArray()
    .filter((entry) => !flags.errors || ["error", "warning"].includes(entry.level))
    .slice(-(Number(flags.limit || 80)));
  if (command === "get") {
    const id = args[0];
    const entry = entries.find((item) => item.id === id);
    if (!entry) throw usage(`console message not found: ${id}`);
    return result({ text: formatConsoleEntry(entry), target: tab, message: entry });
  }
  if (flags.out) await writeJsonFile(flags.out, entries);
  return result({ text: entries.map(formatConsoleEntry).join("\n") || "(no console messages)", target: tab, messages: entries, outPath: flags.out });
};

BrowserDaemon.prototype.network = async function networkCommand(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `network ${command}`);
  if (command === "clear" || command === "capture") await this.assertTargetLease(tab, flags, `network ${command}`);
  await this.attach(tab.targetId);
  const buffer = this.networkBuffer(tab.targetId);
  if (command === "clear") {
    buffer.clear();
    return result({ text: "network cleared", target: tab });
  }
  if (command === "capture") {
    assertNetworkCaptureBodyOut(flags);
    buffer.clear();
    if (flags.reload) await this.sendToTarget(tab.targetId, "Page.reload", {});
    await sleep(Number(flags.duration || 5000));
    const entries = buffer.toArray();
    if (flags.includeBody) {
      for (const entry of entries) {
        if (!entry.failed && entry.backendRequestId) {
          entry.responseBody = await this.getResponseBody(tab.targetId, entry).catch((error) => `[bodyUnavailable] ${error.message}`);
        }
      }
    }
    if (flags.out) await writeJsonFile(flags.out, entries);
    if (flags.har) await writeJsonFile(flags.har, buildHar(entries));
    const responseRequests = flags.includeBody && flags.force && !flags.out ? entries : compactRequests(entries, flags);
    return result({ text: `captured ${entries.length} requests${flags.out ? ` -> ${flags.out}` : ""}`, target: tab, requests: responseRequests, outPath: flags.out, harPath: flags.har });
  }
  if (command === "export") {
    const out = flags.out || args[0];
    if (!out) throw usage("network export requires --out <path>");
    await writeJsonFile(out, buildHar(buffer.toArray()));
    return result({ text: `HAR written: ${out}`, target: tab, outPath: out });
  }
  const entries = filterRequests(buffer.toArray(), flags);
  if (command === "get" || command === "body") {
    const entry = resolveRequestEntry(entries, args[0], flags.latest);
    if (!entry) throw usage(`network request not found: ${args[0]}`);
    if (command === "body" || flags.response || flags.request) {
      const body = flags.request ? entry.postData || "" : await this.getResponseBody(tab.targetId, entry);
      const out = flags.out || flags.responseFile || flags.requestFile;
      if (flags.full && !out && !flags.force) {
        throw new CliError("network body --full requires --out unless --force is explicit", {
          code: "large_stdout_guard",
          exitCode: 2,
          next: ["realbrowser network body -t app req_12 --response --out tmp/body.txt --full"],
        });
      }
      if (out) await writeTextArtifact(out, body);
      const clipped = truncate(body, flags.full ? body.length : Number(flags.maxChars || 4000));
      return result({
        text: out ? `body written: ${out}` : clipped.text,
        target: tab,
        request: compactRequest(entry),
        body: out ? undefined : clipped.text,
        bodyChars: clipped.chars,
        truncated: clipped.truncated,
        outPath: out,
      });
    }
    const detail = flags.values ? entry : redactRequest(entry);
    if (flags.out) await writeJsonFile(flags.out, detail);
    return result({ text: flags.out ? `request written: ${flags.out}` : formatValue(detail), target: tab, request: detail, outPath: flags.out });
  }
  const compact = compactRequests(entries, flags);
  if (flags.out) await writeJsonFile(flags.out, flags.values ? entries : compact);
  return result({ text: compact.map(formatRequestLine).join("\n") || "(no network requests)", target: tab, requests: compact, outPath: flags.out });
};

BrowserDaemon.prototype.getResponseBody = async function getResponseBody(targetId, entry) {
  if (!entry.backendRequestId) return "";
  const sessionId = await this.attach(targetId);
  const body = await this.cdp.send("Network.getResponseBody", { requestId: entry.backendRequestId }, sessionId).catch((error) => ({ bodyUnavailable: error.message }));
  if (body.bodyUnavailable) return `[bodyUnavailable] ${body.bodyUnavailable}`;
  return body.base64Encoded ? Buffer.from(body.body || "", "base64").toString("utf8") : (body.body || "");
};

BrowserDaemon.prototype.state = async function state(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `state ${command}`);
  if (stateCommandMutates(command, args)) await this.assertTargetLease(tab, flags, `state ${command}`);
  await this.attach(tab.targetId);
  if (command === "cookies") {
    const sub = args[0] || "list";
    if (sub === "set") {
      const cookie = parseCookie(args[1], tab.url);
      await this.sendToTarget(tab.targetId, "Network.setCookie", cookie);
      return result({ text: `cookie set: ${cookie.name}`, target: tab });
    }
    if (sub === "clear") {
      const name = flags.name || args[1] || "";
      const payload = await this.callFunction(tab.targetId, clearCookieFunction, [name]);
      return result({ text: `cookies cleared: ${payload.cleared.join(", ")}`, target: tab, ...payload });
    }
    const cookies = await this.sendToTarget(tab.targetId, "Network.getCookies", {});
    const out = flags.values ? cookies.cookies : cookies.cookies?.map((cookie) => ({ ...cookie, value: `[redacted ${String(cookie.value || "").length} chars]` }));
    return result({ text: formatValue(out), target: tab, cookies: out });
  }
  if (command === "storage") {
    const payload = await this.callFunction(tab.targetId, storageFunction, [args, Boolean(flags.values)]);
    return result({ text: formatValue(payload), target: tab, storage: payload });
  }
  if (command === "cache") {
    const payload = await this.callFunction(tab.targetId, cacheClearFunction, []);
    return result({ text: `cache cleared: ${payload.cleared}`, target: tab, ...payload });
  }
  if (command === "headers") {
    const sub = args[0] || "list";
    if (sub === "clear") {
      await this.sendToTarget(tab.targetId, "Network.setExtraHTTPHeaders", { headers: {} });
      return result({ text: "extra HTTP headers cleared", target: tab, headers: {} });
    }
    if (sub === "set") {
      const headers = parseHeaderFlags(flags.header || args.slice(1));
      await this.sendToTarget(tab.targetId, "Network.setExtraHTTPHeaders", { headers });
      return result({ text: `extra HTTP headers set: ${Object.keys(headers).join(", ")}`, target: tab, headers: flags.values ? headers : redactHeaders(headers) });
    }
    return result({ text: "extra headers are write-only in CDP; use state headers set|clear", target: tab });
  }
  if (command === "permissions") {
    const sub = args[0] || "list";
    const origin = flags.origin || originFromUrl(tab.url);
    if (sub === "reset" || sub === "clear") {
      assertBrowserWideStateChangeAllowed("state permissions reset", flags);
      await this.cdp.send("Browser.resetPermissions", {});
      return result({ text: "permissions reset", target: tab, origin });
    }
    if (sub === "grant") {
      const permission = args[1] || flags.name;
      if (!permission) throw usage("state permissions grant requires <permission>");
      assertBrowserWideStateChangeAllowed("state permissions grant", flags);
      await this.cdp.send("Browser.grantPermissions", { origin, permissions: [permission] });
      return result({ text: `permission granted: ${permission} ${origin}`, target: tab, origin, permissions: [permission] });
    }
    return result({ text: "permissions are managed with grant/reset", target: tab, origin });
  }
  if (command === "clipboard") {
    const sub = args[0] || "read";
    if (sub === "write") {
      const value = valueFromArgs(args.slice(1), flags);
      if (value === undefined) throw usage("state clipboard write requires <text> or --stdin/--value-file");
      const payload = await this.callFunction(tab.targetId, clipboardWriteFunction, [value], { timeoutMs: flags.timeout || DEFAULT_TIMEOUT });
      return result({ text: `clipboard written ${value.length} chars`, target: tab, ...payload, value: undefined });
    }
    const payload = await this.callFunction(tab.targetId, clipboardReadFunction, [], { timeoutMs: flags.timeout || DEFAULT_TIMEOUT });
    return result({
      text: flags.values ? payload.value : `[redacted ${String(payload.value || "").length} chars]`,
      target: tab,
      clipboard: flags.values ? payload.value : `[redacted ${String(payload.value || "").length} chars]`,
      chars: String(payload.value || "").length,
    });
  }
  if (command === "emulate") {
    const payload = await emulate(this, tab.targetId, args, flags);
    return result({ text: payload.text, target: tab, ...payload });
  }
  throw usage(`unknown state command: ${command}`);
};

function stateCommandMutates(command, args = []) {
  const sub = args[0] || "";
  if (command === "cookies") return ["set", "clear"].includes(sub);
  if (command === "storage") return ["set", "clear", "remove"].includes(sub);
  if (command === "cache") return true;
  if (command === "headers") return ["set", "clear"].includes(sub);
  if (command === "permissions") return ["grant", "reset", "clear"].includes(sub);
  if (command === "clipboard") return sub === "write";
  if (command === "emulate") return true;
  return false;
}

function assertBrowserWideStateChangeAllowed(operation, flags = {}) {
  if (flags.force) return;
  throw new CliError(`${operation} requires --force because Chrome permissions are browser-wide`, {
    code: "browser_wide_state_guard",
    exitCode: 5,
    next: [`rerun with ${operation} ... --force only when intentionally changing browser-wide permissions`],
  });
}

BrowserDaemon.prototype.dialog = async function dialog(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `dialog ${command}`);
  if (["arm", "accept", "dismiss"].includes(command)) await this.assertTargetLease(tab, flags, `dialog ${command}`);
  await this.attach(tab.targetId);
  const buffer = this.dialogBuffer(tab.targetId);
  if (command === "arm") {
    const action = args[0] || "accept";
    this.dialogArms.set(tab.targetId, { action, text: flags.text || args.slice(1).join(" ") || "" });
    return result({ text: `armed ${action} for next dialog`, target: tab });
  }
  if (command === "accept" || command === "dismiss") {
    this.dialogArms.set(tab.targetId, { action: command, text: flags.text || args.join(" ") || "" });
    return result({ text: `armed ${command} for next dialog`, target: tab });
  }
  return result({ text: buffer.toArray().map((entry) => `${entry.type} "${entry.message}" -> ${entry.action}`).join("\n") || "(no dialogs)", target: tab, dialogs: buffer.toArray() });
};

BrowserDaemon.prototype.perf = async function perf(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `perf ${command}`);
  if (command === "trace" && ["start", "stop"].includes(args[0] || "start")) await this.assertTargetLease(tab, flags, `perf ${command}`);
  await this.attach(tab.targetId);
  if (command === "trace") {
    const action = args[0] || "start";
    if (action === "start") {
      await this.sendToTarget(tab.targetId, "Tracing.start", { categories: "devtools.timeline,blink.user_timing", transferMode: "ReturnAsStream" });
      return result({ text: "trace started", target: tab });
    }
    if (action === "stop") {
      const sessionId = await this.attach(tab.targetId);
      const done = this.cdp.waitFor("Tracing.tracingComplete", (_params, message) => !message.sessionId || message.sessionId === sessionId, flags.timeout || 30_000);
      await this.cdp.send("Tracing.end", {}, sessionId);
      const { params } = await done;
      const data = params.stream ? await readCdpStream(this.cdp, params.stream, sessionId, flags.timeout || 30_000) : "";
      const out = path.resolve(expandHome(flags.out || path.join(this.artifactDir, `trace-${Date.now()}.json`)));
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await fsp.writeFile(out, data);
      return result({ text: `trace written: ${out} ${Buffer.byteLength(data)}B`, target: tab, path: out, bytes: Buffer.byteLength(data) });
    }
  }
  const payload = await this.callFunction(tab.targetId, perfFunction, []);
  return result({ text: formatValue(payload), target: tab, perf: payload });
};

BrowserDaemon.prototype.download = async function download(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `download ${command}`);
  await this.assertTargetLease(tab, flags, `download ${command}`);
  await this.attach(tab.targetId);
  const dir = path.resolve(expandHome(flags.dir || flags.downloadDir || path.join(os.homedir(), "Downloads")));
  await fsp.mkdir(dir, { recursive: true });
  await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir }).catch(() => {});
  if (command === "click") {
    const before = await listFiles(dir);
    const ref = args[0];
    if (!ref) throw usage("download click requires <ref|selector>");
    const preflight = await this.callFunction(tab.targetId, actionPreflightFunction, []).catch(() => ({}));
    await callAndDispatchMouseClickWithFileChooserGuard(this, tab.targetId, this.selectorFor(tab.targetId, ref), {}, {
      allowFileDialog: Boolean(flags.allowFileDialog),
      command: "download",
      ref,
      guardMs: preflight.visibility === "visible" && preflight.hasFocus ? FILE_CHOOSER_CLICK_GUARD_MS : FILE_CHOOSER_BACKGROUND_CLICK_GUARD_MS,
      timeoutMs: flags.timeout || DEFAULT_TIMEOUT,
    });
    const file = await waitForNewDownload(dir, before, flags.timeout || 120_000);
    const out = flags.out ? path.resolve(expandHome(flags.out)) : file;
    if (out !== file) await fsp.copyFile(file, out);
    return result({ text: `downloaded: ${out}`, target: tab, path: out });
  }
  const before = await listFiles(dir);
  const file = await waitForNewDownload(dir, before, flags.timeout || 120_000);
  return result({ text: `downloaded: ${file}`, target: tab, path: file });
};

BrowserDaemon.prototype.export = async function exportCommand(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `export ${command}`);
  await this.attach(tab.targetId);
  if (command !== "pdf") throw usage(`unknown export command: ${command}`);
  const out = path.resolve(expandHome(args[0] || flags.out || path.join(this.artifactDir, `page-${Date.now()}.pdf`)));
  const pdf = await this.sendToTarget(tab.targetId, "Page.printToPDF", {
    printBackground: Boolean(flags.printBackground),
    paperWidth: flags.format === "A4" ? 8.27 : undefined,
    paperHeight: flags.format === "A4" ? 11.69 : undefined,
  }, flags.timeout || 60_000);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, Buffer.from(pdf.data || "", "base64"));
  const stat = await fsp.stat(out);
  return result({ text: `pdf written: ${out} ${stat.size}B`, target: tab, path: out, bytes: stat.size });
};

BrowserDaemon.prototype.devtools = async function devtools(command, args, flags) {
  const tab = await this.resolveTargetForOperation(flags.target, flags, `devtools ${command}`);
  await this.attach(tab.targetId);
  if (command === "list") {
    return result({ text: "raw CDP available; use devtools raw -t <target> <Domain.method> --params '{...}'", target: tab });
  }
  const method = args[0];
  if (!method) throw usage("devtools raw requires <CDP.method>");
  const mutating = rawCdpMethodMutates(method);
  if (mutating && !flags.force) {
    throw new CliError(`raw mutating CDP method requires --force: ${method}`, { code: "raw_mutation_guard", exitCode: 5 });
  }
  if (mutating) await this.assertTargetLease(tab, flags, `devtools raw ${method}`);
  const params = flags.params ? JSON.parse(flags.params) : args[1] ? JSON.parse(args[1]) : {};
  const payload = await this.sendToTarget(tab.targetId, method, params, flags.timeout || DEFAULT_TIMEOUT);
  return result({ text: formatValue(payload), target: tab, result: payload });
};

function rawCdpMethodMutates(method) {
  const value = String(method || "");
  return /^(Input|Runtime\.evaluate|Runtime\.callFunctionOn|Page\.(navigate|reload|stopLoading|set|bringToFront|close)|Browser|Storage|Network\.(set|clear|delete|emulate)|Emulation|DOM\.setFileInputFiles|CSS\.(set|force)|Fetch|Target\.(create|close|activate|attach|detach|set|dispose))/.test(value);
}

BrowserDaemon.prototype.chain = async function chain(args, flags) {
  const raw = flags.from ? await fsp.readFile(expandHome(flags.from), "utf8") : args[0];
  if (!raw) throw usage("chain requires JSON steps");
  const steps = JSON.parse(raw);
  if (!Array.isArray(steps)) throw usage("chain JSON must be an array");
  const foreachRaw = flags.foreachData || (flags.foreach ? await fsp.readFile(expandHome(flags.foreach), "utf8") : "");
  const foreachItems = foreachRaw ? JSON.parse(foreachRaw) : null;
  if (foreachItems && !Array.isArray(foreachItems)) throw usage("chain --foreach must be a JSON array");
  const variableName = flags.var || "item";
  const fixedVars = parseSetVariables(flags.set);
  const results = [];
  const iterations = foreachItems || [undefined];
  for (let iterationIndex = 0; iterationIndex < iterations.length; iterationIndex += 1) {
    const variables = { ...fixedVars, [variableName]: iterations[iterationIndex], index: iterationIndex };
    for (const templateStep of steps) {
      const step = substituteVariables(templateStep, variables);
      const parsed = Array.isArray(step) ? parseCli(step.map(String)) : { ...step, flags: { ...(step.flags || {}) } };
      const started = Date.now();
      try {
        const stepContextFlags = ["context", "profile", "browserUrl", "anonymous", "session"].filter((key) => parsed.flags?.[key]);
        if (stepContextFlags.length) {
          throw new CliError(`chain steps cannot switch browser context (${stepContextFlags.join(", ")})`, {
            code: "chain_context_scope",
            exitCode: 2,
            next: ["put --profile, --anonymous --session, or --browser-url on the chain command"],
          });
        }
        if (flags.target && TARGET_REQUIRED_GROUPS.has(parsed.group) && !parsed.flags.target) parsed.flags.target = flags.target;
        const res = await this.dispatch(parsed);
        results.push({
          ok: true,
          iteration: foreachItems ? iterationIndex + 1 : undefined,
          step: parsed.group + " " + parsed.command,
          ms: Date.now() - started,
          result: flags.return === "all" ? res : compactChainResult(res),
        });
      } catch (error) {
        results.push({
          ok: false,
          iteration: foreachItems ? iterationIndex + 1 : undefined,
          step: parsed.group + " " + parsed.command,
          ms: Date.now() - started,
          error: error.message,
        });
        if (!flags.continueOnError) break;
      }
    }
    if (results.at(-1)?.ok === false && !flags.continueOnError) break;
  }
  const text = results.map((entry, index) => `${index + 1}. ${entry.ok ? "ok" : "fail"} ${entry.step} ${entry.ms}ms${entry.error ? ` ${entry.error}` : ""}`).join("\n");
  if (flags.out) await writeJsonFile(flags.out, results);
  if (flags.return === "final") return result({ text: results.at(-1)?.result?.text || text, results: [results.at(-1)].filter(Boolean), outPath: flags.out });
  return result({ text, results, outPath: flags.out });
};

BrowserDaemon.prototype.uploadViaFileChooserTrigger = async function uploadViaFileChooserTrigger(targetId, triggerSelector, resolvedFiles, flags = {}) {
  const sessionId = await this.attach(targetId);
  const timeout = Math.max(500, Math.min(120_000, Number(flags.timeout || 30_000)));
  await this.sendToTarget(targetId, "Page.setInterceptFileChooserDialog", { enabled: true });
  const chooserPromise = this.cdp.waitFor(
    "Page.fileChooserOpened",
    (_params, message) => message.sessionId === sessionId,
    timeout,
  );
  chooserPromise.catch(() => {});
  let clickPayload;
  try {
    clickPayload = await this.callFunction(targetId, clickFunction, [
      triggerSelector,
      { ...actionOptions([], flags), allowFileDialog: true, fileDialogIntent: true },
    ], { timeoutMs: timeout });
    await dispatchMouseClick(this, targetId, clickPayload.center.x, clickPayload.center.y);
    const { params } = await chooserPromise;
    if (!params.backendNodeId) {
      throw new Error("file chooser did not expose backendNodeId");
    }
    await this.sendToTarget(targetId, "DOM.setFileInputFiles", {
      backendNodeId: params.backendNodeId,
      files: resolvedFiles,
    });
    const events = await this.dispatchUploadEventsForBackendNode(targetId, params.backendNodeId).catch((error) => ({ error: cleanActionErrorMessage(error) }));
    return {
      ref: clickPayload.ref,
      text: clickPayload.text,
      backendNodeId: params.backendNodeId,
      mode: params.mode,
      events,
    };
  } finally {
    await this.sendToTarget(targetId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
};

BrowserDaemon.prototype.dispatchUploadEventsForBackendNode = async function dispatchUploadEventsForBackendNode(targetId, backendNodeId) {
  const resolved = await this.sendToTarget(targetId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved?.object?.objectId;
  if (!objectId) return { dispatched: false };
  const result = await this.sendToTarget(targetId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return { dispatched: true, files: this.files?.length || 0, tag: this.tagName.toLowerCase() };
    }`,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(formatCdpException(result.exceptionDetails));
  return cdpValue(result.result);
};

BrowserDaemon.prototype.daemon = async function daemon(command) {
  if (command === "stop") {
    setTimeout(() => this.shutdown(), 10).unref();
    return result({ text: "stopping" });
  }
  return result({ text: `daemon ok ${VERSION}`, daemon: { version: VERSION, context: this.publicContext(), sessions: this.sessions.size } });
};

async function handleProfileCli(parsed) {
  const profiles = await listProfiles(parsed.flags.browser);
  const query = parsed.args[0] || "";
  const filtered = (query ? profiles.filter((p) => profileSearchText(p).toLowerCase().includes(query.toLowerCase())) : profiles)
    .filter((p) => !parsed.flags.active || p.active);
  if (parsed.command === "inspect") {
    const profile = await resolveProfile(query || parsed.args[0], parsed.flags.browser);
    return result({ text: formatValue(profile), profile });
  }
  if (parsed.command === "relaunch") {
    const profile = await resolveProfile(query || parsed.args[0], parsed.flags.browser);
    return await relaunchProfileCli(profile, parsed.flags);
  }
  const rows = filtered.map((p) => `${p.id.padEnd(24)} ${(p.active ? "active" : (p.userDataInUse ? "locked" : "")).padEnd(6)} ${(p.cdpScope || "").padEnd(7)} ${p.displayName || ""} ${p.email || ""}`);
  const text = rows.length
    ? [`${"PROFILE_ID".padEnd(24)} ${"STATUS".padEnd(6)} ${"CDP".padEnd(7)} NAME EMAIL`, ...rows].join("\n")
    : "";
  const runningWithoutCdp = parsed.flags.active && filtered.length === 0 && profiles.some((p) => p.userDataInUse);
  return result({
    text: text || (runningWithoutCdp
      ? "(no active DevTools profiles; Chrome user data is running without a DevToolsActivePort direct WebSocket endpoint)\nnext:\n  realbrowser profile list\n  if Chrome shows a debugging approval prompt, approve it and retry\n  last resort: ask user approval, then run realbrowser profile relaunch <profile> --confirm"
      : "(no profiles)"),
    profiles: filtered,
    blockedProfiles: runningWithoutCdp ? profiles.filter((p) => p.userDataInUse).map((p) => ({ id: p.id, displayName: p.displayName, email: p.email, userDataInUse: true, endpoint: null })) : undefined,
  });
}

async function relaunchProfileCli(profile, flags = {}) {
  if (!flags.confirm && !flags.yes && !flags.force) {
    throw new CliError(`profile relaunch requires explicit confirmation: ${profile.id}`, {
      code: "confirmation_required",
      exitCode: 5,
      next: [
        `Ask the user: "May I quit and relaunch ${profile.browserName || profile.browser} with remote debugging for ${profile.id}? This closes current Chrome windows."`,
        `realbrowser profile relaunch "${profile.id}" --confirm`,
      ],
    });
  }
  const wasRunning = profileUserDataInUse(profile.userDataDir);
  if (wasRunning) {
    await quitBrowserForProfile(profile, { force: Boolean(flags.force) });
    const released = await waitForProfileRelease(profile.userDataDir, Number(flags.timeout || 15_000));
    if (!released) {
      throw new CliError(`browser did not quit cleanly for ${profile.id}`, {
        code: "profile_quit_timeout",
        exitCode: 4,
        next: [
          `quit ${profile.browserName || profile.browser} manually, then retry`,
          `realbrowser profile relaunch "${profile.id}" --confirm`,
        ],
      });
    }
  }
  const endpoint = await launchProfileEndpoint(profile, {
    front: Boolean(flags.front),
    timeout: Number(flags.timeout || START_TIMEOUT),
    url: flags.url || "about:blank",
  });
  return result({
    text: `relaunched ${profile.id} with DevTools ${endpointBrowserUrl(endpoint)}`,
    profile: { id: profile.id, displayName: profile.displayName, email: profile.email },
    endpoint,
    closedExistingBrowser: wasRunning,
  });
}

async function handleSessionCli(parsed) {
  const states = listStateFiles().map((file) => readJson(file)).filter(Boolean);
  const owner = resolveOwner(parsed.flags);
  if (parsed.command === "use") {
    const context = parsed.args[0] || parsed.flags.context || parsed.flags.profile || parsed.flags.browserUrl || parsed.flags.session;
    if (!context) throw usage("session use requires <context>, e.g. anonymous:check, profile:chrome:Default, or endpoint:http://127.0.0.1:9222");
    const flags = contextFlagsFromString(context);
    const defaultContext = await setDefaultContextForOwner(owner, context, flags);
    return result({ text: `default context for ${owner}: ${context}`, defaultContext });
  }
  if (parsed.command === "clear") {
    if (parsed.flags.all) {
      await fsp.rm(DEFAULT_CONTEXT_FILE, { force: true });
      return result({ text: "all default contexts cleared" });
    }
    await clearDefaultContextForOwner(owner);
    return result({ text: `default context cleared for ${owner}` });
  }
  if (parsed.command === "stop") {
    const query = parsed.args[0] || parsed.flags.session || "";
    for (const state of states) {
      const stateOwner = normalizeOwner(state.context?.owner) || "default";
      if (!parsed.flags.all && stateOwner !== owner) continue;
      if (!query || state.context?.session === query || state.context?.key?.includes(query)) {
        await stopDaemonState(state).catch(() => {});
      }
    }
    return result({ text: `stopped ${query || "all matching sessions"} for ${parsed.flags.all ? "all owners" : owner}` });
  }
  const defaultContext = defaultContextEntryForOwner(owner);
  const allDefaults = defaultContextsByOwner();
  return result({
    text: [
      defaultContext ? `default ${owner} ${defaultContext.context}` : "",
      states.map((s) => `${s.context?.key || "unknown"} owner=${s.context?.owner || "default"} pid=${s.pid} port=${s.port}`).join("\n"),
    ].filter(Boolean).join("\n") || "(no sessions)",
    sessions: states.map(publicDaemonState),
    defaultContext,
    defaultContexts: allDefaults,
    owner,
  });
}

async function handleDaemonCli(parsed) {
  if (parsed.command === "doctor") {
    const profiles = await listProfiles(parsed.flags.browser);
    return result({
      text: [
        `realbrowser ${VERSION}`,
        `node ${process.version}`,
        `state ${STATE_DIR}`,
        `profiles ${profiles.length}`,
        `browser executable ${findBrowserExecutable(parsed.flags.browser) || "(not found)"}`,
      ].join("\n"),
      version: VERSION,
      stateDir: STATE_DIR,
      profiles,
    });
  }
  const states = listStateFiles().map((file) => readJson(file)).filter(Boolean);
  if (parsed.command === "stop" || parsed.command === "restart") {
    for (const state of states) await stopDaemonState(state).catch(() => {});
    return result({ text: parsed.command === "restart" ? "stopped daemons; next command will restart" : "stopped daemons" });
  }
  const daemons = parsed.command === "monitor" ? await Promise.all(states.map(async (state) => ({
    ...publicDaemonState(state),
    health: await daemonHealth(state).catch((error) => ({ ok: false, error: error.message })),
  }))) : states.map(publicDaemonState);
  return result({
    text: daemons.map((s) => `${s.context?.key || "unknown"} pid=${s.pid} alive=${s.alive} port=${s.port}${s.health?.targetCount != null ? ` targets=${s.health.targetCount} sessions=${s.health.sessions}` : ""}`).join("\n") || "(no daemons)",
    daemons,
  });
}

async function writeHandleFromResponse(parsed, response, context) {
  const target = response.target;
  if (!target) return response;
  const name = parsed.flags.handleName || parsed.flags.name || parsed.args[0] || target.suggestedTarget;
  const out = parsed.flags.handleOut || parsed.flags.out || handlePath(name);
  const handle = {
    kind: "realbrowser-handle",
    version: 1,
    name,
    target: target.suggestedTarget,
    targetId: target.targetId,
    label: target.label,
    url: target.url,
    title: target.title,
    context: context.flags || context,
    createdAt: new Date().toISOString(),
  };
  await writeJsonFile(out, handle);
  return result({ text: `handle written: ${out}`, handle, path: out });
}

async function releaseHandleCli(parsed) {
  const name = parsed.args[0] || parsed.flags.name || parsed.flags.handleName;
  if (!name) throw usage("handle release requires <name|path>");
  await fsp.rm(fs.existsSync(expandHome(name)) ? expandHome(name) : handlePath(name), { force: true });
  return result({ text: `released handle ${name}`, released: name });
}

async function listHandles() {
  await fsp.mkdir(HANDLES_DIR, { recursive: true });
  const files = await fsp.readdir(HANDLES_DIR).catch(() => []);
  const handles = files.filter((file) => file.endsWith(".json")).map((file) => readJson(path.join(HANDLES_DIR, file))).filter(Boolean);
  return result({ text: handles.map((h) => `${h.name || path.basename(h.path || "")} ${h.target || h.targetId} ${h.url || ""}`).join("\n") || "(no handles)", handles });
}

async function hydrateChainInput(parsed) {
  if (parsed.flags.from === "-") {
    parsed.args[0] = fs.readFileSync(0, "utf8");
    delete parsed.flags.from;
  } else if (!parsed.flags.from && !parsed.args.length && !process.stdin.isTTY) {
    const stdin = fs.readFileSync(0, "utf8");
    if (stdin.trim()) parsed.args[0] = stdin;
  }
  if (parsed.flags.foreach === "-") {
    parsed.flags.foreachData = fs.readFileSync(0, "utf8");
    delete parsed.flags.foreach;
  }
}

async function readHandle(nameOrPath) {
  const p = fs.existsSync(expandHome(nameOrPath)) ? expandHome(nameOrPath) : handlePath(nameOrPath);
  const handle = readJson(p);
  if (!handle) throw usage(`handle not found: ${nameOrPath}`);
  return handle;
}

function handlePath(name) {
  const safe = String(name).replace(/[^A-Za-z0-9_.-]+/g, "_") || "handle";
  return path.join(HANDLES_DIR, `${safe}.json`);
}

function listStateFiles() {
  try {
    return fs.readdirSync(STATE_DIR)
      .filter((file) => /^daemon-[a-f0-9]{16}\.json$/.test(file))
      .map((file) => path.join(STATE_DIR, file));
  } catch {
    return [];
  }
}

function publicDaemonState(state) {
  return {
    pid: state.pid,
    port: state.port,
    version: state.version,
    runtimeSchema: state.runtimeSchema,
    startedAt: state.startedAt,
    alive: processAlive(state.pid),
    context: state.context,
    browserUrl: state.browserUrl,
  };
}

async function stopDaemonState(state) {
  if (!state?.pid || !processAlive(state.pid)) return;
  try {
    await httpRequest({
      method: "POST",
      url: `http://127.0.0.1:${state.port}/rpc`,
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ payload: { group: "daemon", command: "stop", args: [], flags: {} } }),
      timeoutMs: 1000,
    });
  } catch {
    try { process.kill(state.pid, "SIGTERM"); } catch {}
  }
  // Wait for graceful exit; if the daemon ignores stop+SIGTERM, SIGKILL it.
  for (let i = 0; i < 15; i++) {
    if (!processAlive(state.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(state.pid, "SIGKILL"); } catch {}
}

async function daemonHealth(state, timeoutMs = 1000) {
  const response = await httpRequest({
    method: "GET",
    url: `http://127.0.0.1:${state.port}/health`,
    headers: { authorization: `Bearer ${state.token}` },
    timeoutMs,
  });
  if (response.statusCode !== 200) throw new Error(`health HTTP ${response.statusCode}`);
  return JSON.parse(response.body);
}

async function listProfiles(browserFilter = "") {
  const bases = browserBases().filter((base) => !browserFilter || base.browser === browserFilter || base.id === browserFilter);
  const profiles = [];
  for (const base of bases) {
    if (!fs.existsSync(base.userDataDir)) continue;
    const localState = readJson(path.join(base.userDataDir, "Local State")) || {};
    const infoCache = localState.profile?.info_cache || {};
    const lastUsed = localState.profile?.last_used || "";
    const dirs = new Set(["Default"]);
    for (const name of Object.keys(infoCache)) dirs.add(name);
    try {
      for (const entry of fs.readdirSync(base.userDataDir)) {
        if (entry === "Default" || /^Profile \d+$/.test(entry)) dirs.add(entry);
      }
    } catch {}
    for (const dir of dirs) {
      const profileDir = path.join(base.userDataDir, dir);
      if (!fs.existsSync(profileDir)) continue;
      const prefs = readJson(path.join(profileDir, "Preferences")) || {};
      const endpoint = await activeEndpointFromProfilePaths(base.userDataDir, profileDir);
      profiles.push({
        id: `${base.browser}:${dir}`,
        browser: base.browser,
        browserName: base.name,
        appName: base.appName,
        userDataDir: base.userDataDir,
        profileDir,
        profileDirName: dir,
        lastUsed,
        displayName: infoCache[dir]?.name || prefs.profile?.name || dir,
        email: infoCache[dir]?.user_name || prefs.account_info?.[0]?.email || "",
        active: Boolean(endpoint),
        cdpScope: endpoint?.scope || "",
        profileScoped: endpoint?.scope === "profile",
        userDataInUse: profileUserDataInUse(base.userDataDir),
        endpoint,
      });
    }
  }
  return profiles;
}

async function resolveProfile(query, browserFilter = "") {
  const profiles = await listProfiles(browserFilter);
  const normalized = String(query || "").toLowerCase();
  const matches = profiles.filter((p) => (
    p.id.toLowerCase() === normalized ||
    p.profileDirName.toLowerCase() === normalized ||
    p.email.toLowerCase() === normalized ||
    profileSearchText(p).toLowerCase().includes(normalized)
  ));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new CliError(`profile not found: ${query}`, { code: "profile_not_found", exitCode: 4, next: ["realbrowser profile list"] });
  throw new CliError(`ambiguous profile: ${query}\n${matches.map((p) => `  ${p.id} ${p.displayName} ${p.email}`).join("\n")}`, { code: "profile_ambiguous", exitCode: 4 });
}

function profileSearchText(profile) {
  return `${profile.id} ${profile.browser} ${profile.browserName} ${profile.profileDirName} ${profile.displayName} ${profile.email}`;
}

function profileUserDataInUse(userDataDir) {
  if (!userDataDir) return false;
  return ["SingletonLock", "SingletonSocket", "SingletonCookie", "RunningChromeVersion"]
    .some((name) => fs.existsSync(path.join(userDataDir, name)));
}

async function waitForProfileRelease(userDataDir, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!profileUserDataInUse(userDataDir)) return true;
    await sleep(250);
  }
  return !profileUserDataInUse(userDataDir);
}

async function quitBrowserForProfile(profile, { force = false } = {}) {
  const name = profile.appName || profile.browserName || profile.browser;
  if (process.platform === "darwin") {
    await runProcess("osascript", ["-e", `tell application "${name}" to quit`], 8_000).catch((error) => {
      throw new CliError(`could not ask ${name} to quit: ${error.message}`, {
        code: "profile_quit_failed",
        exitCode: 4,
        next: [`quit ${name} manually, then retry profile relaunch`],
      });
    });
    if (force) await runProcess("pkill", ["-TERM", "-x", name], 5_000).catch(() => {});
    return;
  }
  const executable = path.basename(findBrowserExecutable(profile.browser) || profile.browser || "chrome");
  if (IS_WINDOWS) {
    const image = executable.toLowerCase().endsWith(".exe") ? executable : `${executable}.exe`;
    await runProcess("taskkill", ["/IM", image, "/T"], 8_000).catch((error) => {
      throw new CliError(`could not quit ${image}: ${error.message}`, {
        code: "profile_quit_failed",
        exitCode: 4,
        next: [`quit ${profile.browserName || profile.browser} manually, then retry profile relaunch`],
      });
    });
    return;
  }
  await runProcess("pkill", ["-TERM", "-f", profile.userDataDir || executable], 8_000).catch((error) => {
    throw new CliError(`could not quit ${profile.browserName || profile.browser}: ${error.message}`, {
      code: "profile_quit_failed",
      exitCode: 4,
      next: [`quit ${profile.browserName || profile.browser} manually, then retry profile relaunch`],
    });
  });
}

async function launchProfileEndpoint(profile, { front = false, timeout = START_TIMEOUT, url = "about:blank" } = {}) {
  const executable = findBrowserExecutable(profile.browser);
  if (!executable) throw new Error(`could not find executable for ${profile.browser}`);
  const port = await findFreePort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--profile-directory=${profile.profileDirName}`,
    "--new-tab",
    url,
  ];
  if (profile.userDataDir) args.unshift(`--user-data-dir=${profile.userDataDir}`);
  // Use the browser binary directly for the same reason as profile tab open:
  // `open --args` is convenient but not reliable for profile routing.
  const focusRestore = await captureForegroundAppForBackgroundLaunch({ front });
  const child = spawn(executable, args, { detached: true, stdio: "ignore" });
  child.unref();
  await restoreForegroundAppAfterBackgroundLaunch(focusRestore, { delayMs: 250 }).catch(() => {});
  const endpoint = await waitForProfileDevtoolsEndpoint(profile, `http://127.0.0.1:${port}`, timeout);
  await restoreForegroundAppAfterBackgroundLaunch(focusRestore, { delayMs: 50 }).catch(() => {});
  return endpoint;
}

async function waitForProfileDevtoolsEndpoint(profile, httpUrl, timeoutMs = START_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = await activeEndpointFromProfilePaths(profile.userDataDir, profile.profileDir);
    if (endpoint) return endpoint;
    const wsUrl = await discoverBrowserWs(httpUrl, 1000).catch(() => "");
    if (wsUrl) return { httpUrl, wsUrl };
    await sleep(150);
  }
  throw new Error(`launched profile but DevTools endpoint did not become ready: ${httpUrl}`);
}

async function waitForDevtoolsPortFile(portFile, timeoutMs, { errorMessage, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = endpointFromPortFile(portFile);
    if (endpoint && await endpointReachable(endpoint)) return endpoint;
    await sleep(pollMs);
  }
  throw new Error(errorMessage || `DevToolsActivePort did not become ready: ${portFile}`);
}

function runProcess(command, args = [], timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

function runProcessOutput(command, args = [], timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function browserBases() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      { browser: "chrome", name: "Google Chrome", appName: "Google Chrome", userDataDir: path.join(home, "Library/Application Support/Google/Chrome") },
      { browser: "chromium", name: "Chromium", appName: "Chromium", userDataDir: path.join(home, "Library/Application Support/Chromium") },
      { browser: "brave", name: "Brave", appName: "Brave Browser", userDataDir: path.join(home, "Library/Application Support/BraveSoftware/Brave-Browser") },
      { browser: "edge", name: "Microsoft Edge", appName: "Microsoft Edge", userDataDir: path.join(home, "Library/Application Support/Microsoft Edge") },
    ];
  }
  if (IS_WINDOWS) {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData/Local");
    return [
      { browser: "chrome", name: "Google Chrome", appName: "Google Chrome", userDataDir: path.join(local, "Google/Chrome/User Data") },
      { browser: "chromium", name: "Chromium", appName: "Chromium", userDataDir: path.join(local, "Chromium/User Data") },
      { browser: "brave", name: "Brave", appName: "Brave Browser", userDataDir: path.join(local, "BraveSoftware/Brave-Browser/User Data") },
      { browser: "edge", name: "Microsoft Edge", appName: "Microsoft Edge", userDataDir: path.join(local, "Microsoft/Edge/User Data") },
    ];
  }
  return [
    { browser: "chrome", name: "Google Chrome", appName: "google-chrome", userDataDir: path.join(home, ".config/google-chrome") },
    { browser: "chromium", name: "Chromium", appName: "chromium", userDataDir: path.join(home, ".config/chromium") },
    { browser: "brave", name: "Brave", appName: "brave-browser", userDataDir: path.join(home, ".config/BraveSoftware/Brave-Browser") },
    { browser: "edge", name: "Microsoft Edge", appName: "microsoft-edge", userDataDir: path.join(home, ".config/microsoft-edge") },
  ];
}

function endpointFromProfile(profile) {
  return profile.endpoint || null;
}

async function activeEndpointFromProfilePaths(userDataDir, profileDir) {
  const profileEndpoint = endpointFromPortFile(path.join(profileDir, "DevToolsActivePort"));
  if (profileEndpoint && await endpointReachable(profileEndpoint)) return { ...profileEndpoint, scope: "profile" };
  const browserEndpoint = endpointFromPortFile(path.join(userDataDir, "DevToolsActivePort"));
  if (browserEndpoint && await endpointReachable(browserEndpoint)) return { ...browserEndpoint, scope: "browser" };
  return null;
}

function endpointFromPortFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const [port, wsPath] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    if (!port || !wsPath) return null;
    return normalizeEndpoint({ httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}${wsPath}` });
  } catch {
    return null;
  }
}

function endpointBrowserUrl(endpoint) {
  const normalized = normalizeEndpoint(endpoint);
  return normalized.wsUrl || normalized.httpUrl || "";
}

async function captureForegroundAppForBackgroundLaunch({ front = false } = {}) {
  if (front) return null;
  const enabled = String(process.env.REALBROWSER_RESTORE_FOCUS ?? "1").toLowerCase();
  if (["0", "false", "no", "off"].includes(enabled)) return null;
  if (process.platform === "darwin") {
    const script = [
      'tell application "System Events"',
      '  set frontApp to first application process whose frontmost is true',
      '  set appName to name of frontApp',
      '  set bundleId to ""',
      '  try',
      '    set bundleId to bundle identifier of frontApp',
      '  end try',
      '  return bundleId & linefeed & appName',
      'end tell',
    ].join("\n");
    const result = await runProcessOutput("osascript", ["-e", script], 1_000).catch(() => null);
    if (!result?.ok) return null;
    const [bundleId = "", name = ""] = String(result.stdout || "").trim().split(/\r?\n/);
    if (!bundleId && !name) return null;
    return { platform: "darwin", bundleId, name };
  }
  if (process.platform === "linux") {
    const result = await runProcessOutput("xdotool", ["getactivewindow"], 1_000).catch(() => null);
    if (!result?.ok) return null;
    const windowId = String(result.stdout || "").trim();
    if (!windowId) return null;
    return { platform: "linux", windowId };
  }
  if (IS_WINDOWS) {
    const result = await runProcessOutput("powershell", ["-NoProfile", "-Command",
      'Add-Type -Name W -Namespace T -MemberDefinition \'[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);\';$h=[T.W]::GetForegroundWindow();$p=0;[T.W]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null;$p',
    ], 3_000).catch(() => null);
    if (!result?.ok) return null;
    const pid = String(result.stdout || "").trim();
    if (!pid) return null;
    return { platform: "win32", pid };
  }
  return null;
}

async function restoreForegroundAppAfterBackgroundLaunch(focusRestore, { delayMs = 0 } = {}) {
  if (!focusRestore) return null;
  if (delayMs > 0) await sleep(delayMs);
  if (focusRestore.platform === "darwin") {
    const bundleId = String(focusRestore.bundleId || "");
    const name = String(focusRestore.name || "");
    if (!bundleId && !name) return null;
    const script = [
      bundleId ? `try\n  tell application id ${appleScriptString(bundleId)} to activate\n  return "bundle"\nend try` : "",
      name ? `try\n  tell application ${appleScriptString(name)} to activate\n  return "name"\nend try` : "",
      'return "not-restored"',
    ].filter(Boolean).join("\n");
    return await runProcessOutput("osascript", ["-e", script], 1_500).catch((error) => ({
      ok: false, stdout: "", stderr: error.message || String(error),
    }));
  }
  if (focusRestore.platform === "linux") {
    return await runProcessOutput("xdotool", ["windowactivate", focusRestore.windowId], 1_000).catch((error) => ({
      ok: false, stdout: "", stderr: error.message || String(error),
    }));
  }
  if (focusRestore.platform === "win32") {
    return await runProcessOutput("powershell", ["-NoProfile", "-Command",
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate(${focusRestore.pid})`,
    ], 2_000).catch((error) => ({
      ok: false, stdout: "", stderr: error.message || String(error),
    }));
  }
  return null;
}

function appleScriptString(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function findAnyDevtoolsEndpoint() {
  for (const base of browserBases()) {
    const endpoint = await activeEndpointFromProfilePaths(base.userDataDir, path.join(base.userDataDir, "Default"));
    const browserUrl = endpointBrowserUrl(endpoint);
    if (browserUrl) return browserUrl;
  }
  return null;
}

// Multi-OS browser executable resolver. Honors:
//   - CHROME_PATH env var (ultimate override; checked first if set)
//   - browser hint (chrome|brave|edge|vivaldi|arc|chromium); when set, only
//     candidates matching that browser are returned.
// Path priority is per-platform:
//   - macOS: /Applications/<name>.app/Contents/MacOS/<exe>
//   - Linux: /usr/bin/* then /snap/bin/* then PATH
//   - Windows: %PROGRAMFILES%, %PROGRAMFILES(X86)%, %LOCALAPPDATA% under
//     each vendor's Application directory.
// Shape ported from openclaw's chrome.executables.ts but kept simple:
// fs.existsSync only — no plist/registry/.desktop parsing.
function findBrowserExecutable(browser = "") {
  const hint = String(browser || "").toLowerCase();
  const override = process.env.CHROME_PATH;
  // CHROME_PATH wins when no hint, or when it's plausibly the requested
  // browser (filename contains the hint). When the hint disagrees with the
  // override (CHROME_PATH=/...chrome but --browser=brave), respect the hint
  // and fall through to vendor-specific candidates.
  if (override && fs.existsSync(override)) {
    if (!hint || override.toLowerCase().includes(hint)) return override;
  }
  const candidates = browserExecutableCandidates();
  for (const entry of candidates) {
    if (hint && entry.kind !== hint) continue;
    if (entry.path.includes("/") || entry.path.includes("\\")) {
      if (fs.existsSync(entry.path)) return entry.path;
    } else if (commandExists(entry.path)) {
      return entry.path;
    }
  }
  return null;
}

// Candidate list in priority order. Each entry is `{ kind, path }` where
// `kind` is one of: chrome, chromium, brave, edge, vivaldi, arc.
function browserExecutableCandidates() {
  const out = [];
  if (process.platform === "darwin") {
    out.push(
      { kind: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { kind: "chrome", path: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" },
      { kind: "chrome", path: "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev" },
      { kind: "chrome", path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" },
      { kind: "brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
      { kind: "brave", path: "/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta" },
      { kind: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { kind: "edge", path: "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta" },
      { kind: "vivaldi", path: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" },
      { kind: "arc", path: "/Applications/Arc.app/Contents/MacOS/Arc" },
      { kind: "chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
    );
    return out;
  }
  if (IS_WINDOWS) {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const root of roots) {
      out.push(
        { kind: "chrome", path: path.join(root, "Google/Chrome/Application/chrome.exe") },
        { kind: "chrome", path: path.join(root, "Google/Chrome Beta/Application/chrome.exe") },
        { kind: "chrome", path: path.join(root, "Google/Chrome Dev/Application/chrome.exe") },
        { kind: "chrome", path: path.join(root, "Google/Chrome SxS/Application/chrome.exe") },
        { kind: "brave", path: path.join(root, "BraveSoftware/Brave-Browser/Application/brave.exe") },
        { kind: "brave", path: path.join(root, "BraveSoftware/Brave-Browser-Beta/Application/brave.exe") },
        { kind: "brave", path: path.join(root, "BraveSoftware/Brave-Browser-Nightly/Application/brave.exe") },
        { kind: "edge", path: path.join(root, "Microsoft/Edge/Application/msedge.exe") },
        { kind: "edge", path: path.join(root, "Microsoft/Edge Beta/Application/msedge.exe") },
        { kind: "edge", path: path.join(root, "Microsoft/Edge Dev/Application/msedge.exe") },
        { kind: "edge", path: path.join(root, "Microsoft/Edge SxS/Application/msedge.exe") },
        { kind: "vivaldi", path: path.join(root, "Vivaldi/Application/vivaldi.exe") },
        { kind: "chromium", path: path.join(root, "Chromium/Application/chrome.exe") },
      );
    }
    return out;
  }
  // Linux: prefer absolute paths in /usr/bin then /snap/bin then Flatpak so the
  // resolver gives a stable answer even when PATH is sparse (e.g. systemd units).
  out.push(
    { kind: "chrome", path: "/usr/bin/google-chrome" },
    { kind: "chrome", path: "/usr/bin/google-chrome-stable" },
    { kind: "chrome", path: "/usr/bin/google-chrome-beta" },
    { kind: "chrome", path: "/usr/bin/google-chrome-unstable" },
    { kind: "chrome", path: "/opt/google/chrome/google-chrome" },
    { kind: "chrome", path: "/opt/google/chrome/chrome" },
    { kind: "chromium", path: "/usr/bin/chromium" },
    { kind: "chromium", path: "/usr/bin/chromium-browser" },
    { kind: "chromium", path: "/snap/bin/chromium" },
    { kind: "brave", path: "/usr/bin/brave-browser" },
    { kind: "brave", path: "/usr/bin/brave-browser-stable" },
    { kind: "brave", path: "/usr/bin/brave-browser-beta" },
    { kind: "brave", path: "/usr/bin/brave-browser-nightly" },
    { kind: "brave", path: "/opt/brave.com/brave/brave-browser" },
    { kind: "edge", path: "/usr/bin/microsoft-edge" },
    { kind: "edge", path: "/usr/bin/microsoft-edge-stable" },
    { kind: "edge", path: "/usr/bin/microsoft-edge-beta" },
    { kind: "edge", path: "/usr/bin/microsoft-edge-dev" },
    { kind: "vivaldi", path: "/usr/bin/vivaldi" },
    { kind: "vivaldi", path: "/usr/bin/vivaldi-stable" },
  );
  // Flatpak (system + per-user). Run via the wrapper script.
  const flatpakExports = [
    "/var/lib/flatpak/exports/bin",
    path.join(process.env.HOME || "", ".local/share/flatpak/exports/bin"),
  ];
  for (const dir of flatpakExports) {
    out.push(
      { kind: "chrome", path: path.join(dir, "com.google.Chrome") },
      { kind: "chromium", path: path.join(dir, "org.chromium.Chromium") },
      { kind: "brave", path: path.join(dir, "com.brave.Browser") },
      { kind: "edge", path: path.join(dir, "com.microsoft.Edge") },
    );
  }
  // PATH fallback in case the binaries live somewhere unusual.
  out.push(
    { kind: "chrome", path: "google-chrome" },
    { kind: "chrome", path: "google-chrome-stable" },
    { kind: "chromium", path: "chromium" },
    { kind: "chromium", path: "chromium-browser" },
    { kind: "brave", path: "brave-browser" },
    { kind: "edge", path: "microsoft-edge" },
    { kind: "edge", path: "microsoft-edge-stable" },
    { kind: "vivaldi", path: "vivaldi" },
  );
  return out;
}

function commandExists(cmd) {
  const dirs = String(process.env.PATH || "").split(path.delimiter);
  return dirs.some((dir) => fs.existsSync(path.join(dir, cmd)));
}

function pageObserveFunction(maxChars = 1800) {
  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const sample = clean(document.body?.innerText || "").slice(0, maxChars);
  const headings = [...document.querySelectorAll("h1,h2,h3,h4")].slice(0, 12).map((el) => clean(el.innerText || el.textContent));
  const controls = [...document.querySelectorAll("button,[role=button],a[href],input,textarea,select,[contenteditable=true]")].slice(0, 25).map((el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || undefined,
    text: clean(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder")).slice(0, 120),
    type: el.type || undefined,
    href: el.href || undefined,
    visible: isVisibleInPage(el),
  }));
  const size = pageSizeFunction();
  return { url: location.href, title: document.title, readyState: document.readyState, visibility: document.visibilityState, hasFocus: document.hasFocus(), headings, controls, sample, size };
}

function pageSizeFunction() {
  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const html = document.documentElement?.outerHTML || "";
  const text = clean(document.body?.innerText || "");
  const all = [...document.querySelectorAll("*")];
  const collections = ["[role=feed]", "[role=list]", "[role=grid]", "main", "[role=main]", "table"].map((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    return { selector, children: el.children.length, textChars: clean(el.innerText || el.textContent).length };
  }).filter(Boolean).sort((a, b) => b.textChars - a.textChars).slice(0, 6);
  const doc = {
    htmlChars: html.length,
    bodyTextChars: text.length,
    nodeCount: all.length,
    interactiveCount: document.querySelectorAll("a,button,input,select,textarea,[role=button],[onclick],[tabindex]").length,
    linkCount: document.links.length,
    imageCount: document.images.length,
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: innerHeight,
  };
  const level = doc.htmlChars >= 250000 || doc.bodyTextChars >= 100000 || doc.nodeCount >= 10000 ? "huge"
    : doc.htmlChars >= 100000 || doc.bodyTextChars >= 40000 ? "large"
    : doc.htmlChars >= 25000 || doc.bodyTextChars >= 10000 ? "medium"
    : "small";
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    document: doc,
    collections,
    recommendation: {
      level,
      reader: level === "small" ? "read observe/read snapshot" : level === "medium" ? "read query/read items" : "read item/read items",
      reason: collections.length ? "collection root detected" : "size thresholds",
    },
  };
}

function isVisibleInPage(el) {
  const r = el?.getBoundingClientRect?.();
  const s = el ? getComputedStyle(el) : null;
  return Boolean(r && r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden");
}

function viewportInfo(el) {
  const r = el?.getBoundingClientRect?.();
  if (!r) {
    return {
      inViewport: false,
      centerInViewport: false,
      viewportArea: 0,
      viewportRatio: 0,
      center: { x: 0, y: 0 },
      topmost: false,
      hit: null,
    };
  }
  const left = Math.max(0, r.left);
  const right = Math.min(innerWidth, r.right);
  const top = Math.max(0, r.top);
  const bottom = Math.min(innerHeight, r.bottom);
  const viewportArea = Math.max(0, right - left) * Math.max(0, bottom - top);
  const elementArea = Math.max(1, r.width * r.height);
  const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const centerInViewport = center.x >= 0 && center.x <= innerWidth && center.y >= 0 && center.y <= innerHeight;
  const hit = centerInViewport ? document.elementFromPoint(center.x, center.y) : null;
  let topmost = Boolean(hit && (hit === el || el.contains(hit)));
  if (!topmost && hit && hit.contains && hit.contains(el)) {
    const floatingRoles = ["tooltip", "listbox", "menu", "menubar", "dialog", "alertdialog", "combobox", "tree"];
    let ancestor = hit;
    while (ancestor && ancestor !== document.body) {
      const role = ancestor.getAttribute && ancestor.getAttribute("role");
      const popover = ancestor.getAttribute && ancestor.getAttribute("popover");
      const style = ancestor.nodeType === 1 ? getComputedStyle(ancestor) : null;
      const isFloating = (role && floatingRoles.includes(role)) || popover != null ||
        (style && (style.position === "fixed" || style.position === "absolute") && parseInt(style.zIndex, 10) > 0);
      if (isFloating) { topmost = true; break; }
      ancestor = ancestor.parentElement;
    }
  }
  return {
    inViewport: viewportArea > 0,
    centerInViewport,
    viewportArea,
    viewportRatio: viewportArea / elementArea,
    center,
    topmost,
    hit,
  };
}

function refKind(el) {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") || "";
  if (tag === "a" && el.href) return "l";
  if (tag === "input" && el.type === "file") return "f";
  if (tag === "button" || role === "button" || ["submit", "button"].includes(el.type)) return "b";
  return "e";
}

function pierceQuerySelector(root, selector) {
  if (!root || !selector) return null;
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node || !node.querySelector) continue;
    const found = node.querySelector(selector);
    if (found) return found;
    const hosts = node.querySelectorAll ? node.querySelectorAll("*") : [];
    for (const el of hosts) { if (el.shadowRoot) queue.push(el.shadowRoot); }
  }
  return null;
}

function pierceQuerySelectorAll(root, selector) {
  const out = [];
  if (!root || !selector) return out;
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node || !node.querySelectorAll) continue;
    for (const el of node.querySelectorAll(selector)) out.push(el);
    for (const el of node.querySelectorAll("*")) { if (el.shadowRoot) queue.push(el.shadowRoot); }
  }
  return out;
}

function markRef(el, counters, refs) {
  const kind = refKind(el);
  counters[kind] = (counters[kind] || 0) + 1;
  const ref = `${kind}${counters[kind]}`;
  el.setAttribute("data-realbrowser-ref", ref);
  refs[ref] = {
    ref,
    selector: `[data-realbrowser-ref="${ref}"]`,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || undefined,
    type: el.type || undefined,
    href: el.href || undefined,
    src: el.currentSrc || el.src || undefined,
    name: (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 160),
  };
  return ref;
}

function queryFunction(selector, opts = {}) {
  document.querySelectorAll("[data-realbrowser-ref]").forEach((el) => el.removeAttribute("data-realbrowser-ref"));
  let root;
  try {
    root = opts.root === "active" ? activeRootElementSourceEval() : opts.rootSelector ? document.querySelector(opts.rootSelector) : document;
  } catch (error) {
    throw new Error(`invalid CSS selector for read query --root: ${opts.rootSelector}. Use a CSS selector or an active-root ref such as r1.`);
  }
  if (!root) throw new Error("root not found");
  const refs = {};
  const counters = {};
  const max = opts.limit || 30;
  const matches = [];
  let selected;
  try {
    selected = [...root.querySelectorAll(selector)];
  } catch (error) {
    throw new Error(`invalid CSS selector for read query: ${selector}. read query expects CSS, not literal text. For text checks use wait text, read text --out plus rg, or read query '<css>' --text-filter '<text>'.`);
  }
  for (const el of selected) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const top = document.elementFromPoint(center.x, center.y);
    let isTopmost = top === el || el.contains(top);
    if (!isTopmost && top && top.contains && top.contains(el)) {
      const floatingRoles = ["tooltip", "listbox", "menu", "menubar", "dialog", "alertdialog", "combobox", "tree"];
      let anc = top;
      while (anc && anc !== document.body) {
        const aRole = anc.getAttribute && anc.getAttribute("role");
        const aPop = anc.getAttribute && anc.getAttribute("popover");
        const aStyle = anc.nodeType === 1 ? getComputedStyle(anc) : null;
        if ((aRole && floatingRoles.includes(aRole)) || aPop != null ||
          (aStyle && (aStyle.position === "fixed" || aStyle.position === "absolute") && parseInt(aStyle.zIndex, 10) > 0)) {
          isTopmost = true; break;
        }
        anc = anc.parentElement;
      }
    }
    const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    const entry = {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || undefined,
      text: text.slice(0, opts.maxTextChars || 300),
      href: el.href || undefined,
      src: el.currentSrc || el.src || undefined,
      visible: isVisibleInPage(el),
      enabled: !(el.disabled || el.getAttribute("aria-disabled") === "true"),
      pointerEnabled: style.pointerEvents !== "none",
      topmost: isTopmost,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      htmlPreview: opts.maxHtmlChars ? el.outerHTML.slice(0, opts.maxHtmlChars) : undefined,
    };
    if (opts.visible && !entry.visible) continue;
    if (opts.enabled && !entry.enabled) continue;
    if (opts.topmost && !entry.topmost) continue;
    if (opts.hrefFilter && !String(entry.href || "").includes(opts.hrefFilter)) continue;
    if (opts.textFilter && !entry.text.toLowerCase().includes(String(opts.textFilter).toLowerCase())) continue;
    const ref = markRef(el, counters, refs);
    matches.push({
      index: matches.length + 1,
      ref,
      ...entry,
    });
    if (matches.length >= max) break;
  }
  return { selector, count: matches.length, matches, refs, url: location.href, title: document.title };
}

function snapshotFunction(opts = {}) {
  document.querySelectorAll("[data-realbrowser-ref]").forEach((el) => el.removeAttribute("data-realbrowser-ref"));
  const root = opts.selector ? document.querySelector(opts.selector) : opts.root === "active" ? activeRootElementSourceEval() : document.body || document.documentElement;
  if (!root) throw new Error("snapshot root not found");
  const refs = {};
  const counters = {};
  const lines = [];
  const links = [];
  const seen = new Set();
  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const maxNodes = Number(opts.maxNodes || opts.limit || 350);
  const maxDepth = Number(opts.depth || 8);
  const maxText = Number(opts.maxTextChars || 180);
  const interactiveSelector = "a[href],button,[role=button],input,textarea,select,[contenteditable=true],[role=textbox],[role=link],[role=menuitem],[role=tab],[onclick],[tabindex]";
  const roleSelector = "[role],h1,h2,h3,h4,h5,h6,p,li,article,section,main,form,label";

  const isInteractive = (el) => el.matches?.(interactiveSelector);
  const labelFor = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = el.type ? `[${el.type}]` : "";
    const text = clean(el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder")).slice(0, maxText);
    const base = role || tag;
    return `${base}${type}${text ? ` "${text}"` : ""}`;
  };
  const shouldShow = (el) => {
    if (!isVisibleInPage(el)) return false;
    if (opts.interactive) return isInteractive(el);
    if (isInteractive(el)) return true;
    if (el.matches?.(roleSelector)) return Boolean(clean(el.innerText || el.textContent).slice(0, maxText));
    return false;
  };
  const appendElement = (el, depth) => {
    if (seen.has(el) || lines.length >= maxNodes || !shouldShow(el)) return false;
    seen.add(el);
    const ref = isInteractive(el) ? markRef(el, counters, refs) : "";
    const href = el.href ? ` -> ${el.href}` : "";
    if (ref && el.href) links.push({ ref, text: clean(el.innerText || el.textContent || el.getAttribute("aria-label")).slice(0, 120), href: el.href });
    lines.push(`${"  ".repeat(Math.min(depth, 8))}- ${ref ? `${ref} ` : ""}${labelFor(el)}${opts.urls && href ? href : ""}`);
    return true;
  };
  const walk = (el, depth = 0) => {
    if (!el || lines.length >= maxNodes || depth > maxDepth) return;
    const shown = appendElement(el, depth);
    for (const child of [...el.children]) {
      if (lines.length >= maxNodes) break;
      walk(child, shown ? depth + 1 : depth);
    }
  };

  if (opts.interactive) {
    for (const el of [...root.querySelectorAll(interactiveSelector)]) {
      if (lines.length >= maxNodes) break;
      appendElement(el, 0);
    }
  } else {
    walk(root, 0);
  }

  if (opts.cursorInteractive) {
    let added = 0;
    for (const el of [...root.querySelectorAll("*")]) {
      if (lines.length >= maxNodes || added >= 80) break;
      if (seen.has(el) || !isVisibleInPage(el)) continue;
      const style = getComputedStyle(el);
      const hasCursor = style.cursor === "pointer";
      const hasHandler = Boolean(el.onclick || el.getAttribute("onclick") || el.getAttribute("tabindex"));
      if (!hasCursor && !hasHandler) continue;
      counters.c = (counters.c || 0) + 1;
      const ref = `c${counters.c}`;
      el.setAttribute("data-realbrowser-ref", ref);
      refs[ref] = { ref, selector: `[data-realbrowser-ref="${ref}"]`, tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || undefined, name: clean(el.innerText || el.textContent || el.getAttribute("aria-label")).slice(0, 160) };
      lines.push(`- ${ref} cursor-interactive "${refs[ref].name}" ${[hasCursor ? "cursor:pointer" : "", hasHandler ? "handler/tabindex" : ""].filter(Boolean).join(",")}`);
      added += 1;
    }
  }

  if (opts.urls && links.length) {
    lines.push("", "Links:");
    for (const link of links.slice(0, Number(opts.linkLimit || 80))) lines.push(`${link.ref} ${link.text || link.href} -> ${link.href}`);
  }

  const snapshot = lines.join("\n") || "(empty snapshot)";
  return {
    snapshot,
    refs,
    links,
    stats: {
      lines: lines.length,
      chars: snapshot.length,
      refs: Object.keys(refs).length,
      rootSelector: opts.selector || "",
      truncated: lines.length >= maxNodes,
    },
    url: location.href,
    title: document.title,
  };
}

function activeRootElementSourceEval() {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };
  const active = document.activeElement;
  const roots = [
    ...document.querySelectorAll('[aria-modal="true"],dialog[open],[role="dialog"]'),
    active?.closest?.('form,[role="form"],[contenteditable="true"],[role="textbox"],main,[role="main"]'),
    ...document.querySelectorAll('form,[role="form"],main,[role="main"]'),
  ].filter(Boolean).filter(visible);
  roots.sort((a, b) => {
    const score = (el) => {
      const info = viewportInfo(el);
      const zIndex = Number.parseInt(getComputedStyle(el).zIndex, 10);
      return (el.matches('[aria-modal="true"],dialog,[role="dialog"]') ? 1000 : 0) +
        (el.contains(active) ? 500 : 0) +
        (info.inViewport ? 250 : -500) +
        Math.min(200, info.viewportArea / 4000) +
        (Number.isFinite(zIndex) ? Math.min(100, Math.max(-100, zIndex / 1000)) : 0) +
        (el.querySelector('input[type=file],textarea,input,[contenteditable="true"],[role="textbox"]') ? 100 : 0) +
        (el.querySelector('button,[role=button],input[type=submit]') ? 50 : 0);
    };
    return score(b) - score(a);
  });
  return roots[0] || document.body || document.documentElement;
}

function itemsFunction(opts = {}) {
  const root = resolveCollectionRoot(opts);
  const children = collectionChildren(root, opts);
  const refs = {};
  const counters = { i: 0 };
  const items = children.slice(0, opts.limit || 10).map((el, index) => {
    counters.i += 1;
    const ref = `i${counters.i}`;
    el.setAttribute("data-realbrowser-ref", ref);
    refs[ref] = { ref, selector: `[data-realbrowser-ref="${ref}"]`, tag: el.tagName.toLowerCase() };
    return itemPayload(el, index + 1, ref, opts.maxTextChars || 700);
  });
  return { root: rootInfo(root), count: items.length, visibleItems: children.length, items, refs, url: location.href, title: document.title };
}

function itemFunction(opts = {}) {
  const root = resolveCollectionRoot(opts);
  const children = collectionChildren(root, opts);
  const index = Number(opts.index || 1);
  const el = children[index - 1];
  if (!el) return { root: rootInfo(root), index, found: false, visibleItems: children.length, url: location.href, title: document.title };
  let expandResult;
  if (opts.expand || opts.expandSelector) {
    const expandSelector = opts.expandSelector || opts.expand || "";
    if (expandSelector) {
      const more = el.querySelector(expandSelector);
      if (more && isVisibleInPage(more)) {
        more.click();
        expandResult = { selector: expandSelector, clicked: true };
      } else {
        expandResult = { selector: expandSelector, clicked: false, reason: "not found or hidden" };
      }
    } else {
      expandResult = { clicked: false, reason: "expansion requires --expand-selector <css> or --expand <css>" };
    }
  }
  const ref = `i${index}`;
  el.setAttribute("data-realbrowser-ref", ref);
  const refs = { [ref]: { ref, selector: `[data-realbrowser-ref="${ref}"]`, tag: el.tagName.toLowerCase() } };
  return { ...itemPayload(el, index, ref, opts.maxTextChars || 4000), root: rootInfo(root), visibleItems: children.length, found: true, refs, expand: expandResult, url: location.href, title: document.title };
}

function resolveCollectionRoot(opts = {}) {
  const selectors = opts.root ? [opts.root] : ["[role=feed]", "[role=list]", "[role=grid]", "main", "[role=main]", "table", "body"];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return document.body || document.documentElement;
}

function collectionChildren(root, opts = {}) {
  let children = [...root.children].filter(isVisibleInPage);
  if (!opts.directChildren && children.length < Number(opts.index || opts.limit || 5)) {
    const nested = [...root.querySelectorAll(opts.itemSelector || "article,[role=article],[role=listitem],li,tr,.card")].filter(isVisibleInPage);
    if (nested.length > children.length) children = nested;
  }
  return children;
}

function rootInfo(root) {
  return { tag: root.tagName.toLowerCase(), role: root.getAttribute("role") || undefined, id: root.id || undefined, children: root.children.length };
}

function itemPayload(el, index, ref, maxTextChars) {
  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const text = clean(el.innerText || el.textContent || "");
  return {
    index,
    itemRef: ref,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || undefined,
    text: text.slice(0, maxTextChars),
    textChars: text.length,
    truncated: text.length > maxTextChars,
    links: [...el.querySelectorAll("a[href]")].slice(0, 10).map((a) => ({ text: clean(a.innerText || a.textContent).slice(0, 120), href: a.href })),
    media: [...el.querySelectorAll("img,video")].slice(0, 10).map((m) => ({ tag: m.tagName.toLowerCase(), src: m.currentSrc || m.src || undefined, alt: m.getAttribute("alt") || undefined, width: m.naturalWidth || m.videoWidth || m.clientWidth || undefined, height: m.naturalHeight || m.videoHeight || m.clientHeight || undefined })),
  };
}

function textFunction(selector, maxChars = 6000) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) throw new Error("selector not found: " + selector);
  const clone = root.cloneNode(true);
  clone.querySelectorAll?.("script,style,noscript,svg").forEach((el) => el.remove());
  const text = String(clone.innerText || clone.textContent || "").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
  return { text: text.slice(0, maxChars), chars: text.length, truncated: text.length > maxChars };
}

function htmlFunction(selector, maxChars = 12000) {
  const root = selector ? document.querySelector(selector) : document.documentElement;
  if (!root) throw new Error("selector not found: " + selector);
  const html = root.outerHTML;
  return { html: html.slice(0, maxChars), chars: html.length, truncated: html.length > maxChars };
}

function linksFunction(limit = 50) {
  return [...document.querySelectorAll("a[href]")].slice(0, limit).map((a, index) => ({ index: index + 1, text: (a.innerText || a.textContent || "").trim().slice(0, 160), href: a.href }));
}

function formsFunction() {
  return [...document.querySelectorAll("form")].map((form, index) => ({
    index,
    id: form.id || undefined,
    action: form.action || undefined,
    method: form.method || "get",
    fields: [...form.querySelectorAll("input,select,textarea")].map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || undefined,
      name: el.name || undefined,
      id: el.id || undefined,
      placeholder: el.placeholder || undefined,
      required: Boolean(el.required) || undefined,
      value: el.type === "password" ? "[redacted]" : (el.value || undefined),
    })),
  }));
}

function urlFunction() {
  return { url: location.href, title: document.title, readyState: document.readyState };
}

function isFunction(state, selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: "not-found", selector };
  const visible = isVisibleInPage(el);
  const enabled = !(el.disabled || el.getAttribute("aria-disabled") === "true");
  const editable = el.matches("input,textarea,[contenteditable=true],[role=textbox]");
  const value = {
    visible,
    hidden: !visible,
    enabled,
    disabled: !enabled,
    checked: Boolean(el.checked),
    editable,
    focused: document.activeElement === el,
  }[state];
  return { ok: Boolean(value), state, selector };
}

function readOverlayFunction(opts = {}) {
  const all = document.querySelectorAll("*");
  const layers = [];
  // ARIA roles that signal "this element IS an overlay/popup" regardless of CSS
  // position. Many sites style autocomplete tooltips as position:relative
  // inside an absolute parent — they look like dropdowns visually but were
  // filtered out of pure-CSS-position scans. We accept these by role.
  const ROLE_LAYER_CONTAINERS = new Set([
    "tooltip", "listbox", "combobox", "menu", "menubar", "dialog", "alertdialog",
    "tree", "grid", "treegrid",
  ]);
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const role = el.getAttribute("role") || "";
    const isPositioned = cs.position === "fixed" || cs.position === "absolute";
    const isRoleLayer = ROLE_LAYER_CONTAINERS.has(role);
    if (!isPositioned && !isRoleLayer) continue;
    const z = cs.zIndex === "auto" ? 0 : (parseInt(cs.zIndex, 10) || 0);
    // Role-based layers bypass z-index requirement: a tooltip with role and
    // visible content is an overlay we want to surface even if the author
    // didn't bother setting z-index.
    if (!isRoleLayer) {
      if (cs.zIndex === "auto" && z === 0 && cs.position === "absolute") {
        let p = el.parentElement;
        let inheritedZ = 0;
        while (p && inheritedZ === 0) {
          const ps = getComputedStyle(p);
          const pz = ps.zIndex === "auto" ? 0 : (parseInt(ps.zIndex, 10) || 0);
          if (pz > 0) { inheritedZ = pz; break; }
          p = p.parentElement;
        }
        if (inheritedZ === 0) continue;
      } else if (z < 1) {
        continue;
      }
    }
    layers.push({ el, rect: r, zIndex: z, role, isRoleLayer });
  }
  if (!layers.length) return { ok: false, reason: "no floating layer found (no fixed/absolute element with z-index >= 1)" };
  const LIST_ITEM_SELECTOR = 'li,[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="row"],[role="listitem"],[role="treeitem"],[role="combobox"] [role="option"]';
  const listLikeCount = (el) => {
    let n = el.querySelectorAll(LIST_ITEM_SELECTOR).length;
    if (n >= 3) return n;
    const directChildLeaves = [...el.children].filter((c) => {
      const t = (c.innerText || c.textContent || "").trim();
      return t.length > 0 && t.length < 200 && c.children.length <= 4;
    });
    return Math.max(n, directChildLeaves.length);
  };
  for (const layer of layers) {
    layer.listItems = listLikeCount(layer.el);
    layer.isListLike = layer.listItems >= 3;
    layer.area = layer.rect.width * layer.rect.height;
    layer.bigEnough = layer.rect.width >= 150 && layer.rect.height >= 80;
  }
  // Eligibility: a layer counts if any of:
  //   - large enough to be a real overlay (>= 150x80)
  //   - contains 3+ list-like items (real autocomplete/menu/list)
  //   - has an explicit role that says "I'm an overlay" (tooltip, listbox, ...)
  const eligible = layers.filter((l) => l.bigEnough || l.isListLike || l.isRoleLayer);
  if (!eligible.length) {
    const summary = layers.slice(0, 3).map((l) => `${l.el.tagName.toLowerCase()}${l.role ? `[${l.role}]` : ""} z=${l.zIndex} ${Math.round(l.rect.width)}x${Math.round(l.rect.height)} listItems=${l.listItems}`).join("; ");
    return { ok: false, reason: `no eligible layer (all candidates are tiny popovers without list items): ${summary}` };
  }
  let anchor = null;
  let anchorSource = "";
  if (opts.anchorSelector) {
    anchor = document.querySelector(opts.anchorSelector)
      || (typeof pierceQuerySelector === "function" ? pierceQuerySelector(document, opts.anchorSelector) : null);
    anchorSource = anchor ? "near-arg" : "";
  }
  if (!anchor) {
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== document.documentElement
      && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) {
      anchor = ae;
      anchorSource = "active-input";
    }
  }
  let chosen;
  if (anchor) {
    const ar = anchor.getBoundingClientRect();
    const ax = ar.left + ar.width / 2;
    const ay = ar.bottom;
    // Tightened proximity: drop the +150 horizontal slack to +50, keep
    // generous vertical bound (autocompletes can be tall). Compute a
    // Manhattan distance from the anchor's bottom-center to the layer's
    // top-center as the primary tie-break: real autocomplete dropdowns hug
    // the input from below, while corner popups (Login pill, chat widgets)
    // are far in distance even if they technically overlap horizontally.
    //
    // Role-layers (tooltip/listbox/menu/dialog/combobox/grid/...) render
    // through portals (React's createPortal, Vue Teleport, Svelte target)
    // and frequently appear far from the anchor horizontally — booking
    // forms commonly mount the airport picker in the document body root,
    // not as a sibling of the trigger button. For those, skip the
    // horizontal-overlap gate and rely on Manhattan distance + role to
    // pick the right layer.
    const nearAnchor = eligible.filter(({ rect, isRoleLayer }) => {
      const horizontalOverlap = rect.left < ar.right + 50 && rect.right > ar.left - 50;
      const verticallyBelow = rect.top >= ar.bottom - 50 && rect.top < ar.bottom + 700;
      const verticallyOverlap = rect.top < ar.bottom && rect.bottom > ar.top;
      const verticallyAbove = rect.bottom > ar.top - 700 && rect.bottom <= ar.top + 50;
      const verticallyClose = verticallyBelow || verticallyOverlap || verticallyAbove;
      if (isRoleLayer) {
        // Role-layers (tooltip/listbox/menu/dialog/combobox/grid/...) often
        // render through portals far from their trigger horizontally.
        // Accept any role-layer that is reasonably close vertically; the
        // role+distance tie-break later picks the right one.
        return verticallyClose;
      }
      return horizontalOverlap && verticallyClose;
    });
    for (const layer of nearAnchor) {
      const lx = layer.rect.left + layer.rect.width / 2;
      const ly = layer.rect.top;
      layer.distance = Math.abs(lx - ax) + Math.abs(ly - ay);
    }
    if (nearAnchor.length) {
      nearAnchor.sort((a, b) =>
        (b.isRoleLayer - a.isRoleLayer)
        || (b.isListLike - a.isListLike)
        || (a.distance - b.distance)
        || (b.zIndex - a.zIndex)
        || (b.area - a.area));
      chosen = nearAnchor[0];
    } else {
      const summary = eligible.slice(0, 3).map((l) => `${l.el.tagName.toLowerCase()}${l.role ? `[${l.role}]` : ""} z=${l.zIndex} ${Math.round(l.rect.width)}x${Math.round(l.rect.height)}@${Math.round(l.rect.x)},${Math.round(l.rect.y)} listItems=${l.listItems}`).join("; ");
      return { ok: false, reason: `no eligible layer near anchor (${anchor.tagName.toLowerCase()}${anchor.id ? "#" + anchor.id : ""} at ${Math.round(ar.x)},${Math.round(ar.y)}); the dropdown may have closed or render elsewhere. Eligible layers: ${summary || "(none)"}. Try clicking the field again, or pass --near <ref> to anchor the search.` };
    }
  } else {
    const ranked = [...eligible];
    ranked.sort((a, b) =>
      (b.isRoleLayer - a.isRoleLayer)
      || (b.isListLike - a.isListLike)
      || (b.zIndex - a.zIndex)
      || (b.area - a.area));
    chosen = ranked[0];
  }
  const layer = chosen.el;
  const interactiveTags = new Set(["button", "a", "option"]);
  const interactiveRoles = new Set(["button", "option", "menuitem", "menuitemradio", "menuitemcheckbox", "tab", "link", "radio", "checkbox", "treeitem", "row"]);
  const isInteractive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (interactiveTags.has(tag)) return true;
    if (tag === "input" && el.type !== "hidden") return true;
    if (tag === "li" && el.closest('[role="listbox"],[role="menu"],ul[role],ol[role]')) return true;
    const role = el.getAttribute("role");
    if (role && interactiveRoles.has(role)) return true;
    if (el.hasAttribute("data-value") || el.hasAttribute("data-option-value")) return true;
    if (el.onclick || el.getAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && ti !== "-1") return true;
    const ce = el.getAttribute("contenteditable");
    if (ce === "" || ce === "true") return true;
    return false;
  };
  // Pointer-region: a non-interactive element that *looks* clickable
  // (cursor:pointer) where the parent's cursor differs. Captures
  // React-delegated handlers on Ant/MUI/custom <div> rows that have no
  // role / aria-* / tabindex / native onclick. Mirrors the openclaw
  // cursor predicate (cdp.ts:622-674) with a parent-collapse rule so
  // nested chains (every level inherits cursor:pointer) collapse to the
  // highest pointer-cursor element — that's the one with the React
  // handler. Layer-boundary stops the walk so the layer's first-level
  // pointer-cursor child still qualifies even if the layer wrapper itself
  // is cursor:pointer.
  const isPointerRegion = (el) => {
    const cs = getComputedStyle(el);
    if (cs.cursor !== "pointer") return false;
    const parent = el.parentElement;
    if (!parent || parent === layer) return true;
    return getComputedStyle(parent).cursor !== "pointer";
  };
  const candidates = [];
  const seenEls = new Set();
  for (const el of layer.querySelectorAll("*")) {
    if (seenEls.has(el)) continue;
    const cs2 = getComputedStyle(el);
    if (cs2.display === "none" || cs2.visibility === "hidden") continue;
    const r2 = el.getBoundingClientRect();
    if (r2.width < 4 || r2.height < 4) continue;
    const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || el.value || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 240) continue;
    const isLeaf = el.children.length === 0
      || ![...el.children].some((c) => (c.innerText || c.textContent || "").trim().length > 0);
    const interactive = isInteractive(el);
    const pointerRegion = !interactive && isPointerRegion(el);
    if (interactive || pointerRegion || (isLeaf && cs2.pointerEvents !== "none")) {
      seenEls.add(el);
      candidates.push({ el, text: text.slice(0, 120), rect: r2, interactive, pointerRegion });
    }
  }
  candidates.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const dedup = [];
  const seenKey = new Set();
  for (const item of candidates) {
    // Drop a descendant when an ancestor is already kept and any of:
    //   (a) ancestor's text matches (legacy aggregator behaviour),
    //   (b) ancestor is interactive (button / role=button / tabindex /
    //       contenteditable / [data-value] / [onclick] / native input),
    //   (c) ancestor is a pointer-region (cursor:pointer with non-pointer
    //       parent) — covers React-delegated handlers with no other signal.
    // Together (b)+(c) guarantee the ref points at the element that owns
    // the click handler — not a styling fragment whose own click would
    // land on the wrong React event.target. Listbox / menu / tree
    // containers are deliberately NOT in interactiveRoles, so options /
    // menuitems inside them are still emitted as siblings rather than
    // swallowed by the parent.
    const ancestorAlready = dedup.some((kept) => kept.el.contains(item.el) && (kept.text === item.text || kept.interactive || kept.pointerRegion));
    if (ancestorAlready) continue;
    const key = `${item.text}|${Math.round(item.rect.left)}|${Math.round(item.rect.top)}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    dedup.push(item);
  }
  const limit = Number(opts.limit || 30);
  const refs = {};
  const options = dedup.slice(0, limit).map((item, i) => {
    const ref = `o${i + 1}`;
    item.el.setAttribute("data-realbrowser-ref", ref);
    const tag = item.el.tagName.toLowerCase();
    refs[ref] = {
      ref,
      selector: `[data-realbrowser-ref="${ref}"]`,
      tag,
      text: item.text,
      role: item.el.getAttribute("role") || undefined,
      interactive: item.interactive,
      pointerRegion: item.pointerRegion || undefined,
    };
    return refs[ref];
  });
  const layerRect = chosen.rect;
  const anchorDesc = anchor ? {
    tag: anchor.tagName.toLowerCase(),
    role: anchor.getAttribute("role") || undefined,
    name: (anchor.getAttribute("aria-label") || anchor.placeholder || anchor.name || (anchor.innerText || "").trim().slice(0, 80) || "").slice(0, 80) || undefined,
    value: typeof anchor.value === "string" ? anchor.value.slice(0, 80) : undefined,
    source: anchorSource,
  } : null;
  return {
    ok: true,
    layer: {
      tag: layer.tagName.toLowerCase(),
      role: layer.getAttribute("role") || undefined,
      zIndex: chosen.zIndex,
      listItems: chosen.listItems,
      isListLike: chosen.isListLike,
      isRoleLayer: chosen.isRoleLayer,
      distance: typeof chosen.distance === "number" ? Math.round(chosen.distance) : undefined,
      rect: { x: Math.round(layerRect.x), y: Math.round(layerRect.y), width: Math.round(layerRect.width), height: Math.round(layerRect.height) },
    },
    focused: anchorDesc,
    anchor: anchorDesc,
    options,
    refs,
    truncated: dedup.length > limit,
    totalFound: dedup.length,
    skippedLayers: layers.length - eligible.length,
  };
}

// Walk the visible DOM and surface elements that LOOK clickable but have
// no ARIA role / accessible name — so they're invisible to
// Accessibility.getFullAXTree. Modern React/Vue UIs render menus, recent-
// action chips, calendar day cells, custom selects, tile pickers, etc. as
// `<div cursor:pointer onclick>` with no role. After the AX tree is
// stamped, we scan for these and mint `c1, c2, ...` refs so the tree
// line view shows them and `action click <c-ref>` works through the
// standard CDP path.
//
// Predicates (any one suffices):
//   - cursor:pointer AND parent's cursor isn't also pointer (parent-collapse,
//     mirrors openclaw cdp.ts:649-652).
//   - tabindex >= 0 (keyboard-reachable custom widget).
//   - el.onclick set or [onclick] attr.
//   - contenteditable set.
//   - aria-haspopup set (custom dropdown trigger w/o role=button).
//
// Excluded:
//   - elements with data-realbrowser-ref already set (in AX tree).
//   - elements containing a stamped descendant (the descendant is the
//     real action target).
//   - elements with a stamped/accepted ancestor (parent-collapse for
//     nested cursor:pointer chains).
//   - rect smaller than 8x8 px (decorations).
//   - empty innerText (no semantic value).
//   - <html>, <body>, <svg>, <path>, <input>, <textarea>, <select>,
//     <button>, <a> (these are AX-tree natives or already covered by
//     the regular tree).
function cursorClickablesFunction(opts = {}) {
  const max = Number(opts.max || 100);
  const startIdx = Number(opts.startIndex || 0);
  const SKIP_TAGS = new Set(["html", "body", "svg", "path", "input", "textarea", "select", "button", "a", "script", "style", "noscript", "head", "meta", "link", "br", "hr", "img"]);
  const refs = {};
  const lines = [];
  const accepted = [];
  const docOrder = [];
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) docOrder.push(all[i]);
  const isVisibleSimple = (el) => {
    const r = el.getBoundingClientRect?.();
    const s = el ? getComputedStyle(el) : null;
    return Boolean(r && r.width >= 8 && r.height >= 8 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0");
  };
  const trim = (s) => String(s || "").replace(/\s+/g, " ").trim();
  for (const el of docOrder) {
    if (lines.length >= max) break;
    if (!el || el.nodeType !== 1) continue;
    const tag = el.tagName?.toLowerCase?.() || "";
    if (!tag || SKIP_TAGS.has(tag)) continue;
    if (el.hasAttribute("data-realbrowser-ref")) continue;
    if (el.querySelector && el.querySelector("[data-realbrowser-ref]")) continue;
    if (!isVisibleSimple(el)) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch { continue; }
    if (cs.pointerEvents === "none") continue;
    const role = el.getAttribute("role");
    // Skip elements that already have an interactive role (those would
    // appear in the AX tree under the role-based interactive set).
    if (role && /^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|option|checkbox|radio|switch|treeitem|combobox|searchbox|textbox|slider|spinbutton)$/.test(role)) continue;
    const cursorPointer = cs.cursor === "pointer";
    const tabindex = el.getAttribute("tabindex");
    const hasTabindex = tabindex !== null && tabindex !== "" && Number(tabindex) >= 0;
    const hasOnclickProp = typeof el.onclick === "function";
    const hasOnclickAttr = el.hasAttribute("onclick");
    const ce = el.getAttribute("contenteditable");
    const hasCe = ce === "" || ce === "true" || ce === "plaintext-only";
    const hasHasPopup = el.hasAttribute("aria-haspopup");
    if (!cursorPointer && !hasTabindex && !hasOnclickProp && !hasOnclickAttr && !hasCe && !hasHasPopup) continue;
    // Parent-cursor collapse for cursor:pointer chains. A cursor:pointer
    // child of a cursor:pointer parent is usually a styling fragment —
    // the parent owns the React handler. Exception: if the parent
    // doesn't qualify by ANY of our other predicates, this leaf's other
    // signals (tabindex/onclick/etc.) win.
    if (cursorPointer && !hasTabindex && !hasOnclickProp && !hasOnclickAttr && !hasCe && !hasHasPopup) {
      const parent = el.parentElement;
      if (parent) {
        try {
          const ps = getComputedStyle(parent);
          if (ps.cursor === "pointer") continue;
        } catch { /* ignore */ }
      }
    }
    // Skip if any already-accepted ancestor is in our list — collapses
    // nested chains we just emitted.
    let ancestorAccepted = false;
    for (const acc of accepted) {
      if (acc.contains(el)) { ancestorAccepted = true; break; }
    }
    if (ancestorAccepted) continue;
    const text = trim(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("placeholder") || "");
    if (!text) continue;
    if (text.length > 4000) continue; // skip giant containers
    const idx = startIdx + lines.length + 1;
    const ref = `c${idx}`;
    el.setAttribute("data-realbrowser-ref", ref);
    accepted.push(el);
    const truncated = text.slice(0, 120);
    const flags = [];
    if (cursorPointer) flags.push("cursor:pointer");
    if (hasTabindex) flags.push(`tabindex=${tabindex}`);
    if (hasOnclickProp || hasOnclickAttr) flags.push("onclick");
    if (hasCe) flags.push("contenteditable");
    if (hasHasPopup) flags.push("haspopup");
    const flagStr = flags.length ? ` [${flags.join(",")}]` : "";
    refs[ref] = {
      ref,
      selector: `[data-realbrowser-ref="${ref}"]`,
      tag,
      role: role || undefined,
      name: truncated,
    };
    lines.push(`- ${ref} ${tag} "${truncated}"${flagStr}`);
  }
  return { lines, refs, count: lines.length, scanned: docOrder.length };
}

function actionStateFunction(opts = {}) {
  document.querySelectorAll("[data-realbrowser-ref],[data-realbrowser-root]").forEach((el) => {
    el.removeAttribute("data-realbrowser-ref");
    el.removeAttribute("data-realbrowser-root");
  });
  const root = opts.root === "page" ? (document.body || document.documentElement) : opts.rootSelector ? (document.querySelector(opts.rootSelector) || activeRootElementSourceEval()) : activeRootElementSourceEval();
  root.setAttribute("data-realbrowser-root", "r1");
  const refs = { r1: { ref: "r1", selector: '[data-realbrowser-root="r1"]', tag: root.tagName.toLowerCase() } };
  const counters = {};
  const rootRect = root.getBoundingClientRect();
  const controlEntries = [...root.querySelectorAll("button,[role=button],a[href],input,textarea,select,[contenteditable=true],[role=textbox]")].filter(isVisibleInPage).map((el, order) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const viewport = viewportInfo(el);
    const enabled = !(el.disabled || el.getAttribute("aria-disabled") === "true");
    return {
      el,
      order,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || undefined,
      type: el.type || undefined,
      text: (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 160),
      enabled,
      pointerEnabled: style.pointerEvents !== "none",
      inViewport: viewport.inViewport,
      topmost: viewport.topmost,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  }).sort((a, b) => {
    const score = (entry) => (entry.inViewport ? 1000 : 0) +
      (entry.topmost ? 500 : 0) +
      (entry.pointerEnabled ? 100 : 0) +
      (entry.enabled ? 50 : 0) -
      Math.abs(Math.max(0, entry.rect.y));
    return score(b) - score(a) || a.order - b.order;
  });
  const controls = controlEntries.slice(0, opts.limit || 30).map(({ el, order, ...entry }) => ({
    ref: markRef(el, counters, refs),
    ...entry,
  }));
  const fileInputs = controls.filter((control) => control.type === "file");
  const buttonLike = (control) => control.tag === "button" ||
    control.role === "button" ||
    (control.tag === "input" && ["submit", "button"].includes(control.type || ""));
  const finalCandidates = controls.filter((control) => buttonLike(control) &&
    control.enabled &&
    control.pointerEnabled &&
    control.inViewport &&
    control.topmost);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    root: {
      ref: "r1",
      tag: root.tagName.toLowerCase(),
      role: root.getAttribute("role") || undefined,
      rect: { x: Math.round(rootRect.x), y: Math.round(rootRect.y), width: Math.round(rootRect.width), height: Math.round(rootRect.height) },
      inViewport: viewportInfo(root).inViewport,
    },
    controls,
    fileInputs,
    finalCandidates,
    refs,
  };
}

function actionPreflightFunction() {
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    capabilities: { cdp: true, input: true, upload: true, screenshot: true },
  };
}

function clickFunction(selector, opts = {}) {
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const actionText = (el) => (el.getAttribute("aria-label") || el.value || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const formatCandidates = (entries) => entries.slice(0, 8).map((entry) => {
    const flags = [
      entry.visible ? "" : "hidden",
      entry.enabled ? "" : "disabled",
      entry.pointerEnabled ? "" : "no-pointer",
      entry.inViewport ? "" : "out-viewport",
      entry.topmost ? "" : (entry.coveredBy ? `covered-by:${entry.coveredBy}` : "covered"),
    ].filter(Boolean);
    return `${entry.ref || entry.tag}${entry.text ? `:${entry.text}` : ""}${flags.length ? ` (${flags.join(",")})` : ""}`;
  }).join("; ");
  let candidates;
  const root = opts.activeRoot || opts.root === "active" ? activeRootElementSourceEval() : document;
  if (selector) {
    const direct = root.querySelector(selector);
    candidates = [direct || pierceQuerySelector(root, selector) || pierceQuerySelector(document, selector)];
  } else if (opts.final) {
    const all = [...root.querySelectorAll("button,[role=button],input[type=submit],input[type=button],a[href]")];
    if (opts.text) {
      const wanted = normalizeText(String(opts.text));
      candidates = all.filter((el) => normalizeText(actionText(el)) === wanted);
      if (!candidates.length) {
        const near = all.filter((el) => normalizeText(actionText(el)).includes(wanted));
        const diagnostics = near.slice(0, 8).map((el) => actionText(el) || el.tagName.toLowerCase()).join("; ");
        throw new Error(`Final action label must match exactly: ${opts.text}${diagnostics ? `; near matches: ${diagnostics}` : ""}`);
      }
    } else {
      throw new Error("Final action requires exact text or a button ref");
    }
  } else {
    candidates = [...root.querySelectorAll("button,[role=button],a,input")].filter((el) => actionText(el).toLowerCase().includes(String(opts.text || "").toLowerCase()));
  }
  const checkedPairs = candidates.filter(Boolean).map((el) => ({ el, entry: preflightElement(el, { scroll: !opts.final }) }));
  const checked = checkedPairs.map((pair) => pair.entry);
  const visiblePairs = checkedPairs.filter((pair) => pair.entry.visible && pair.entry.enabled && pair.entry.pointerEnabled && pair.entry.inViewport && pair.entry.topmost);
  if (opts.final && visiblePairs.length !== 1) throw new Error(`Final action requires exactly one visible enabled topmost candidate; found ${visiblePairs.length}${checked.length ? `; candidates: ${formatCandidates(checked)}` : ""}`);
  let chosen;
  if (visiblePairs.length < 1) {
    const interactablePairs = checkedPairs.filter((pair) => pair.entry.visible && pair.entry.enabled && pair.entry.pointerEnabled && pair.entry.inViewport);
    const bypassPair = opts.bypassOverlay
      ? checkedPairs.find((pair) => pair.entry.visible && pair.entry.enabled && pair.entry.inViewport && pair.entry.rect.width > 0 && pair.entry.rect.height > 0)
      : null;
    if (interactablePairs.length >= 1) {
      chosen = interactablePairs[0];
      chosen.el.click();
      chosen.entry.clickMethod = "synthetic";
      chosen.entry.warning = `topmost check failed (${chosen.entry.coveredBy || "covered"}); used synthetic el.click()`;
    } else if (bypassPair) {
      chosen = bypassPair;
      const r = chosen.el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, buttons: 1 };
      try { chosen.el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse", isPrimary: true })); } catch (_) {}
      chosen.el.dispatchEvent(new MouseEvent("mousedown", init));
      try { chosen.el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse", isPrimary: true })); } catch (_) {}
      chosen.el.dispatchEvent(new MouseEvent("mouseup", init));
      chosen.el.dispatchEvent(new MouseEvent("click", init));
      chosen.entry.clickMethod = "synthetic";
      chosen.entry.warning = `bypass-overlay (${chosen.entry.coveredBy || (chosen.entry.pointerEnabled ? "covered" : "no-pointer")}); dispatched events directly to element`;
    } else {
      const overlayHint = checked.some((entry) => entry.coveredBy || !entry.pointerEnabled) ? "; if covered-by overlay is the only blocker, retry with --bypass-overlay" : "";
      throw new Error(`No visible enabled click candidate${checked.length ? `; candidates: ${formatCandidates(checked)}` : ""}${overlayHint}`);
    }
  } else {
    if (visiblePairs.length > 1 && opts.text) throw new Error(`Ambiguous click candidate; found ${visiblePairs.length}`);
    chosen = visiblePairs[0];
  }
  const fileDialogReason = fileDialogTriggerReason(chosen.el);
  if (fileDialogReason && !opts.allowFileDialog) {
    throw new Error(`Ref ${chosen.entry.ref || chosen.entry.text || chosen.entry.tag} targets a file input path (${fileDialogReason}); use action upload --trigger-ref <ref> <file> or pass --allow-file-dialog`);
  }
  // Default clickMethod when CDP will follow up (caller dispatches mouse events).
  if (!chosen.entry.clickMethod) chosen.entry.clickMethod = "cdp";
  // Floating-layer detection: AntD/Material/Radix popovers, listboxes, menus,
  // tooltips, dialog grids, and date-picker rows often mount in a portal
  // outside the form. CDP Input.dispatchMouseEvent against these elements
  // can register at the document layer (the dispatch returns success and the
  // page sees the click), but React's delegated onClick on a row inside the
  // popover doesn't fire because the floating layer's pointerdown handler
  // already swallowed the event for the outside-click detector. Mark the
  // payload so the caller can opportunistically re-dispatch synthetically
  // if the page state did not change post-click.
  chosen.entry.inFloatingLayer = elementInFloatingLayer(chosen.el);
  // Capture a cheap pre-click signature so the caller can detect "click
  // landed but page didn't change" without round-tripping through the full
  // tree-read pipeline. Hash a short slice of body text + counts of common
  // floating-layer roles + the activeElement tag.
  chosen.entry.preClickSignature = pageStateSignature();
  return chosen.entry;
}

function dragPointFunction(selector, opts = {}) {
  const root = opts.activeRoot || opts.root === "active" ? activeRootElementSourceEval() : document;
  const el = root.querySelector(selector) || pierceQuerySelector(root, selector) || pierceQuerySelector(document, selector);
  if (!el) throw new Error(`${opts.role || "drag point"} selector not found: ${selector}`);
  const entry = preflightElement(el, { scroll: opts.scroll !== false });
  const blockers = [];
  if (!entry.visible) blockers.push("hidden");
  if (!entry.inViewport) blockers.push("out-viewport");
  if (opts.requireEnabled !== false && !entry.enabled) blockers.push("disabled");
  if (opts.requirePointer !== false && !entry.pointerEnabled) blockers.push("no-pointer");
  if (opts.requireTopmost !== false && !entry.topmost) blockers.push(entry.coveredBy ? `covered-by:${entry.coveredBy}` : "covered");
  if (blockers.length) throw new Error(`${opts.role || "drag point"} is not usable (${blockers.join(",")})`);
  return { point: entry.center, entry };
}

// Cheap page-state fingerprint. Used by the click auto-fallback path to
// detect "click registered but page state unchanged" — the symptom that
// portal popovers AND plain SPA route-swap buttons exhibit when CDP
// Input.dispatchMouseEvent fires but React's delegated handler never runs
// (React 18 concurrent rendering can detach the listener between dispatch
// and microtask flush). Signature includes URL, layer count, activeElement,
// body text head+tail, scroll height (panel swaps), and resource-entry
// count (handlers that kick off a fetch flip this before any DOM mutation).
function pageStateSignature() {
  const layers = document.querySelectorAll(
    '[role="dialog"],[role="tooltip"],[role="listbox"],[role="menu"],[role="combobox"],[role="grid"],[aria-modal="true"]'
  ).length;
  const active = document.activeElement;
  const activeTag = active ? `${active.tagName.toLowerCase()}#${active.id || ""}.${(typeof active.className === "string" ? active.className : "").slice(0, 60)}` : "";
  // Sample text from start AND end of body so changes below the fold
  // (a result list updating, an item appended) still flip the hash.
  const bodyTextFull = (document.body && document.body.innerText) || "";
  const bodyText = bodyTextFull.length > 1000
    ? `${bodyTextFull.slice(0, 500)}|||${bodyTextFull.slice(-500)}`
    : bodyTextFull.slice(0, 1000);
  const scrollHeight = (document.documentElement && document.documentElement.scrollHeight) || 0;
  // User-initiated network counter — count only fetch/XHR entries so
  // passive background loads (analytics polls, prefetch <link>, image
  // lazy-loads) don't flip the signal. A submit handler that fires one
  // XHR is the canonical "click happened, page still rendering" case.
  let xhrCount = 0;
  try {
    const entries = performance.getEntriesByType("resource");
    for (let i = 0; i < entries.length; i += 1) {
      const t = entries[i].initiatorType;
      if (t === "fetch" || t === "xmlhttprequest") xhrCount += 1;
    }
  } catch (_) { /* sandboxed iframes */ }
  // 32-bit FNV-1a over a deterministic concatenation of features.
  let h = 0x811c9dc5;
  const seed = `L:${layers}|A:${activeTag}|U:${location.href}|N:${bodyTextFull.length}|S:${scrollHeight}|X:${xhrCount}|B:${bodyText}`;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return { layers, hash: h.toString(16), activeTag, url: location.href, length: bodyTextFull.length, scrollHeight, xhrCount };
}

// Returns true if the element (or any ancestor) is rendered inside a
// floating-layer container — Radix/AntD/Material/HeadlessUI portals,
// tooltips, popovers, listboxes, dialog grids, etc. Auto-fallback only
// fires when both this is true AND the page-state signature did not
// change after the CDP click.
function elementInFloatingLayer(el) {
  if (!el) return false;
  let node = el;
  let depth = 0;
  while (node && node !== document.body && depth < 30) {
    if (node.nodeType !== 1) { node = node.parentNode; depth += 1; continue; }
    const role = node.getAttribute && node.getAttribute("role");
    if (role && /^(dialog|tooltip|listbox|menu|combobox|grid|menuitem|option|row|gridcell)$/.test(role)) return true;
    if (node.getAttribute && node.getAttribute("aria-modal") === "true") return true;
    const cls = (typeof node.className === "string") ? node.className : (node.className && node.className.baseVal) || "";
    if (cls && /(?:^|\s)(?:ant-popover|ant-popover-inner|ant-select-dropdown|ant-picker-dropdown|ant-dropdown|ant-modal|ant-tooltip|MuiPopover|MuiMenu|MuiTooltip|MuiPaper-root|popover|popover-body|dropdown-menu|tippy-box|chakra-popover__popper|radix-popper|combobox-popover)(?:\s|$|-)/i.test(cls)) return true;
    // Fixed/absolute positioned containers with a high z-index are commonly
    // floating layers — check style only after cheaper class/role checks.
    try {
      const style = (node.ownerDocument && node.ownerDocument.defaultView)
        ? node.ownerDocument.defaultView.getComputedStyle(node)
        : getComputedStyle(node);
      const z = Number(style.zIndex);
      if ((style.position === "fixed" || style.position === "absolute") && z >= 1000) return true;
    } catch (_) { /* cross-origin shadow root etc — skip */ }
    node = node.parentNode;
    depth += 1;
  }
  return false;
}

// Probe + synthetic-click fallback. Called after the CDP click path when
// the original payload reported `inFloatingLayer=true` and `clickMethod="cdp"`.
// If the page-state signature is unchanged (the click registered but
// React's delegated handler never fired), dispatches a synthetic event
// sequence (pointerdown → mousedown → pointerup → mouseup → click) on the
// resolved element. AntD's outside-click detector listens on pointerdown,
// so the PointerEvent is essential — a plain MouseEvent is not enough.
function postClickFallbackFunction(selector, preSignature) {
  // Re-resolve the element. After a CDP click some AntD popovers re-render
  // their rows, so the ORIGINAL selector (data-realbrowser-ref) is the
  // most reliable lookup. If the ref was on a re-rendered node, the CSS
  // attribute selector still finds the new node.
  const root = document;
  let el = null;
  try {
    el = root.querySelector(selector);
  } catch (_) { /* malformed selector */ }
  const after = (function captureAfter() {
    const layers = document.querySelectorAll(
      '[role="dialog"],[role="tooltip"],[role="listbox"],[role="menu"],[role="combobox"],[role="grid"],[aria-modal="true"]'
    ).length;
    const active = document.activeElement;
    const activeTag = active ? `${active.tagName.toLowerCase()}#${active.id || ""}.${(typeof active.className === "string" ? active.className : "").slice(0, 60)}` : "";
    const bodyTextFull = (document.body && document.body.innerText) || "";
    const bodyText = bodyTextFull.length > 1000
      ? `${bodyTextFull.slice(0, 500)}|||${bodyTextFull.slice(-500)}`
      : bodyTextFull.slice(0, 1000);
    const scrollHeight = (document.documentElement && document.documentElement.scrollHeight) || 0;
    let xhrCount = 0;
    try {
      const entries = performance.getEntriesByType("resource");
      for (let i = 0; i < entries.length; i += 1) {
        const t = entries[i].initiatorType;
        if (t === "fetch" || t === "xmlhttprequest") xhrCount += 1;
      }
    } catch (_) { /* sandboxed iframes */ }
    let h = 0x811c9dc5;
    const seed = `L:${layers}|A:${activeTag}|U:${location.href}|N:${bodyTextFull.length}|S:${scrollHeight}|X:${xhrCount}|B:${bodyText}`;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return { layers, hash: h.toString(16), activeTag, url: location.href, length: bodyTextFull.length, scrollHeight, xhrCount };
  })();
  // Decide "changed". Any structural diff (url/layers/hash/scrollHeight)
  // is definitive. XHR jump >= 1 is the additional gate: we filter to
  // fetch/XHR only (passive polls excluded by initiatorType) so a
  // single user-initiated request after the click counts as "click did
  // something". This biases toward "changed" — false negatives (we say
  // "unchanged" when click did fire) cost one wasted retry; false
  // positives (we say "changed" when click failed) leave the agent to
  // catch the no-op via verify, but never double-submit.
  const xhrJump = preSignature && typeof preSignature.xhrCount === "number" ? (after.xhrCount - preSignature.xhrCount) : 0;
  const changed = !preSignature
    || preSignature.url !== after.url
    || preSignature.layers !== after.layers
    || preSignature.hash !== after.hash
    || preSignature.scrollHeight !== after.scrollHeight
    || xhrJump >= 1;
  if (changed) {
    return { changed: true, dispatched: false, after };
  }
  if (!el) return { changed: false, dispatched: false, after, reason: "element-not-found" };
  // Safety: classify whether the element is form-submit-like. Real form
  // submits can use sendBeacon / WebSocket / classic navigation, none of
  // which flip the XHR counter within our 120ms window. Re-dispatching
  // would risk double-submit. For these elements we REPORT the
  // suspected no-advance instead of dispatching — the agent surfaces
  // `autoFallbackSkipped` and can re-issue manually after verification.
  let isSubmitLike = false;
  try {
    const tag = (el.tagName || "").toLowerCase();
    const typeAttr = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
    // <input type=submit|image> always submits.
    if (tag === "input" && (typeAttr === "submit" || typeAttr === "image")) isSubmitLike = true;
    // <button>: type=submit explicit, OR no type (defaults to submit) when
    // the button is associated with a form (DOM ancestor <form>, or
    // explicit form="id" attribute). type="button"/"reset" are NOT submits.
    else if (tag === "button") {
      const associatedWithForm = !!(el.closest && el.closest("form")) || !!(el.getAttribute && el.getAttribute("form"));
      if (typeAttr === "submit") isSubmitLike = true;
      else if (typeAttr === "" && associatedWithForm) isSubmitLike = true;
    }
  } catch (_) { /* detached element */ }
  if (isSubmitLike) {
    return { changed: false, dispatched: false, after, reason: "submit-class-no-advance" };
  }
  // Synthetic dispatch — same shape as the existing --bypass-overlay path.
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return { changed: false, dispatched: false, after, reason: "zero-rect" };
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, buttons: 1 };
  try { el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse", isPrimary: true })); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mousedown", init));
  try { el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse", isPrimary: true })); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mouseup", init));
  el.dispatchEvent(new MouseEvent("click", init));
  return { changed: false, dispatched: true, after };
}

function preflightElement(el, opts = {}) {
  if (opts.scroll !== false) {
    const pre = el.getBoundingClientRect();
    const cx = pre.left + pre.width / 2;
    const cy = pre.top + pre.height / 2;
    const alreadyInView = pre.width > 0 && pre.height > 0 && cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight;
    if (!alreadyInView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  }
  const r = el.getBoundingClientRect();
  const viewport = viewportInfo(el);
  const style = getComputedStyle(el);
  const text = (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const hitDesc = (!viewport.topmost && viewport.hit) ? (() => {
    const h = viewport.hit;
    const hTag = h.tagName ? h.tagName.toLowerCase() : "?";
    const hRole = h.getAttribute ? (h.getAttribute("role") || "") : "";
    const hClass = h.className ? String(h.className).split(/\s+/).slice(0, 2).join(".") : "";
    return `${hTag}${hRole ? `[role=${hRole}]` : ""}${hClass ? `.${hClass}` : ""}`;
  })() : undefined;
  return {
    ref: el.getAttribute("data-realbrowser-ref") || undefined,
    tag: el.tagName.toLowerCase(),
    text,
    center: viewport.center,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    visible: isVisibleInPage(el),
    enabled: !(el.disabled || el.getAttribute("aria-disabled") === "true"),
    pointerEnabled: style.pointerEvents !== "none",
    inViewport: viewport.inViewport,
    topmost: viewport.topmost,
    coveredBy: hitDesc,
  };
}

function fileDialogTriggerReason(el) {
  if (!el) return "";
  const tag = el.tagName?.toLowerCase?.() || "";
  const type = String(el.getAttribute?.("type") || "").toLowerCase();
  const controls = el.getAttribute?.("for");
  const explicitFileInput = tag === "input" && type === "file";
  const containsFileInput = Boolean(el.querySelector?.("input[type=file]"));
  const labelsFileInput = Boolean(controls && document.getElementById(controls)?.matches?.("input[type=file]"));
  if (explicitFileInput) return "input[type=file]";
  if (containsFileInput) return "contains input[type=file]";
  if (labelsFileInput) return "label for input[type=file]";
  return "";
}

function fillFunction(selector, value, selectMode = false, opts = {}) {
  const root = opts.activeRoot || opts.root === "active" ? activeRootElementSourceEval() : document;
  const el = root.querySelector(selector) || pierceQuerySelector(root, selector) || pierceQuerySelector(document, selector);
  if (!el) throw new Error("selector not found: " + selector);
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  // Snapshot the prior visible value so callers can detect silent no-ops:
  // some custom datepickers / masked inputs accept the value via .value but
  // their UI state (the value users see) doesn't actually change. Custom
  // pickers often strip our text and re-render the placeholder.
  const priorVisibleValue = el.isContentEditable || el.getAttribute("role") === "textbox"
    ? (el.innerText || el.textContent || "").trim()
    : (typeof el.value === "string" ? el.value : "");
  if (el instanceof HTMLSelectElement || selectMode) {
    const option = [...el.options].find((entry) => entry.value === value || entry.label === value || entry.textContent.trim() === value);
    if (!option) throw new Error("option not found: " + value);
    el.value = option.value;
  } else if (el.isContentEditable || el.getAttribute("role") === "textbox") {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, value);
    if (!inserted) {
      el.textContent = "";
      const textNode = document.createTextNode(value);
      el.appendChild(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } else {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  // Verify the field actually accepted the value. Custom datepickers often
  // strip text input — they render today's date back. requireChange surfaces
  // this as an error so the agent pivots instead of silently submitting.
  const afterVisibleValue = el.isContentEditable || el.getAttribute("role") === "textbox"
    ? (el.innerText || el.textContent || "").trim()
    : (typeof el.value === "string" ? el.value : "");
  const expected = String(value || "").trim();
  const accepted = afterVisibleValue === expected
    || (afterVisibleValue && expected && afterVisibleValue.includes(expected));
  if (opts.requireChange && !accepted && priorVisibleValue === afterVisibleValue) {
    throw new Error(`fill no-op: input value did not change after typing "${expected}" (current value: "${afterVisibleValue.slice(0, 80)}"); the field may be a custom widget that rejects synthetic input — try the picker UI (calendar, dropdown, datepicker) instead`);
  }
  return {
    filled: true,
    selector,
    tag: el.tagName.toLowerCase(),
    value: el.type === "password" ? "[redacted]" : value,
    accepted,
    priorValue: el.type === "password" ? "[redacted]" : priorVisibleValue.slice(0, 120),
    afterValue: el.type === "password" ? "[redacted]" : afterVisibleValue.slice(0, 120),
  };
}

function uploadEventsFunction(selector) {
  const el = document.querySelector(selector) || document.querySelector("[data-realbrowser-upload-target]");
  if (!el) return { dispatched: false };
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { dispatched: true, files: el.files?.length || 0 };
}

function uploadVerifyFunction(filename, opts = {}) {
  const root = opts.root === "page" ? (document.body || document.documentElement) : activeRootElementSourceEval();
  const scope = root || document;
  const text = (scope.innerText || scope.textContent || "").replace(/\s+/g, " ");
  const previews = [...scope.querySelectorAll("img,video")].slice(0, 20).map((el) => ({
    tag: el.tagName.toLowerCase(),
    src: el.currentSrc || el.src || undefined,
    alt: el.getAttribute("alt") || undefined,
    width: el.naturalWidth || el.videoWidth || el.clientWidth || undefined,
    height: el.naturalHeight || el.videoHeight || el.clientHeight || undefined,
  }));
  const enabledFinal = [...scope.querySelectorAll("button,[role=button],input[type=submit]")].filter(isVisibleInPage).filter((el) => !(el.disabled || el.getAttribute("aria-disabled") === "true")).map((el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim()).filter(Boolean).slice(0, 20);
  return { filenameMentioned: filename ? text.includes(filename) : false, previewCount: previews.length, previews, enabledFinal };
}

function annotateRefsFunction(opts = {}) {
  clearAnnotationsFunction();
  const root = opts.selector ? document.querySelector(opts.selector) : (opts.root === "active" ? activeRootElementSourceEval() : document);
  const scope = root || document;
  const rawLimit = Number(opts.maxLabels || opts.limit || 80);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 80;
  const candidates = [];
  const seen = new Set();
  const addCandidate = (el, kind) => {
    if (!(el instanceof Element) || seen.has(el)) return;
    const rootRef = el.getAttribute("data-realbrowser-root");
    const ref = kind === "root" ? rootRef : el.getAttribute("data-realbrowser-ref");
    if (!ref) return;
    seen.add(el);
    candidates.push({ el, kind, ref });
  };
  addCandidate(scope, "root");
  addCandidate(scope, "ref");
  for (const el of [...(scope.querySelectorAll?.("[data-realbrowser-root]") || [])]) addCandidate(el, "root");
  for (const el of [...(scope.querySelectorAll?.("[data-realbrowser-ref]") || [])]) addCandidate(el, "ref");
  const viewport = {
    width: window.innerWidth || document.documentElement.clientWidth || 1,
    height: window.innerHeight || document.documentElement.clientHeight || 1,
  };
  const skipped = { hidden: 0, offscreen: 0, tiny: 0, limit: 0, invalid: 0 };
  const items = [];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const visibleRect = (rect) => {
    const left = clamp(rect.left, 0, viewport.width);
    const top = clamp(rect.top, 0, viewport.height);
    const right = clamp(rect.right, 0, viewport.width);
    const bottom = clamp(rect.bottom, 0, viewport.height);
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(0, Math.round(right - left)),
      height: Math.max(0, Math.round(bottom - top)),
    };
  };
  for (const candidate of candidates) {
    if (items.length >= limit) {
      skipped.limit += 1;
      continue;
    }
    if (!candidate.el?.getBoundingClientRect) {
      skipped.invalid += 1;
      continue;
    }
    if (!isVisibleInPage(candidate.el)) {
      skipped.hidden += 1;
      continue;
    }
    const rect = candidate.el.getBoundingClientRect();
    const visible = visibleRect(rect);
    if (visible.width <= 0 || visible.height <= 0) {
      skipped.offscreen += 1;
      continue;
    }
    if (visible.width < 2 || visible.height < 2) {
      skipped.tiny += 1;
      continue;
    }
    items.push({
      ref: candidate.ref,
      kind: candidate.kind,
      tag: candidate.el.tagName.toLowerCase(),
      role: candidate.el.getAttribute("role") || undefined,
      visibleRect: visible,
    });
  }
  const overlay = document.createElement("div");
  overlay.setAttribute("data-realbrowser-annotation", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483647",
    pointerEvents: "none",
    fontFamily: '"SF Mono","SFMono-Regular",Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
  });
  document.documentElement.appendChild(overlay);
  for (const item of items) {
    const isRoot = item.kind === "root";
    const left = item.visibleRect.x;
    const top = item.visibleRect.y;
    const labelTop = clamp(top - 18, 0, Math.max(0, viewport.height - 16));
    const box = document.createElement("div");
    box.setAttribute("data-realbrowser-annotation", "true");
    Object.assign(box.style, {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(1, item.visibleRect.width)}px`,
      height: `${Math.max(1, item.visibleRect.height)}px`,
      border: isRoot ? "2px dashed #2f7cf6" : "2px solid #ffb020",
      background: isRoot ? "rgba(47,124,246,0.06)" : "rgba(255,176,32,0.08)",
      boxSizing: "border-box",
      pointerEvents: "none",
      boxShadow: "0 0 0 1px rgba(0,0,0,.35)",
    });
    const badge = document.createElement("div");
    badge.setAttribute("data-realbrowser-annotation", "true");
    badge.textContent = item.ref;
    Object.assign(badge.style, {
      position: "fixed",
      left: `${left}px`,
      top: `${labelTop}px`,
      background: isRoot ? "#2f7cf6" : "#ffb020",
      color: isRoot ? "#fff" : "#1a1a1a",
      borderRadius: "3px",
      padding: "1px 4px",
      font: "12px/14px monospace",
      pointerEvents: "none",
      boxShadow: "0 1px 2px rgba(0,0,0,.35)",
      whiteSpace: "nowrap",
    });
    overlay.appendChild(box);
    overlay.appendChild(badge);
  }
  return {
    count: items.length,
    skipped,
    rootIncluded: items.some((item) => item.kind === "root"),
    refs: items.map((item) => ({
      ref: item.ref,
      kind: item.kind,
      tag: item.tag,
      role: item.role,
      visibleRect: item.visibleRect,
    })),
  };
}

function clearAnnotationsFunction() {
  document.querySelectorAll("[data-realbrowser-annotation]").forEach((el) => el.remove());
  return { cleared: true };
}

function fullScreenshotTargetFunction(selector = "") {
  const markerAttr = "data-realbrowser-full-screenshot-target";
  const marker = `rb2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const doc = document.documentElement;
  const body = document.body;
  const viewport = {
    innerWidth: Math.max(1, Math.round(window.innerWidth || doc?.clientWidth || 0)),
    innerHeight: Math.max(1, Math.round(window.innerHeight || doc?.clientHeight || 0)),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
  };
  const documentSize = {
    scrollWidth: Math.max(viewport.innerWidth, Math.round(doc?.scrollWidth || 0), Math.round(body?.scrollWidth || 0)),
    scrollHeight: Math.max(viewport.innerHeight, Math.round(doc?.scrollHeight || 0), Math.round(body?.scrollHeight || 0)),
    clientWidth: Math.max(1, Math.round(doc?.clientWidth || viewport.innerWidth)),
    clientHeight: Math.max(1, Math.round(doc?.clientHeight || viewport.innerHeight)),
  };
  const describe = (el, index = -1) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, viewport.innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, viewport.innerHeight) - Math.max(rect.top, 0));
    const scrollExtra = Math.max(0, Math.round(el.scrollHeight || 0) - Math.round(el.clientHeight || 0));
    const score = (scrollExtra * Math.max(1, visibleWidth)) + (visibleWidth * visibleHeight);
    return {
      index,
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      className: String(el.className || "").slice(0, 160),
      overflowY: style.overflowY,
      scrollTop: Math.round(el.scrollTop || 0),
      scrollHeight: Math.round(el.scrollHeight || 0),
      clientHeight: Math.round(el.clientHeight || 0),
      clientWidth: Math.round(el.clientWidth || 0),
      scrollExtra,
      visibleWidth: Math.round(visibleWidth),
      visibleHeight: Math.round(visibleHeight),
      score,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
    };
  };
  let selected = null;
  let selectedBy = "";
  let candidates = [];
  if (selector) {
    selected = document.querySelector(selector);
    if (!selected) throw new Error("Selector not found: " + selector);
    selectedBy = "selector";
  } else {
    candidates = Array.from(document.querySelectorAll("*"))
      .map((el, index) => ({ el, info: describe(el, index) }))
      .filter(({ info }) =>
        info.scrollExtra > 20 &&
        info.visibleWidth > 40 &&
        info.visibleHeight > 40 &&
        ["auto", "scroll", "overlay"].includes(info.overflowY)
      )
      .sort((left, right) => right.info.score - left.info.score);
    selected = candidates[0]?.el ?? null;
    selectedBy = selected ? "dominant-scroll-container" : "";
  }
  const target = selected ? describe(selected, candidates.find((entry) => entry.el === selected)?.info?.index ?? -1) : null;
  if (selected) selected.setAttribute(markerAttr, marker);
  return {
    markerAttr,
    marker,
    selectedBy,
    selector: selector || undefined,
    viewport,
    document: documentSize,
    target,
    candidates: candidates.slice(0, 5).map((entry) => entry.info),
  };
}

function cleanupFullScreenshotTargetFunction(markerAttr, marker) {
  if (!markerAttr || !marker) return { cleared: false };
  document.querySelectorAll(`[${markerAttr}="${marker}"]`).forEach((el) => {
    if (el.getAttribute(markerAttr) === marker) el.removeAttribute(markerAttr);
  });
  return { cleared: true };
}

function setFullScreenshotScrollOffsetFunction(markerAttr, marker, offset) {
  const el = document.querySelector(`[${markerAttr}="${marker}"]`);
  if (!el) throw new Error("Marked scroll container disappeared.");
  el.scrollTop = Math.max(0, Number(offset || 0));
  return { scrollTop: Math.round(el.scrollTop || 0) };
}

function composeStitchedScrollScreenshotFunction(payload = {}) {
  const loadImage = (base64) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load screenshot segment."));
    img.src = "data:image/png;base64," + base64;
  });
  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").replace(/^data:[^;]+;base64,/, ""));
    reader.onerror = () => reject(reader.error || new Error("Could not encode stitched screenshot."));
    reader.readAsDataURL(blob);
  });
  const canvasToBase64 = async (canvas, mimeType, quality) => {
    if (typeof canvas.convertToBlob === "function") {
      return await blobToBase64(await canvas.convertToBlob({ type: mimeType, quality }));
    }
    if (typeof canvas.toBlob === "function") {
      return await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) reject(new Error("Could not encode stitched screenshot."));
          else blobToBase64(blob).then(resolve, reject);
        }, mimeType, quality);
      });
    }
    return canvas.toDataURL(mimeType, quality).replace(/^data:[^;]+;base64,/, "");
  };
  return Promise.all((payload.shots || []).map((shot) => loadImage(shot.data))).then(async (images) => {
    const finalWidth = Math.max(1, Math.round(Number(payload.finalWidth || 0)));
    const finalHeight = Math.max(1, Math.round(Number(payload.finalHeight || 0)));
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(finalWidth, finalHeight) : document.createElement("canvas");
    canvas.width = finalWidth;
    canvas.height = finalHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not create 2d canvas context.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, finalWidth, finalHeight);
    const headerHeight = Math.max(0, Math.round(Number(payload.headerHeight || 0)));
    if (headerHeight > 0 && images[0]) {
      ctx.drawImage(images[0], 0, 0, finalWidth, headerHeight, 0, 0, finalWidth, headerHeight);
    }
    const footerHeight = Math.max(0, Math.round(Number(payload.footerHeight || 0)));
    const footerTop = Math.max(0, Math.round(Number(payload.footerTop || 0)));
    const scrollContentHeight = Math.max(1, finalHeight - headerHeight - footerHeight);
    images.forEach((img, index) => {
      const shot = payload.shots[index];
      const destY = headerHeight + Math.round(Number(shot.offset || 0) * Number(payload.scaleY || 1));
      const remaining = headerHeight + scrollContentHeight - destY;
      if (remaining <= 0) return;
      const height = Math.max(1, Math.min(Math.round(Number(payload.cropHeight || 0)), remaining));
      ctx.drawImage(
        img,
        Math.max(0, Math.round(Number(payload.cropLeft || 0))),
        Math.max(0, Math.round(Number(payload.cropTop || 0))),
        Math.max(1, Math.round(Number(payload.cropWidth || finalWidth))),
        height,
        0,
        destY,
        finalWidth,
        height,
      );
    });
    if (footerHeight > 0 && images.length > 0) {
      const footerImage = images[images.length - 1];
      ctx.drawImage(
        footerImage,
        0,
        footerTop,
        finalWidth,
        footerHeight,
        0,
        headerHeight + scrollContentHeight,
        finalWidth,
        footerHeight,
      );
    }
    const mimeType = payload.mimeType || "image/png";
    const base64 = await canvasToBase64(canvas, mimeType, payload.quality);
    return { base64, width: finalWidth, height: finalHeight, mimeType };
  });
}

function screenshotMetadataFunction() {
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY },
  };
}

function pageSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PAGE_HELPERS = [
  isVisibleInPage,
  viewportInfo,
  pageSizeFunction,
  refKind,
  markRef,
  pierceQuerySelector,
  pierceQuerySelectorAll,
  activeRootElementSourceEval,
  resolveCollectionRoot,
  collectionChildren,
  rootInfo,
  itemPayload,
  preflightElement,
  fileDialogTriggerReason,
  clearAnnotationsFunction,
  elementInFloatingLayer,
  pageStateSignature,
  pageSleep,
].map((fn) => fn.toString()).join("\n");

async function waitForReadyState(daemon, targetId, wanted = "interactive", timeout = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  const order = { loading: 0, interactive: 1, complete: 2 };
  let last = "";
  while (Date.now() < deadline) {
    last = await daemon.callFunction(targetId, () => document.readyState, []).catch(() => "");
    if ((order[last] || 0) >= (order[wanted] || 1)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for readyState ${wanted}; last=${last}`);
}

async function waitForUrl(daemon, targetId, wantedUrl, timeout = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    last = await daemon.callFunction(targetId, () => location.href, []).catch(() => "");
    if (last && last !== "about:blank" && sameUrl(last, wantedUrl)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for URL ${wantedUrl}; last=${last}`);
}

async function waitForOpenedTab(daemon, wantedUrl, beforeIds, timeout = DEFAULT_TIMEOUT, options = {}) {
  const deadline = Date.now() + timeout;
  let last = [];
  while (Date.now() < deadline) {
    last = await daemon.tabs().catch(() => []);
    const matches = last.filter((tab) => sameUrl(tab.url, wantedUrl));
    const fresh = matches.find((tab) => !beforeIds.has(tab.targetId));
    if (fresh) return fresh;
    if (!options.requireFresh && matches.length === 1) return matches[0];
    await sleep(150);
  }
  throw new Error(`timed out waiting for opened tab ${wantedUrl}; last=${last.map((tab) => tab.url).slice(0, 8).join(", ")}`);
}

function waitReadyFunction(opts = {}) {
  return (async () => {
    const deadline = Date.now() + (opts.timeout || 15000);
    let reason = "";
    while (Date.now() < deadline) {
      const ready = document.readyState === "interactive" || document.readyState === "complete";
      const selectorOk = opts.selector ? Boolean(document.querySelector(opts.selector)) : true;
      const textOk = opts.text ? (document.body?.innerText || "").includes(opts.text) : true;
      const minOk = opts.minItems ? document.querySelectorAll(opts.selector || "article,[role=article],[role=listitem],li,tr,.card").length >= opts.minItems : true;
      const visibleText = (document.body?.innerText || "").trim().length > 0;
      const skeletonOk = opts.noSkeletons ? document.querySelectorAll('[aria-busy="true"],.skeleton,.loading,[data-loading="true"]').length === 0 : true;
      let stableOk = true;
      if (opts.visualStable) {
        const before = `${document.body?.innerText?.length || 0}:${document.documentElement.scrollHeight}`;
        await pageSleep(Number(opts.settleMs || 250));
        const after = `${document.body?.innerText?.length || 0}:${document.documentElement.scrollHeight}`;
        stableOk = before === after;
      }
      if (ready && selectorOk && textOk && minOk && visibleText && skeletonOk && stableOk) {
        reason = [ready ? "readyState" : "", selectorOk && opts.selector ? "selector" : "", textOk && opts.text ? "text" : "", minOk && opts.minItems ? "items" : "", visibleText ? "visible-text" : "", skeletonOk && opts.noSkeletons ? "no-skeletons" : "", stableOk && opts.visualStable ? "visual-stable" : ""].filter(Boolean).join(",");
        return { ok: true, reason, url: location.href, title: document.title, readyState: document.readyState };
      }
      await pageSleep(150);
    }
    throw new Error("timed out waiting for ready content");
  })();
}

function waitSelectorFunction(selector, timeout = 15000, visibleOnly = false) {
  return (async () => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(selector);
      if (el && (!visibleOnly || isVisibleInPage(el))) return { ok: true, selector, visible: isVisibleInPage(el) };
      await pageSleep(100);
    }
    throw new Error("timed out waiting for selector: " + selector);
  })();
}

function waitTextFunction(text, timeout = 15000, visibleOnly = false) {
  return (async () => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const haystack = visibleOnly ? (document.body?.innerText || "") : (document.documentElement?.textContent || "");
      if (haystack.includes(text)) return { ok: true, text };
      await pageSleep(100);
    }
    throw new Error("timed out waiting for text: " + text);
  })();
}

function waitUrlFunction(contains, timeout = 15000) {
  return (async () => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (location.href.includes(contains)) return { ok: true, url: location.href };
      await pageSleep(100);
    }
    throw new Error("timed out waiting for URL containing: " + contains);
  })();
}

function waitNetworkIdleFunction(timeout = 5000) {
  return (async () => {
    const start = performance.getEntriesByType("resource").length;
    await pageSleep(timeout);
    const end = performance.getEntriesByType("resource").length;
    return { ok: true, startResources: start, endResources: end, idleMs: timeout };
  })();
}

function viewportInfoFunction() {
  return { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio };
}

function perfFunction() {
  const nav = performance.getEntriesByType("navigation")[0];
  const paints = performance.getEntriesByType("paint").map((entry) => ({ name: entry.name, startTime: Math.round(entry.startTime) }));
  const resources = performance.getEntriesByType("resource");
  if (!nav) return { paints, resources: resources.length };
  return {
    dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
    tcp: Math.round(nav.connectEnd - nav.connectStart),
    ssl: Math.round(nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0),
    ttfb: Math.round(nav.responseStart - nav.requestStart),
    download: Math.round(nav.responseEnd - nav.responseStart),
    domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
    load: Math.round(nav.loadEventEnd - nav.startTime),
    total: Math.round(nav.loadEventEnd - nav.startTime),
    paints,
    resources: resources.length,
  };
}

function clearCookieFunction(name) {
  const names = name ? [name] : document.cookie.split(";").map((part) => part.trim().split("=")[0]).filter(Boolean);
  for (const cookieName of names) {
    document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
  return { cleared: names };
}

function storageFunction(args = [], values = false) {
  const [sub = "list", area = "local", key = "", ...valueParts] = args;
  const store = area === "session" ? sessionStorage : localStorage;
  if (sub === "get") return { area, key, value: values ? store.getItem(key) : `[redacted ${String(store.getItem(key) || "").length} chars]` };
  if (sub === "set") {
    store.setItem(key, valueParts.join(" "));
    return { area, key, set: true };
  }
  if (sub === "clear") {
    const count = store.length;
    store.clear();
    return { area, cleared: count };
  }
  const out = {};
  for (let i = 0; i < store.length; i += 1) {
    const k = store.key(i);
    out[k] = values ? store.getItem(k) : `[redacted ${String(store.getItem(k) || "").length} chars]`;
  }
  return { area, values: out };
}

function cacheClearFunction() {
  return (async () => {
    if (!("caches" in window)) return { supported: false, cleared: 0 };
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    return { supported: true, cleared: keys.length, keys };
  })();
}

function clipboardReadFunction() {
  return (async () => {
    if (!navigator.clipboard?.readText) throw new Error("clipboard read is not available in this context");
    return { value: await navigator.clipboard.readText() };
  })();
}

function clipboardWriteFunction(value) {
  return (async () => {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard write is not available in this context");
    await navigator.clipboard.writeText(String(value || ""));
    return { written: true, chars: String(value || "").length };
  })();
}

async function emulate(daemon, targetId, args, flags) {
  const reset = args[0] === "reset";
  if (reset) {
    await daemon.sendToTarget(targetId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    await daemon.sendToTarget(targetId, "Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await daemon.sendToTarget(targetId, "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    await daemon.sendToTarget(targetId, "Emulation.setTimezoneOverride", { timezoneId: "" }).catch(() => {});
    await daemon.sendToTarget(targetId, "Emulation.setLocaleOverride", { locale: "" }).catch(() => {});
    return { text: "emulation reset", reset: true };
  }
  if (flags.cpu) await daemon.sendToTarget(targetId, "Emulation.setCPUThrottlingRate", { rate: Number(flags.cpu) });
  if (flags.userAgent) await daemon.sendToTarget(targetId, "Network.setUserAgentOverride", { userAgent: flags.userAgent });
  if (flags.colorScheme) await daemon.sendToTarget(targetId, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: flags.colorScheme }] });
  if (flags.timezone) await daemon.sendToTarget(targetId, "Emulation.setTimezoneOverride", { timezoneId: flags.timezone });
  if (flags.locale) await daemon.sendToTarget(targetId, "Emulation.setLocaleOverride", { locale: flags.locale });
  if (flags.geolocation) {
    const [latitude, longitude] = String(flags.geolocation).split(/[,x]/).map(Number);
    await daemon.sendToTarget(targetId, "Emulation.setGeolocationOverride", { latitude, longitude, accuracy: 50 });
  }
  if (flags.network) {
    const offline = /offline/i.test(flags.network);
    await daemon.sendToTarget(targetId, "Network.emulateNetworkConditions", {
      offline,
      latency: offline ? 0 : 150,
      downloadThroughput: offline ? 0 : 750 * 1024 / 8,
      uploadThroughput: offline ? 0 : 250 * 1024 / 8,
    });
  }
  return { text: "emulation updated", flags: { cpu: flags.cpu, network: flags.network, userAgent: flags.userAgent, colorScheme: flags.colorScheme, geolocation: flags.geolocation, timezone: flags.timezone, locale: flags.locale } };
}

async function captureCheckpointScreenshot(daemon, targetId, flags, filePath, opts = {}) {
  const annotate = Boolean(flags.annotateRefs || flags.annotate || flags.labels);
  let annotations;
  if (annotate) {
    annotations = await daemon.callFunction(targetId, annotateRefsFunction, [{
      selector: opts.selector || "",
      root: opts.root || flags.root || "",
      maxLabels: flags.maxLabels || flags.limit || 80,
    }]).catch((error) => ({ error: cleanActionErrorMessage(error) }));
  }
  try {
    const capture = await captureScreenshotToFile(daemon, targetId, filePath, { ...opts, flags });
    return {
      ...capture,
      selector: opts.selector || undefined,
      annotated: annotate || undefined,
      annotation: annotations && !annotations.error ? {
        count: annotations.count,
        skipped: annotations.skipped,
        rootIncluded: annotations.rootIncluded,
      } : undefined,
      annotationError: annotations?.error,
    };
  } finally {
    if (annotate) await daemon.callFunction(targetId, clearAnnotationsFunction, []).catch(() => {});
  }
}

async function captureScreenshotToFile(daemon, targetId, filePath, opts = {}) {
  const flags = opts.flags || {};
  let out = path.resolve(expandHome(filePath));
  let format = screenshotFormatForCapture(out, flags, opts);
  const quality = canUseScreenshotQuality(format) ? parseScreenshotQuality(flags.quality || DEFAULT_SCREENSHOT_JPEG_QUALITY) : undefined;
  if (opts.fullPage) {
    const stitched = await maybeCaptureStitchedFullScreenshotToFile(daemon, targetId, out, format, quality, flags, opts.selector || "");
    if (stitched) return stitched;
  }
  let clip;
  let clipInfo;
  let captureBeyondViewport = false;
  if (opts.selector) {
    const box = await daemon.callFunction(targetId, (selector, options = {}) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error("selector not found: " + selector);
      const r = el.getBoundingClientRect();
      const scroll = { x: window.scrollX || 0, y: window.scrollY || 0 };
      const elementRect = {
        x: r.x,
        y: r.y,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
      const viewport = {
        x: 0,
        y: 0,
        width: window.innerWidth || document.documentElement.clientWidth || 1,
        height: window.innerHeight || document.documentElement.clientHeight || 1,
      };
      if (options.clipToViewport) {
        const left = Math.max(0, Math.min(viewport.width, r.left));
        const top = Math.max(0, Math.min(viewport.height, r.top));
        const right = Math.max(left, Math.min(viewport.width, r.right));
        const bottom = Math.max(top, Math.min(viewport.height, r.bottom));
        const visible = { x: Math.floor(left), y: Math.floor(top), width: Math.max(1, Math.ceil(right - left)), height: Math.max(1, Math.ceil(bottom - top)), scale: 1 };
        if (visible.width <= 1 || visible.height <= 1) {
          return { clip: { x: 0, y: 0, width: Math.max(1, Math.ceil(viewport.width)), height: Math.max(1, Math.ceil(viewport.height)), scale: 1 }, clipMode: "viewport-fallback", elementRect, viewport, scroll };
        }
        return { clip: visible, clipMode: "visible", elementRect, viewport, scroll };
      }
      return {
        clip: {
          x: Math.max(0, Math.floor(r.left + scroll.x)),
          y: Math.max(0, Math.floor(r.top + scroll.y)),
          width: Math.max(1, Math.ceil(r.width)),
          height: Math.max(1, Math.ceil(r.height)),
          scale: 1,
        },
        clipMode: "element",
        elementRect,
        viewport,
        scroll,
      };
    }, [opts.selector, { clipToViewport: Boolean(opts.clipToViewport) }]);
    clip = box.clip;
    clipInfo = box;
    captureBeyondViewport = !opts.clipToViewport;
  }
  let viewportExpanded = false;
  let savedViewport;
  if (opts.fullPage && !clip) {
    const metrics = await daemon.sendToTarget(targetId, "Page.getLayoutMetrics", {});
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size?.width && size?.height) {
      const vp = await daemon.callFunction(targetId, () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, sw: screen.width, sh: screen.height }), []).catch(() => null);
      savedViewport = vp;
      const expandW = Math.ceil(Math.max(vp?.w || size.width, size.width));
      const expandH = Math.ceil(Math.max(vp?.h || size.height, size.height));
      await daemon.sendToTarget(targetId, "Emulation.setDeviceMetricsOverride", {
        width: expandW, height: expandH,
        deviceScaleFactor: vp?.dpr || 1, mobile: false,
        screenWidth: vp?.sw || expandW, screenHeight: vp?.sh || expandH,
      }).catch(() => {});
      viewportExpanded = true;
      captureBeyondViewport = true;
    }
  }
  const captureParams = { format };
  if (quality !== undefined) captureParams.quality = quality;
  if (clip) {
    captureParams.clip = clip;
    if (captureBeyondViewport) captureParams.captureBeyondViewport = true;
  }
  if (viewportExpanded) captureParams.captureBeyondViewport = true;
  const shot = await daemon.sendToTarget(targetId, "Page.captureScreenshot", captureParams, 60_000);
  if (viewportExpanded) {
    await daemon.sendToTarget(targetId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    if (savedViewport) {
      const restored = await daemon.callFunction(targetId, () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }), []).catch(() => null);
      if (restored && (restored.w !== savedViewport.w || restored.h !== savedViewport.h || restored.dpr !== savedViewport.dpr)) {
        await daemon.sendToTarget(targetId, "Emulation.setDeviceMetricsOverride", {
          width: savedViewport.w, height: savedViewport.h,
          deviceScaleFactor: savedViewport.dpr || 1, mobile: false,
          screenWidth: savedViewport.sw || savedViewport.w, screenHeight: savedViewport.sh || savedViewport.h,
        }).catch(() => {});
      }
    }
  }
  let buffer = Buffer.from(shot.data || "", "base64");
  const originalBytes = buffer.byteLength;
  const originalDimensions = imageDimensionsFromBuffer(buffer);
  const normalizationFlags = format === "png" && !flags.normalize ? { ...flags, noNormalize: true } : flags;
  const normalization = await normalizeScreenshotArtifact(daemon, targetId, buffer, format, normalizationFlags, originalDimensions).catch((error) => ({
    buffer,
    format,
    warning: `screenshot normalization failed: ${cleanActionErrorMessage(error)}`,
  }));
  buffer = normalization.buffer || buffer;
  format = normalization.format || format;
  if (!pathMatchesFormat(out, format)) out = replaceFileExtension(out, extensionForFormat(format));
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, buffer);
  const dimensions = imageDimensionsFromBuffer(buffer) || await imageDimensions(out).catch(() => ({}));
  const stat = await fsp.stat(out);
  const metadata = await daemon.callFunction(targetId, screenshotMetadataFunction, []).catch(() => ({}));
  return {
    path: out,
    bytes: stat.size,
    width: dimensions.width,
    height: dimensions.height,
    format,
    originalBytes,
    originalDimensions,
    normalized: normalization.normalized || undefined,
    normalizationWarning: normalization.warning,
    normalization: normalization.info,
    clipMode: clipInfo?.clipMode || (clip ? (opts.fullPage ? "fullPage" : "element") : "viewport"),
    clip: clip || undefined,
    elementRect: clipInfo?.elementRect,
    captureScroll: clipInfo?.scroll,
    ...metadata,
  };
}

async function maybeCaptureStitchedFullScreenshotToFile(daemon, targetId, out, format, quality, flags = {}, selector = "") {
  const prepared = await daemon.callFunction(targetId, fullScreenshotTargetFunction, [selector]).catch(() => null);
  if (!prepared?.viewport || !prepared?.document) return null;
  try {
    const target = prepared.target;
    const documentScrollExtra = Math.max(0, Number(prepared.document.scrollHeight || 0) - Number(prepared.viewport.innerHeight || 0));
    const targetScrollExtra = target ? Math.max(0, Number(target.scrollHeight || 0) - Number(target.clientHeight || 0)) : 0;
    if (selector) {
      if (!target || targetScrollExtra <= 20) return null;
    } else if (documentScrollExtra > 20 || !target || targetScrollExtra <= 20) {
      return null;
    }
    return await captureStitchedScrollContainerToFile(daemon, targetId, out, format, quality, flags, prepared);
  } finally {
    await daemon.callFunction(targetId, cleanupFullScreenshotTargetFunction, [prepared.markerAttr, prepared.marker]).catch(() => {});
  }
}

async function captureStitchedScrollContainerToFile(daemon, targetId, out, format, quality, flags = {}, prepared) {
  const target = prepared.target;
  const scrollHeight = Math.max(1, Math.round(Number(target.scrollHeight || 0)));
  const clientHeight = Math.max(1, Math.round(Number(target.clientHeight || 0)));
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const offsets = [];
  for (let offset = 0; offset < maxScroll; offset += clientHeight) offsets.push(Math.round(offset));
  if (!offsets.includes(Math.round(maxScroll))) offsets.push(Math.round(maxScroll));
  const maxCaptures = flags.maxStitchCaptures === undefined ? 80 : parsePositiveInteger(flags.maxStitchCaptures, "max-stitch-captures");
  if (offsets.length > maxCaptures) {
    throw new Error(`full screenshot would need ${offsets.length} stitched captures; pass --selector for a smaller scroll container or use a larger viewport.`);
  }

  const settleMs = flags.settleMs === undefined ? 200 : Math.max(0, Number(flags.settleMs || 0));
  const originalScrollTop = Math.max(0, Math.round(Number(target.scrollTop || 0)));
  const shots = [];
  try {
    for (const offset of offsets) {
      await daemon.callFunction(targetId, setFullScreenshotScrollOffsetFunction, [prepared.markerAttr, prepared.marker, offset]);
      if (settleMs > 0) await sleep(settleMs);
      const shot = await captureViewportPngSegment(daemon, targetId);
      shots.push({ offset, data: shot.data, png: shot.dimensions });
    }
  } finally {
    await daemon.callFunction(targetId, setFullScreenshotScrollOffsetFunction, [prepared.markerAttr, prepared.marker, originalScrollTop]).catch(() => {});
  }

  if (!shots.length) throw new Error("No stitched screenshot segments captured.");
  const first = shots[0];
  const viewport = prepared.viewport;
  const scaleX = Number(first.png.width || 0) / Math.max(1, Number(viewport.innerWidth || viewport.width || 0));
  const scaleY = Number(first.png.height || 0) / Math.max(1, Number(viewport.innerHeight || viewport.height || 0));
  const selectorMode = Boolean(prepared.selector);
  const cropLeft = selectorMode ? Math.max(0, Math.round(Number(target.rect?.left || 0) * scaleX)) : 0;
  const cropRight = selectorMode
    ? Math.min(Number(first.png.width || 0), Math.round((Number(target.rect?.left || 0) + Number(target.rect?.width || target.clientWidth || 0)) * scaleX))
    : Math.max(1, Number(first.png.width || 0));
  const cropWidth = Math.max(1, cropRight - cropLeft);
  const cropTop = Math.max(0, Math.round(Number(target.rect?.top || 0) * scaleY));
  const cropBottom = Math.min(Number(first.png.height || 0), Math.round((Number(target.rect?.top || 0) + clientHeight) * scaleY));
  const cropHeight = Math.max(1, cropBottom - cropTop);
  const headerHeight = selectorMode ? 0 : cropTop;
  const footerTop = selectorMode ? 0 : cropBottom;
  const footerHeight = selectorMode ? 0 : Math.max(0, Number(first.png.height || 0) - cropBottom);
  const scrollContentHeight = Math.max(1, Math.ceil(scrollHeight * scaleY));
  const payload = {
    shots: shots.map((shot) => ({ offset: shot.offset, data: shot.data })),
    cropLeft,
    cropTop,
    cropWidth,
    cropHeight,
    headerHeight,
    footerTop,
    footerHeight,
    finalWidth: selectorMode ? cropWidth : Math.max(1, Number(first.png.width || 0)),
    finalHeight: headerHeight + scrollContentHeight + footerHeight,
    scaleY,
    mimeType: mimeTypeForScreenshotFormat(format),
    quality: canUseScreenshotQuality(format) ? Math.max(0.01, Math.min(1, Number(quality || DEFAULT_SCREENSHOT_JPEG_QUALITY) / 100)) : undefined,
  };
  const composed = await daemon.callFunction(targetId, composeStitchedScrollScreenshotFunction, [payload], { timeoutMs: 60_000 });
  if (!composed?.base64) throw new Error("Browser compositor did not return stitched screenshot data.");

  let buffer = Buffer.from(String(composed.base64), "base64");
  const originalBytes = buffer.byteLength;
  const originalDimensions = imageDimensionsFromBuffer(buffer);
  const normalizationFlags = format === "png" && !flags.normalize ? { ...flags, noNormalize: true } : flags;
  const normalization = await normalizeScreenshotArtifact(daemon, targetId, buffer, format, normalizationFlags, originalDimensions).catch((error) => ({
    buffer,
    format,
    warning: `screenshot normalization failed: ${cleanActionErrorMessage(error)}`,
  }));
  buffer = normalization.buffer || buffer;
  format = normalization.format || format;
  if (!pathMatchesFormat(out, format)) out = replaceFileExtension(out, extensionForFormat(format));
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, buffer);
  const dimensions = imageDimensionsFromBuffer(buffer) || await imageDimensions(out).catch(() => ({}));
  const stat = await fsp.stat(out);
  const metadata = await daemon.callFunction(targetId, screenshotMetadataFunction, []).catch(() => ({}));
  return {
    path: out,
    bytes: stat.size,
    width: dimensions.width,
    height: dimensions.height,
    format,
    originalBytes,
    originalDimensions,
    normalized: normalization.normalized || undefined,
    normalizationWarning: normalization.warning,
    normalization: normalization.info,
    clipMode: "stitched-scroll-container",
    stitch: {
      method: "dominant-scroll-container",
      selectedBy: prepared.selectedBy,
      offsets: offsets.length,
      scrollHeight,
      clientHeight,
      headerHeight,
      footerHeight,
      viewport: prepared.viewport,
      target: {
        tag: target.tag,
        id: target.id,
        className: target.className,
        overflowY: target.overflowY,
      },
    },
    ...metadata,
  };
}

async function captureViewportPngSegment(daemon, targetId) {
  const shot = await daemon.sendToTarget(targetId, "Page.captureScreenshot", { format: "png" }, 60_000);
  const buffer = Buffer.from(shot.data || "", "base64");
  if (!buffer.byteLength) throw new Error("CDP screenshot did not return image data");
  const dimensions = imageDimensionsFromBuffer(buffer) || {};
  return { data: buffer.toString("base64"), dimensions };
}

function screenshotFormatForCapture(filePath, flags = {}, opts = {}) {
  if (opts.checkpoint && !flags.format && !flags.rawSize && !flags.noNormalize) {
    return defaultScreenshotFormat(flags);
  }
  return inferScreenshotFormat(filePath, flags);
}

async function normalizeScreenshotArtifact(daemon, targetId, buffer, format, flags = {}, dimensions = {}) {
  const options = screenshotNormalizationOptions(flags);
  if (!options.enabled) return { buffer, format, info: { enabled: false } };

  const width = Number(dimensions?.width || 0);
  const height = Number(dimensions?.height || 0);
  const maxDim = Math.max(width, height);
  if (buffer.byteLength <= options.maxBytes && (!maxDim || maxDim <= options.maxSide)) {
    return {
      buffer,
      format,
      info: {
        enabled: true,
        normalized: false,
        maxSide: options.maxSide,
        maxBytes: options.maxBytes,
        bytes: buffer.byteLength,
      },
    };
  }

  const sideStart = maxDim > 0 ? Math.min(options.maxSide, maxDim) : options.maxSide;
  const sideGrid = buildImageResizeSideGrid(options.maxSide, sideStart);
  const qualities = screenshotQualitySteps(options.quality);
  let smallest = null;
  let lastError;
  for (const side of sideGrid) {
    for (const quality of qualities) {
      try {
        const out = await daemon.callFunction(targetId, screenshotCanvasTranscodeFunction, [
          buffer.toString("base64"),
          mimeTypeForScreenshotFormat(format),
          side,
          quality,
        ], { timeoutMs: 60_000 });
        const outBuffer = Buffer.from(out.base64 || "", "base64");
        if (!outBuffer.length) continue;
        const candidate = {
          buffer: outBuffer,
          format: "jpeg",
          normalized: true,
          info: {
            enabled: true,
            normalized: true,
            maxSide: options.maxSide,
            maxBytes: options.maxBytes,
            requestedSide: side,
            quality,
            originalBytes: buffer.byteLength,
            bytes: outBuffer.byteLength,
            originalDimensions: dimensions,
            width: out.width,
            height: out.height,
          },
        };
        if (!smallest || outBuffer.byteLength < smallest.buffer.byteLength) smallest = candidate;
        if (outBuffer.byteLength <= options.maxBytes) return candidate;
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (smallest) {
    smallest.warning = `screenshot is still larger than ${formatBytes(options.maxBytes)} after browser-canvas reduction`;
    return smallest;
  }
  return {
    buffer,
    format,
    info: { enabled: true, normalized: false, maxSide: options.maxSide, maxBytes: options.maxBytes },
    warning: `screenshot normalization failed: ${cleanActionErrorMessage(lastError)}`,
  };
}

function screenshotCanvasTranscodeFunction(base64, mimeType, maxSide, quality) {
  const decode = (value) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").replace(/^data:image\/jpeg;base64,/, ""));
    reader.onerror = () => reject(reader.error || new Error("failed to encode screenshot"));
    reader.readAsDataURL(blob);
  });
  return (async () => {
    const bytes = decode(base64);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType || "image/png" }));
    const scale = Math.min(1, Number(maxSide || 0) / Math.max(bitmap.width, bitmap.height, 1));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("could not create screenshot canvas");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const normalizedQuality = Math.max(0.01, Math.min(1, Number(quality || 85) / 100));
    let blob;
    if (typeof canvas.convertToBlob === "function") {
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: normalizedQuality });
    } else {
      const dataUrl = canvas.toDataURL("image/jpeg", normalizedQuality);
      return { base64: dataUrl.replace(/^data:image\/jpeg;base64,/, ""), width, height };
    }
    return { base64: await blobToBase64(blob), width, height };
  })();
}

function mimeTypeForScreenshotFormat(format) {
  const normalized = normalizeScreenshotFormat(format);
  return normalized === "jpeg" ? "image/jpeg" : normalized === "webp" ? "image/webp" : "image/png";
}

async function dispatchMouseClick(daemon, targetId, x, y) {
  await daemon.sendToTarget(targetId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await daemon.sendToTarget(targetId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await daemon.sendToTarget(targetId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function dispatchMouseDrag(daemon, targetId, from, to, opts = {}) {
  const button = opts.button || "left";
  const buttons = opts.buttons || mouseButtonsFor(button);
  const steps = opts.steps || 12;
  const stepDelay = steps > 0 && opts.duration > 0 ? Math.floor(opts.duration / steps) : 0;
  await daemon.sendToTarget(targetId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0, pointerType: "mouse" });
  await daemon.sendToTarget(targetId, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button, buttons, clickCount: 1, pointerType: "mouse" });
  if (opts.hold > 0) await sleep(opts.hold);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    await daemon.sendToTarget(targetId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button, buttons, pointerType: "mouse" });
    if (stepDelay > 0 && i < steps) await sleep(stepDelay);
  }
  await daemon.sendToTarget(targetId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button, buttons: 0, clickCount: 1, pointerType: "mouse" });
}

async function callAndDispatchMouseClickWithFileChooserGuard(daemon, targetId, selector, options = {}, opts = {}) {
  if (opts.allowFileDialog) {
    const payload = await daemon.callFunction(targetId, clickFunction, [selector, { ...options, allowFileDialog: true }], { timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT });
    if (payload.clickMethod !== "synthetic") await dispatchMouseClick(daemon, targetId, payload.center.x, payload.center.y);
    await maybeRunClickAutoFallback(daemon, targetId, selector, payload, options, opts);
    return payload;
  }
  const sessionId = await daemon.attach(targetId);
  let interceptEnabled = false;
  let chooserPromise;
  try {
    await daemon.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId, 2_000);
    interceptEnabled = true;
    chooserPromise = daemon.cdp.waitFor(
      "Page.fileChooserOpened",
      (_params, message) => message.sessionId === sessionId,
      opts.guardMs || FILE_CHOOSER_CLICK_GUARD_MS,
    );
    chooserPromise.catch(() => {});
    const payload = await daemon.callFunction(targetId, clickFunction, [
      selector,
      { ...options, allowFileDialog: true, fileDialogIntent: true },
    ], { timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT });
    if (payload.clickMethod !== "synthetic") await dispatchMouseClick(daemon, targetId, payload.center.x, payload.center.y);
    const chooser = await chooserPromise.catch(() => null);
    if (chooser?.params) {
      const target = payload.ref || opts.ref || payload.text || payload.tag || "target";
      const trigger = payload.ref || opts.ref || "<ref>";
      throw new CliError(`Click would open a native file chooser for ${target}; use action upload --trigger-ref ${trigger} <file> or pass --allow-file-dialog`, {
        code: "file_dialog_would_open",
        exitCode: 5,
        next: [
          "realbrowser action state -t <target> --root active --compact --screenshot --annotate-refs",
          `realbrowser action upload -t <target> --root active --trigger-ref ${trigger} <file>`,
        ],
      });
    }
    await maybeRunClickAutoFallback(daemon, targetId, selector, payload, options, opts);
    return payload;
  } finally {
    if (interceptEnabled) {
      await daemon.cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId, 2_000).catch(() => {});
    }
  }
}

// Auto-fallback for clicks whose CDP dispatch "registers" but doesn't
// trigger the SPA's delegated handler. Runs once per click, only when the
// original payload reported `clickMethod="cdp"` (synthetic/bypass paths
// already dispatched events directly). The probe checks page-state
// signature 120ms post-click; if URL/layers/hash/network all sit still,
// dispatches synthetic pointerdown+up+click on the resolved element.
//
// Generic across UI kits: floating-layer rows (AntD/Material/Radix
// portals), cursor-clickables (non-ARIA DOM clickables), AND plain
// buttons whose React handlers got detached between CDP dispatch and
// microtask flush. Caps at one synthetic retry — if state still doesn't
// move, returns with `autoFallbackSkipped` so the agent can verify.
async function maybeRunClickAutoFallback(daemon, targetId, selector, payload, options = {}, opts = {}) {
  if (!payload || payload.clickMethod !== "cdp") return;
  if (options && options.bypassOverlay) return; // user already requested forced bypass
  if (opts && opts.skipAutoFallback) return;
  if (opts && opts.command === "hover") return;
  // Tag whether the chosen element was in a portal/popover or a c-ref —
  // diagnostic only, no longer a gate.
  const isCRef = typeof selector === "string" && /\[data-realbrowser-ref="c\d+"\]/.test(selector);
  payload.autoFallbackEligibility = isCRef ? "c-ref" : (payload.inFloatingLayer ? "floating-layer" : "default");
  // Wait briefly so any same-tick layout/state changes settle. AntD
  // closes its popover synchronously when the click handler does fire,
  // so 100ms is plenty without bloating the click latency budget.
  await sleep(120);
  let probe;
  try {
    probe = await daemon.callFunction(
      targetId,
      postClickFallbackFunction,
      [selector, payload.preClickSignature || null],
      { timeoutMs: 2_000 },
    );
  } catch (_) {
    return;
  }
  if (!probe) return;
  if (probe.changed) return; // page state moved — original CDP click worked.
  if (probe.dispatched) {
    payload.clickMethod = "cdp+synthetic-fallback";
    payload.autoFallbackReason = `${payload.autoFallbackEligibility} click did not change page state (${probe.reason || "no signature change"}); dispatched synthetic events`;
  } else if (probe.reason) {
    payload.autoFallbackSkipped = probe.reason;
  }
}

async function dispatchKey(daemon, targetId, key) {
  const def = keyDefinition(key);
  await daemon.sendToTarget(targetId, "Input.dispatchKeyEvent", { ...def, type: "keyDown" });
  await daemon.sendToTarget(targetId, "Input.dispatchKeyEvent", { ...def, type: "keyUp" });
}

function keyDefinition(input) {
  const key = String(input);
  const map = {
    Enter: { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Tab: { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    Escape: { windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    Backspace: { windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
    Delete: { windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
    ArrowLeft: { windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
    ArrowUp: { windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
    ArrowRight: { windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
    ArrowDown: { windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  };
  return { key, code: key, text: key.length === 1 ? key : undefined, unmodifiedText: key.length === 1 ? key : undefined, ...(map[key] || {}) };
}

function queryOptions(flags) {
  return {
    limit: Number(flags.limit || 30),
    maxTextChars: Number(flags.maxTextChars || 300),
    maxHtmlChars: Number(flags.maxHtmlChars || 0),
    visible: Boolean(flags.visible),
    enabled: Boolean(flags.enabled),
    topmost: Boolean(flags.topmost),
    hrefFilter: flags.hrefFilter,
    textFilter: flags.textFilter,
    root: flags.root,
    rootSelector: flags.root?.startsWith?.("selector:") ? flags.root.slice("selector:".length) : flags.rootSelector,
  };
}

function snapshotOptions(flags) {
  return {
    selector: flags.selector || (flags.root?.startsWith?.("selector:") ? flags.root.slice("selector:".length) : ""),
    root: flags.root,
    compact: Boolean(flags.compact),
    interactive: Boolean(flags.interactive),
    cursorInteractive: Boolean(flags.cursorInteractive),
    urls: Boolean(flags.urls),
    linkLimit: Number(flags.linkLimit || 80),
    depth: Number(flags.depth || 8),
    maxNodes: Number(flags.maxNodes || flags.limit || (flags.compact ? 220 : 350)),
    maxTextChars: Number(flags.maxTextChars || 180),
  };
}

function itemsOptions(args, flags) {
  return {
    root: flags.root?.startsWith?.("selector:") ? flags.root.slice("selector:".length) : flags.root || flags.rootSelector || args[0],
    collection: flags.collection || "auto",
    itemSelector: flags.item || flags.itemSelector || flags.cardSelector,
    index: Number(flags.index || args.find((arg) => /^\d+$/.test(arg)) || 1),
    limit: Number(flags.limit || flags.maxItems || 10),
    maxTextChars: Number(flags.maxTextChars || 700),
    directChildren: Boolean(flags.directChildren),
    expand: flags.expand,
    expandSelector: flags.expandSelector,
  };
}

function actionOptions(args, flags) {
  return {
    root: flags.root || (flags.activeRoot ? "active" : undefined),
    activeRoot: flags.root ? Boolean(flags.root === "active" || flags.activeRoot) : true,
    rootSelector: flags.root && flags.root !== "active" && flags.root !== "page" ? flags.root : undefined,
    compact: Boolean(flags.compact),
    limit: Number(flags.limit || 30),
    text: flags.text,
    allowFileDialog: Boolean(flags.allowFileDialog),
    bypassOverlay: Boolean(flags.bypassOverlay),
    requireChange: Boolean(flags.requireChange),
  };
}

function dragArgs(args, flags, targetId, daemon) {
  const usingFromPoint = Boolean(flags.fromPoint);
  const positionalDestination = args[usingFromPoint && !flags.to && !flags.toRef && !flags.toSelector && !flags.toPoint && !flags.by ? 0 : 1];
  const fromToken = usingFromPoint ? "" : (args[0] || flags.ref || flags.from);
  const toToken = positionalDestination || flags.to || flags.toRef || flags.toSelector || "";
  const fromPoint = usingFromPoint ? parsePoint(flags.fromPoint, "--from-point") : null;
  const toPoint = flags.toPoint ? parsePoint(flags.toPoint, "--to-point") : null;
  const by = flags.by ? parsePoint(flags.by, "--by") : null;
  if (!fromPoint && !fromToken) throw usage("action drag requires <from-ref|selector> or --from-point <x,y>");
  if ([toToken, toPoint, by].filter(Boolean).length !== 1) throw usage("action drag accepts exactly one destination: --to, --to-point, --by, or a second positional target");
  const button = parseMouseButton(flags.button || "left");
  return {
    fromSelector: fromPoint ? "" : daemon.selectorFor(targetId, fromToken),
    toSelector: toToken ? daemon.selectorFor(targetId, toToken) : "",
    fromPoint,
    toPoint,
    by,
    fromLabel: fromPoint ? `${fromPoint.x},${fromPoint.y}` : String(fromToken),
    toLabel: by ? `by ${by.x},${by.y}` : toPoint ? `${toPoint.x},${toPoint.y}` : String(toToken),
    button,
    buttons: mouseButtonsFor(button),
    steps: boundedInteger(flags.steps || 12, "steps", 1, 200),
    duration: boundedInteger(flags.duration || 250, "duration", 0, 60_000),
    hold: boundedInteger(flags.hold || 50, "hold", 0, 10_000),
  };
}

function parsePoint(value, label) {
  const match = String(value || "").trim().match(/^(-?\d+(?:\.\d+)?)\s*[,x:]\s*(-?\d+(?:\.\d+)?)$/i);
  if (!match) throw usage(`${label} must be "x,y" in viewport CSS pixels`);
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw usage(`${label} must contain finite numbers`);
  return { x, y };
}

function boundedInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw usage(`${label} must be a number`);
  const integer = Math.round(number);
  if (integer < min || integer > max) throw usage(`${label} must be between ${min} and ${max}`);
  return integer;
}

function parseMouseButton(value) {
  const button = String(value || "left").toLowerCase();
  if (!["left", "middle", "right"].includes(button)) throw usage("button must be left, middle, or right");
  return button;
}

function mouseButtonsFor(button) {
  return button === "left" ? 1 : button === "right" ? 2 : 4;
}

function waitReadyOptions(args, flags, timeout = DEFAULT_TIMEOUT) {
  return {
    selector: flags.selector || flags.readySelector || "",
    text: flags.text || flags.readyText || "",
    minItems: Number(flags.minItems || flags.minCards || 0),
    visualStable: Boolean(flags.visualStable),
    noSkeletons: Boolean(flags.noSkeletons),
    settleMs: Number(flags.settleMs || 250),
    timeout,
  };
}

function valueFromArgs(args, flags) {
  if (flags.stdin) return fs.readFileSync(0, "utf8").replace(/\n$/, "");
  if (flags.valueFile) {
    const file = expandHome(flags.valueFile);
    return file === "-" ? fs.readFileSync(0, "utf8").replace(/\n$/, "") : fs.readFileSync(file, "utf8").replace(/\n$/, "");
  }
  return args.length ? args.join(" ") : undefined;
}

function looksLikeActionTargetToken(value) {
  const raw = String(value || "");
  return /^[ebfrilco]\d+$/i.test(raw) || raw.startsWith("selector:") || /^[#.[>]/.test(raw);
}

function uploadArgs(args, flags, targetId, daemon) {
  const input = flags.input || flags.inputRef || flags.element || flags.ref;
  const trigger = flags.trigger || flags.triggerRef;
  const files = args.filter((arg) => !arg.startsWith("-"));
  if (!files.length) throw usage("action upload requires <file...>");
  if (input && trigger) throw usage("action upload cannot combine --input-ref/--element with --trigger-ref");
  if (trigger) return { triggerSelector: daemon.selectorFor(targetId, trigger), files };
  if (input) return { selector: daemon.selectorFor(targetId, input), files };
  if (files.length === 1) return { selector: "input[type=file]", files };
  return { selector: daemon.selectorFor(targetId, files[0]), files: files.slice(1) };
}

function screenshotAreaArgs(command, args, flags) {
  if (command !== "area") return { selector: flags.selector || "", out: args[0] || flags.out };
  const explicitSelector = flags.selector || flags.ref;
  if (explicitSelector) return { selector: explicitSelector, out: args[0] || flags.out };
  if (!args[0]) throw usage("screenshot area requires <ref|selector> [out.png] or --selector <css> <out.png>");
  return { selector: args[0], out: args[1] || flags.out };
}

function activeRootScreenshotSelector(payload = {}) {
  const root = payload.root || {};
  if (!root.ref) return "";
  if (["body", "html"].includes(String(root.tag || "").toLowerCase())) return "";
  const rect = root.rect || {};
  if (Number(rect.width) <= 0 || Number(rect.height) <= 0) return "";
  return '[data-realbrowser-root="r1"]';
}

function screenshotPath(artifactDir, kind, tab, flags = {}) {
  if (flags.out) return flags.out;
  const target = safeFilePart(tab?.suggestedTarget || tab?.targetPrefix || "target");
  return path.join(artifactDir, `${kind}-${target}-${Date.now()}.${extensionForFormat(defaultScreenshotFormat(flags))}`);
}

function safeFilePart(value) {
  return String(value || "item").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "item";
}

function defaultScreenshotFormat(flags = {}) {
  if (flags.format) return normalizeScreenshotFormat(flags.format);
  if (screenshotNormalizationEnabled(flags)) return "jpeg";
  return "png";
}

function inferScreenshotFormat(filePath, flags = {}) {
  if (flags.format) return normalizeScreenshotFormat(flags.format);
  const lower = String(filePath || "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpeg";
  if (lower.endsWith(".webp")) return "webp";
  if (lower.endsWith(".png")) return "png";
  return defaultScreenshotFormat(flags);
}

function normalizeScreenshotFormat(format) {
  const value = String(format || "png").toLowerCase();
  const normalized = value === "jpg" ? "jpeg" : value;
  if (!["png", "jpeg", "webp"].includes(normalized)) throw usage(`unsupported screenshot format: ${format}`);
  return normalized;
}

function extensionForFormat(format) {
  return normalizeScreenshotFormat(format) === "jpeg" ? "jpg" : normalizeScreenshotFormat(format);
}

function pathMatchesFormat(filePath, format) {
  const lower = String(filePath || "").toLowerCase();
  if (format === "jpeg") return lower.endsWith(".jpg") || lower.endsWith(".jpeg");
  return lower.endsWith(`.${extensionForFormat(format)}`);
}

function replaceFileExtension(filePath, extension) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.${extension}`);
}

function canUseScreenshotQuality(format) {
  return ["jpeg", "webp"].includes(normalizeScreenshotFormat(format));
}

function screenshotNormalizationEnabled(flags = {}) {
  if (flags.rawSize || flags.noNormalize) return false;
  if (flags.normalize) return true;
  const raw = String(process.env.REALBROWSER_SCREENSHOT_NORMALIZE ?? "1").toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function screenshotNormalizationOptions(flags = {}) {
  return {
    enabled: screenshotNormalizationEnabled(flags),
    maxSide: flags.maxSide === undefined ? DEFAULT_SCREENSHOT_MAX_SIDE : parsePositiveInteger(flags.maxSide, "max-side"),
    maxBytes: flags.maxBytes === undefined ? DEFAULT_SCREENSHOT_MAX_BYTES : parseByteSize(flags.maxBytes, "max-bytes"),
    quality: parseScreenshotQuality(flags.quality || DEFAULT_SCREENSHOT_JPEG_QUALITY),
  };
}

function parsePositiveInteger(value, label) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) throw usage(`${label} must be a positive integer`);
  return number;
}

function parseScreenshotQuality(value) {
  const quality = parsePositiveInteger(value, "quality");
  if (quality < 1 || quality > 100) throw usage("quality must be between 1 and 100");
  return quality;
}

function parseByteSize(value, label) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/^(\d+)(?:\s*(b|kb|kib|k|mb|mib|m))?$/);
  if (!match) throw usage(`${label} must be a byte size such as 5242880 or 5mb`);
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || "b";
  const multiplier = unit === "mb" || unit === "mib" || unit === "m" ? 1024 * 1024 : unit === "kb" || unit === "kib" || unit === "k" ? 1024 : 1;
  return amount * multiplier;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildImageResizeSideGrid(maxSide, sideStart) {
  return [sideStart, ...SCREENSHOT_SIDE_STEPS]
    .map((value) => Math.min(maxSide, value))
    .filter((value, index, values) => value > 0 && values.indexOf(value) === index)
    .sort((a, b) => b - a);
}

function screenshotQualitySteps(preferred) {
  return [...new Set([preferred, ...SCREENSHOT_QUALITY_STEPS.filter((quality) => quality < preferred)])];
}

function dimensionCheck(capture, device, opts = {}) {
  const expected = {
    width: Math.round(Number(device.width || 0) * Number(device.dpr || 1)),
    height: Math.round(Number(device.height || 0) * Number(device.dpr || 1)),
  };
  if (!expected.width || !expected.height || opts.selector) return { expected, dimensionOk: undefined };
  const widthOk = Number(capture.width) === expected.width;
  const heightOk = opts.fullPage ? Number(capture.height) >= expected.height : Number(capture.height) === expected.height;
  return { expected, dimensionOk: Boolean(widthOk && heightOk) };
}

function parseDevices(raw) {
  const value = raw || "desktop:1440x900,tablet:768x1024,mobile:390x844";
  return String(value).split(",").map((entry) => {
    const [name, size] = entry.includes(":") ? entry.split(":") : entry.split("=");
    const [width, height] = size.split("x").map(Number);
    const mobile = /mobile|phone|iphone|android/i.test(name);
    return { name, width, height, dpr: 1, mobile };
  });
}

function parseCookie(raw, pageUrl) {
  if (!raw || !raw.includes("=")) throw usage("state cookies set requires <name=value>");
  const eq = raw.indexOf("=");
  const url = new URL(pageUrl);
  return { name: raw.slice(0, eq), value: raw.slice(eq + 1), domain: url.hostname, path: "/" };
}

function parseHeaderFlags(rawHeaders = []) {
  const list = Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders];
  const headers = {};
  for (const raw of list.filter(Boolean)) {
    const index = String(raw).indexOf(":");
    if (index <= 0) throw usage(`invalid header, expected "Name: value": ${raw}`);
    headers[String(raw).slice(0, index).trim()] = String(raw).slice(index + 1).trim();
  }
  if (!Object.keys(headers).length) throw usage('state headers set requires --header "Name: value"');
  return headers;
}

function originFromUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return undefined;
  }
}

function filterRequests(entries, flags) {
  return entries.filter((entry) => {
    if (flags.failed && !entry.failed && !(Number(entry.status) >= 400)) return false;
    if (flags.filter && !String(entry.url || "").includes(flags.filter)) return false;
    if (flags.method && String(entry.method || "").toUpperCase() !== String(flags.method).toUpperCase()) return false;
    if (flags.status && !statusMatches(entry.status, flags.status)) return false;
    if (flags.type && String(entry.type || "").toLowerCase() !== String(flags.type).toLowerCase()) return false;
    return true;
  }).slice(-(Number(flags.limit || 50)));
}

function statusMatches(status, filter) {
  if (String(filter).includes("-")) {
    const [min, max] = String(filter).split("-").map(Number);
    return Number(status) >= min && Number(status) <= max;
  }
  return String(status) === String(filter);
}

function resolveRequestEntry(entries, ref, latest = false) {
  if (!ref) return latest ? entries.at(-1) : null;
  const matches = entries.filter((entry) => entry.id === ref || entry.backendRequestId === ref || String(entry.url || "").includes(ref));
  if (matches.length === 1 || latest) return matches.at(-1);
  if (matches.length > 1) throw usage(`ambiguous request: ${ref}`);
  return null;
}

function compactRequests(entries, flags = {}) {
  return entries.map(compactRequest).slice(-(Number(flags.limit || 50)));
}

function assertNetworkCaptureBodyOut(flags = {}) {
  if (!flags.includeBody || flags.out || flags.force) return;
  throw new CliError("network capture --include-body requires --out unless --force is explicit", {
    code: "large_stdout_guard",
    exitCode: 2,
    next: ["realbrowser network capture -t app --include-body --out tmp/network.json"],
  });
}

function compactRequest(entry) {
  return {
    id: entry.id,
    method: entry.method,
    status: entry.status,
    type: entry.type,
    url: entry.url,
    durationMs: entry.durationMs,
    size: entry.encodedDataLength,
    failed: entry.failed,
    errorText: entry.errorText,
  };
}

function redactRequest(entry) {
  return {
    ...compactRequest(entry),
    requestHeaders: redactHeaders(entry.requestHeaders),
    responseHeaders: redactHeaders(entry.responseHeaders),
    postData: entry.postData ? `[redacted ${entry.postData.length} chars]` : undefined,
  };
}

function redactHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => (
    /authorization|cookie|token|key/i.test(key) ? [key, "[redacted]"] : [key, value]
  )));
}

function buildHar(entries) {
  return {
    log: {
      version: "1.2",
      creator: { name: "realbrowser", version: VERSION },
      entries: entries.map((entry) => ({
        startedDateTime: new Date(entry.timestamp).toISOString(),
        time: entry.durationMs || 0,
        request: { method: entry.method || "GET", url: entry.url || "", httpVersion: "HTTP/2", headers: headersArray(redactHeaders(entry.requestHeaders)), queryString: [], cookies: [], headersSize: -1, bodySize: entry.postData?.length || 0 },
        response: { status: Number(entry.status) || 0, statusText: entry.statusText || "", httpVersion: entry.protocol || "HTTP/2", headers: headersArray(redactHeaders(entry.responseHeaders)), cookies: [], content: { size: entry.encodedDataLength || 0, mimeType: entry.mimeType || "" }, redirectURL: "", headersSize: -1, bodySize: entry.encodedDataLength || 0 },
        cache: {},
        timings: { send: 0, wait: entry.durationMs || 0, receive: 0 },
      })),
    },
  };
}

function headersArray(headers = {}) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function formatTabs(tabs) {
  if (!tabs.length) return "(no targets)";
  const showOwnership = tabs.some((tab) => tab.ownership || (tab.profileOwnership && tab.profileOwnership !== "proven"));
  const showLease = tabs.some((tab) => tab.lease?.owner);
  return tabs.map((tab) => {
    const ownership = tab.ownership || (
      tab.profileOwnership === "unproven-browser-scope" ? "unproven"
      : tab.profileOwnership === "profile-open-proven" ? "profile"
      : ""
    );
    const ownershipColumn = showOwnership ? ` ${String(ownership).slice(0, 13).padEnd(13)}` : "";
    const leaseColumn = showLease ? ` ${(tab.lease?.owner || "").slice(0, 18).padEnd(18)}` : "";
    return `${String(tab.suggestedTarget).padEnd(12)} ${tab.targetPrefix}${ownershipColumn}${leaseColumn} ${tab.title.slice(0, 40).padEnd(40)} ${tab.url}`;
  }).join("\n");
}

function formatObserve(payload, tab) {
  return [
    `target ${tab.suggestedTarget} ${payload.title || ""}`,
    payload.url,
    `ready=${payload.readyState} visibility=${payload.visibility} focus=${payload.hasFocus}`,
    payload.size?.recommendation ? `size=${payload.size.recommendation.level} reader=${payload.size.recommendation.reader}` : "",
    payload.headings?.length ? `headings: ${payload.headings.join(" | ")}` : "",
    payload.controls?.length ? `controls: ${payload.controls.slice(0, 8).map((c) => c.text || c.tag).filter(Boolean).join(" | ")}` : "",
    payload.sample,
  ].filter(Boolean).join("\n");
}

function formatQuery(payload) {
  return payload.matches.map((m) => {
    const visibility = Object.prototype.hasOwnProperty.call(m, "visible") ? (m.visible ? " visible" : " hidden") : "";
    return `${m.ref || ""} ${m.tag || ""}${m.role ? ` role=${m.role}` : ""}${visibility} ${m.text || m.href || m.src || ""}`.trim();
  }).join("\n") || "(no matches)";
}

function formatItems(payload) {
  return payload.items.map((item) => `${item.itemRef} #${item.index} ${item.text.slice(0, 240)}`).join("\n") || "(no items)";
}

function formatActionState(payload) {
  return [
    `root ${payload.root?.ref || "r1"} ${payload.root?.tag || ""}`,
    payload.controls?.map((c) => `${c.ref} ${c.tag}${c.type ? `[${c.type}]` : ""} ${c.text || ""}`).join("\n"),
    payload.finalCandidates?.length ? `final candidates: ${payload.finalCandidates.map((c) => `${c.ref}:${c.text}`).join(", ")}` : "",
    payload.screenshot ? `screenshot: ${payload.screenshot.path} ${payload.screenshot.width}x${payload.screenshot.height}` : "",
  ].filter(Boolean).join("\n");
}

function formatConsoleEntry(entry) {
  return `${entry.id} [${new Date(entry.timestamp).toISOString()}] [${entry.level}] ${entry.text}`;
}

function formatRequestLine(entry) {
  return `${entry.id} ${entry.status || "PEND"} ${entry.method || ""} ${entry.type || ""} ${entry.durationMs || "?"}ms ${entry.url || ""}`;
}

function normalizeConsoleEvent(params) {
  const id = `msg_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  return {
    id,
    timestamp: Date.now(),
    level: params.type || "log",
    text: (params.args || []).map((arg) => arg.description || arg.value || arg.unserializableValue || "").join(" "),
    url: params.stackTrace?.callFrames?.[0]?.url,
  };
}

function normalizeExceptionEvent(params) {
  const id = `msg_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  return {
    id,
    timestamp: Date.now(),
    level: "error",
    text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "exception",
    url: params.exceptionDetails?.url,
  };
}

async function resolveEndpoint(endpointOrUrl) {
  const endpoint = normalizeEndpoint(endpointOrUrl);
  // When both URLs are known, prefer a fresh HTTP /json/version discovery
  // (Playwright's connectOverCDP shape). Reasons:
  //   1. The cached wsUrl from a stale DevToolsActivePort may point to a
  //      browser instance the WS subsystem can no longer service.
  //   2. HTTP discovery fails fast (~ms) on a wedged endpoint; WS upgrade
  //      sits on the full timeout before timing out.
  //   3. /json/version returns the *current* webSocketDebuggerUrl, which
  //      survives Chrome's per-launch UUID rotation.
  // Fall back to the cached wsUrl if HTTP discovery doesn't respond.
  if (endpoint.httpUrl) {
    const fresh = await discoverBrowserWs(endpoint.httpUrl, 1500).catch(() => "");
    if (fresh) return { ...endpoint, wsUrl: fresh };
  }
  if (endpoint.wsUrl) return endpoint;
  if (!endpoint.httpUrl) throw new Error("browser URL is required");
  return { ...endpoint, wsUrl: await discoverBrowserWs(endpoint.httpUrl) };
}

async function discoverBrowserWs(httpUrl, timeoutMs = DEFAULT_TIMEOUT) {
  const version = await fetchJson(appendCdpPath(httpUrl, "/json/version"), timeoutMs);
  if (!version.webSocketDebuggerUrl) throw new Error("CDP /json/version missing webSocketDebuggerUrl");
  return normalizeWsUrl(version.webSocketDebuggerUrl, httpUrl);
}

function normalizeEndpoint(endpointOrUrl) {
  if (!endpointOrUrl) return {};
  if (typeof endpointOrUrl === "object") {
    const wsUrl = normalizeDirectWsUrl(endpointOrUrl.wsUrl || endpointOrUrl.wsEndpoint || endpointOrUrl.browserUrl);
    const httpUrl = normalizeHttpUrl(endpointOrUrl.httpUrl || endpointOrUrl.browserUrl || endpointOrUrl.wsUrl || endpointOrUrl.wsEndpoint) || httpUrlFromWs(wsUrl);
    return {
      ...endpointOrUrl,
      ...(httpUrl ? { httpUrl } : {}),
      ...(wsUrl ? { wsUrl } : {}),
    };
  }
  const value = String(endpointOrUrl).trim();
  const wsUrl = normalizeDirectWsUrl(value);
  if (wsUrl) return { wsUrl, httpUrl: httpUrlFromWs(wsUrl) };
  const httpUrl = normalizeHttpUrl(value);
  return httpUrl ? { httpUrl } : {};
}

function normalizeDirectWsUrl(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (!/^wss?:\/\//i.test(text)) return "";
  try {
    return new URL(text).toString();
  } catch {
    return "";
  }
}

function normalizeHttpUrl(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (!/^https?:\/\//i.test(text)) return "";
  try {
    const url = new URL(text);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function normalizeWsUrl(wsUrl, cdpUrl) {
  const ws = new URL(wsUrl);
  const cdp = new URL(cdpUrl);
  if (isLoopbackHost(ws.hostname) && isLoopbackHost(cdp.hostname)) ws.hostname = cdp.hostname;
  if (!ws.username && !ws.password && (cdp.username || cdp.password)) {
    ws.username = cdp.username;
    ws.password = cdp.password;
  }
  for (const [key, value] of cdp.searchParams.entries()) {
    if (!ws.searchParams.has(key)) ws.searchParams.append(key, value);
  }
  return ws.toString();
}

function appendCdpPath(base, suffix) {
  const url = new URL(base);
  url.pathname = suffix;
  return url.toString();
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"].includes(host);
}

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.json();
}

async function readCdpStream(cdp, handle, sessionId, timeoutMs = DEFAULT_TIMEOUT) {
  const chunks = [];
  let eof = false;
  while (!eof) {
    let part;
    try {
      part = await cdp.send("IO.read", { handle }, undefined, timeoutMs);
    } catch {
      part = await cdp.send("IO.read", { handle }, sessionId, timeoutMs);
    }
    chunks.push(part.base64Encoded ? Buffer.from(part.data || "", "base64").toString("utf8") : (part.data || ""));
    eof = Boolean(part.eof);
  }
  await cdp.send("IO.close", { handle }, undefined, 2000).catch(() => cdp.send("IO.close", { handle }, sessionId, 2000).catch(() => {}));
  return chunks.join("");
}

async function endpointReachable(endpoint) {
  const normalized = normalizeEndpoint(endpoint);
  const browserUrl = endpointBrowserUrl(normalized);
  if (browserUrl && await endpointPortOpen(browserUrl, 700)) return true;
  return Boolean(await discoverBrowserWs(normalized.httpUrl, 700).catch(() => ""));
}

async function endpointPortOpen(rawUrl, timeoutMs = 700) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const port = Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0) return false;
  const host = url.hostname === "0.0.0.0" ? "127.0.0.1" : url.hostname;
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function httpUrlFromWs(wsUrl) {
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function stateFileForContext(context) {
  const hash = crypto.createHash("sha256").update(daemonConnectionKey(context)).digest("hex").slice(0, 16);
  return path.join(STATE_DIR, `daemon-${hash}.json`);
}

function daemonConnectionKey(context = {}) {
  const browserUrl = contextBrowserUrl(context);
  if (browserUrl) return `browser:${browserUrl}`;
  if (context.kind === "anonymous" && context.owner && context.owner !== "global") return ownerScopedContextKey(context.key, context.owner);
  return context.key;
}

function contextBrowserUrl(context = {}) {
  if (Object.prototype.hasOwnProperty.call(context, "browserUrl")) return endpointBrowserUrl(context.browserUrl);
  return endpointBrowserUrl(context);
}

function browserEndpointsMatch(a, b) {
  const aa = normalizeEndpoint(a);
  const bb = normalizeEndpoint(b);
  if (aa.wsUrl && bb.wsUrl && aa.wsUrl === bb.wsUrl) return true;
  if (aa.httpUrl && bb.httpUrl && aa.httpUrl === bb.httpUrl) return true;
  if (aa.wsUrl && bb.httpUrl && httpUrlFromWs(aa.wsUrl) === bb.httpUrl) return true;
  if (bb.wsUrl && aa.httpUrl && httpUrlFromWs(bb.wsUrl) === aa.httpUrl) return true;
  return false;
}

function leaseTimestamp(lease = {}) {
  const timestamp = Date.parse(lease.updatedAt || lease.lastUsedAt || lease.createdAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function newestLease(leases = []) {
  return leases.filter(Boolean).sort((a, b) => leaseTimestamp(b) - leaseTimestamp(a))[0] || null;
}

function defaultStateDir() {
  if (IS_WINDOWS) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "realbrowser");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/realbrowser");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "realbrowser");
}

function parseOptionalIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseOptionalBytesEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  try {
    return parseByteSize(raw, name);
  } catch {
    return fallback;
  }
}

function result(value) {
  return { ok: true, ...value };
}

async function maybeWriteReadOut(payload, flags = {}, artifact, label, options = {}) {
  if (!flags.out) return payload;
  if (options.text) await writeTextArtifact(flags.out, String(artifact ?? ""));
  else await writeJsonFile(flags.out, artifact);
  const compact = {
    ...payload,
    text: `${label} written: ${flags.out}`,
    outPath: flags.out,
  };
  for (const key of options.omit || []) delete compact[key];
  return compact;
}

function printResult(value, flags = {}) {
  if (flags.json) {
    stdout(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  stdout(`${value.text ?? formatValue(value)}\n`);
}

function stdout(text) {
  process.stdout.write(text);
}

function formatValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function pickFields(entry, fields) {
  const names = String(fields).split(",").map((field) => field.trim()).filter(Boolean);
  if (!names.length) return entry;
  const out = {};
  for (const name of names) out[name] = entry[name];
  return out;
}

function formatJsonCompact(value) {
  return JSON.stringify(value, null, 2);
}

function compactChainResult(res) {
  return { text: res.text, target: res.target?.suggestedTarget, ok: res.ok };
}

function parseSetVariables(values = []) {
  const out = {};
  for (const raw of Array.isArray(values) ? values : [values]) {
    if (!raw) continue;
    const eq = String(raw).indexOf("=");
    if (eq < 0) throw usage(`--set requires key=value: ${raw}`);
    out[String(raw).slice(0, eq)] = String(raw).slice(eq + 1);
  }
  return out;
}

function substituteVariables(value, vars) {
  if (Array.isArray(value)) return value.map((item) => substituteVariables(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteVariables(item, vars)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][\w.]+)\}|\$([A-Za-z_][\w.]*)/g, (_match, braced, bare) => {
    const key = braced || bare;
    const replacement = valueAtPath(vars, key);
    return replacement == null ? "" : String(replacement);
  });
}

function valueAtPath(obj, dotted) {
  return String(dotted).split(".").reduce((current, key) => current == null ? undefined : current[key], obj);
}

function truncate(text, maxChars) {
  const value = String(text || "");
  return { text: value.length > maxChars ? `${value.slice(0, maxChars)}\n[...truncated ${value.length - maxChars} chars]` : value, truncated: value.length > maxChars, chars: value.length };
}

function cdpValue(remoteObject = {}) {
  if ("value" in remoteObject) return remoteObject.value;
  if ("unserializableValue" in remoteObject) return remoteObject.unserializableValue;
  if (remoteObject.objectId) return { objectId: remoteObject.objectId, description: remoteObject.description };
  return remoteObject.description;
}

function formatCdpException(details = {}) {
  return details.exception?.description || details.text || "CDP exception";
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map((id) => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len += 1) {
    const prefixes = new Set(targetIds.map((id) => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

function ambiguousTarget(raw, matches) {
  return new CliError(`ambiguous target "${raw}"\n${matches.map((tab) => `  ${tab.suggestedTarget} ${tab.title} ${tab.url}`).join("\n")}`, {
    code: "target_ambiguous",
    exitCode: 3,
  });
}

function sameUrl(a, b) {
  try {
    const aa = new URL(a);
    const bb = new URL(b);
    aa.hash = "";
    bb.hash = "";
    return aa.toString().replace(/\/$/, "") === bb.toString().replace(/\/$/, "");
  } catch {
    return a === b;
  }
}

function assertNavigationUrl(raw, force = false) {
  let url;
  try { url = new URL(raw); } catch { throw usage(`invalid URL: ${raw}`); }
  if (url.username || url.password) throw usage("credential-bearing URLs are rejected");
  if (isMetadataHost(url.hostname) && !force) {
    throw new CliError(`blocked cloud metadata endpoint: ${url.hostname}`, {
      code: "url_metadata_guard",
      exitCode: 2,
      next: ["use --force only when you intentionally need this local/metadata URL"],
    });
  }
  if (!["http:", "https:", "about:"].includes(url.protocol) && !force) {
    throw new CliError(`URL scheme requires --force: ${url.protocol}`, { code: "url_scheme_guard", exitCode: 2 });
  }
}

function isMetadataHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "169.254.169.254" ||
    host.startsWith("169.254.") ||
    host === "metadata.google.internal" ||
    host === "metadata.azure.internal" ||
    host === "metadata" ||
    host.startsWith("fd00:");
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function normalizeDefaultContexts(raw) {
  if (raw?.version === 2 && raw.owners && typeof raw.owners === "object") return raw;
  const owners = {};
  if (raw?.flags || raw?.context) {
    owners.default = {
      owner: "default",
      context: raw.context || "",
      flags: raw.flags || {},
      setAt: raw.setAt || "",
      migratedFromGlobal: true,
    };
  }
  return { version: 2, owners };
}

function defaultContextsByOwner() {
  return normalizeDefaultContexts(readJson(DEFAULT_CONTEXT_FILE)).owners || {};
}

function defaultContextEntryForOwner(owner) {
  const normalizedOwner = normalizeOwner(owner) || "default";
  const data = normalizeDefaultContexts(readJson(DEFAULT_CONTEXT_FILE));
  const owners = data.owners || {};
  return owners[normalizedOwner] || (owners.default?.migratedFromGlobal ? owners.default : null);
}

async function setDefaultContextForOwner(owner, context, flags) {
  const normalizedOwner = normalizeOwner(owner) || "default";
  const data = await updateJsonFile(DEFAULT_CONTEXT_FILE, { version: 2, owners: {} }, (current) => {
    const normalized = normalizeDefaultContexts(current);
    normalized.owners[normalizedOwner] = {
      owner: normalizedOwner,
      context,
      flags: { ...flags, owner: normalizedOwner },
      setAt: new Date().toISOString(),
    };
    return normalized;
  });
  return data.owners[normalizedOwner];
}

async function clearDefaultContextForOwner(owner) {
  const normalizedOwner = normalizeOwner(owner) || "default";
  await updateJsonFile(DEFAULT_CONTEXT_FILE, { version: 2, owners: {} }, (current) => {
    const normalized = normalizeDefaultContexts(current);
    delete normalized.owners[normalizedOwner];
    return normalized;
  });
}

async function writeJsonFile(file, value) {
  const resolved = path.resolve(expandHome(file));
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, resolved);
}

async function updateJsonFile(file, fallback, updater) {
  const resolved = path.resolve(expandHome(file));
  await fsp.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  return await withJsonFileLock(resolved, async () => {
    const current = readJson(resolved) ?? structuredCloneCompat(fallback);
    const next = await updater(current);
    await writeJsonFile(resolved, next);
    return next;
  });
}

async function withJsonFileLock(file, fn) {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await fsp.mkdir(lockDir, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fsp.stat(lockDir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new CliError(`timed out waiting for state lock: ${lockDir}`, {
          code: "state_lock_timeout",
          exitCode: 6,
        });
      }
      await sleep(25 + Math.floor(Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

function structuredCloneCompat(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

async function writeTextArtifact(file, value) {
  const resolved = path.resolve(expandHome(file));
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, String(value), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, resolved);
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpRequest({ method, url, headers = {}, body = "", timeoutMs = DEFAULT_TIMEOUT }) {
  return await new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data }));
    });
    req.on("timeout", () => {
      req.destroy(new Error(`HTTP timeout: ${url}`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function listenLoopback(server) {
  return await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function findFreePort() {
  const server = http.createServer((_, res) => res.end("ok"));
  const port = await listenLoopback(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listFiles(dir) {
  try {
    return (await fsp.readdir(dir)).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function waitForNewDownload(dir, before, timeoutMs) {
  const beforeSet = new Set(before);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await listFiles(dir);
    const candidates = files.filter((file) => !beforeSet.has(file) && !/\.(crdownload|download|part)$/i.test(file));
    if (candidates.length) {
      const newest = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      const size1 = fs.statSync(newest).size;
      await sleep(300);
      const size2 = fs.statSync(newest).size;
      if (size1 === size2) return newest;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for download in ${dir}`);
}

async function imageDimensions(file) {
  const fd = await fsp.open(file, "r");
  try {
    const stat = await fd.stat();
    const buf = Buffer.alloc(Math.min(256 * 1024, stat.size));
    await fd.read(buf, 0, buf.length, 0);
    return imageDimensionsFromBuffer(buf) || {};
  } finally {
    await fd.close();
  }
}

function imageDimensionsFromBuffer(buf) {
  if (!buf || buf.length < 10) return {};
  const png = pngDimensionsFromBuffer(buf);
  if (png) return png;
  const jpeg = jpegDimensionsFromBuffer(buf);
  if (jpeg) return jpeg;
  const webp = webpDimensionsFromBuffer(buf);
  if (webp) return webp;
  return {};
}

function pngDimensionsFromBuffer(buf) {
  if (buf.length < 24) return null;
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[4] !== 0x0d ||
    buf[5] !== 0x0a ||
    buf[6] !== 0x1a ||
    buf[7] !== 0x0a ||
    buf.toString("ascii", 12, 16) !== "IHDR"
  ) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensionsFromBuffer(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buf.length) return null;
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker));
    if (isSof && length >= 7) {
      return { width: buf.readUInt16BE(offset + 5), height: buf.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpDimensionsFromBuffer(buf) {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buf.length >= 30) {
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function ariaRefKind(role) {
  if (role === "link") return "l";
  if (/^(button|menuitem|menuitemcheckbox|menuitemradio|tab|switch)$/.test(role)) return "b";
  return "e";
}

function formatAxTreeV2(nodes, opts = {}) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  for (const node of nodes) {
    node._children = (node.childIds || []).map((id) => byId.get(id)).filter(Boolean);
  }
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const lines = [];
  const interactiveNodes = [];
  const visited = new Set();
  const maxLines = Number(opts.limit || 800);
  const maxDepth = Number(opts.depth || 50);
  let truncated = false;
  const SKIP_ROLES = new Set(["none", "generic", "presentation", "InlineTextBox", "LineBreak"]);
  function getProp(node, name) { return node.properties?.find((p) => p.name === name)?.value?.value; }
  function isInteractive(role) { return INTERACTIVE_ROLES.has(role); }
  function isContent(role) { return CONTENT_ROLES.has(role); }
  function isStructural(role) { return STRUCTURAL_ROLES.has(role); }
  function isLandmark(role) { return ALWAYS_LANDMARK_ROLES.has(role); }
  // Pre-pass: mark each node with whether it has an interactive descendant.
  // This lets landmark/content roles render in --interactive mode only when
  // they scope something interactive — preserving "where am I" hierarchy
  // without cluttering empty containers (matches openclaw's compactTree
  // post-pass which drops parents whose subtree has no [ref=] descendants).
  function markDescendants(node) {
    if (node._descendantMarked) return Boolean(node._hasInteractiveDescendant);
    node._descendantMarked = true;
    let has = false;
    for (const child of node._children || []) {
      const childRole = child.role?.value || "";
      if (isInteractive(childRole)) has = true;
      if (markDescendants(child)) has = true;
    }
    node._hasInteractiveDescendant = has;
    return has;
  }
  for (const root of roots) markDescendants(root);
  function shouldShow(node) {
    if (node.ignored) return false;
    const role = node.role?.value || "";
    if (!role || SKIP_ROLES.has(role)) return false;
    const name = node.name?.value || "";
    const value = node.value?.value;
    if (opts.interactive) {
      // Always show interactive elements.
      if (isInteractive(role)) return true;
      // Hierarchy preservation (deviates from openclaw's flat interactive mode):
      // keep landmark + named content roles when they scope at least one
      // interactive node. Empty/unnamed structural containers are still hidden.
      if (!node._hasInteractiveDescendant) return false;
      if (isLandmark(role)) return true;
      if (isContent(role)) {
        // Named content (region "Search", heading "Title") always shown;
        // unnamed `main`/`navigation`/`heading` shown as primary landmarks.
        if (name) return true;
        if (role === "main" || role === "navigation" || role === "heading") return true;
      }
      return false;
    }
    // Non-interactive modes follow openclaw's processLine semantics:
    // - compact: skip unnamed structural roles (group/list/table/tablist/...)
    // - default: render everything except SKIP_ROLES
    if (opts.compact && isStructural(role) && !name && value == null) return false;
    return true;
  }
  function stateAttrs(node) {
    const attrs = [];
    for (const prop of node.properties || []) {
      const v = prop.value?.value;
      if (prop.name === "disabled" && v) attrs.push("[disabled]");
      if (prop.name === "checked" && v != null) attrs.push(`[checked=${v}]`);
      if (prop.name === "expanded" && v != null) attrs.push(`[expanded=${v}]`);
      if (prop.name === "pressed" && v != null) attrs.push(`[pressed=${v}]`);
      if (prop.name === "selected" && v) attrs.push("[selected]");
      if (prop.name === "required" && v) attrs.push("[required]");
      if (prop.name === "readonly" && v) attrs.push("[readonly]");
      if (prop.name === "level" && v != null) attrs.push(`[level=${v}]`);
      if (prop.name === "focused" && v) attrs.push("[focused]");
      if (prop.name === "modal" && v) attrs.push("[modal]");
    }
    return attrs.join(" ");
  }
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (lines.length >= maxLines) { truncated = true; return; }
    const show = shouldShow(node);
    if (show && depth <= maxDepth) {
      const role = node.role?.value || "";
      const name = node.name?.value;
      const value = node.value?.value;
      const nameStr = name ? ` "${name.length > 120 ? name.slice(0, 117) + "..." : name}"` : "";
      const valueStr = value != null ? ` value="${String(value).slice(0, 80)}"` : "";
      const attrs = stateAttrs(node);
      const focusable = getProp(node, "focusable");
      const isInt = isInteractive(role);
      const refPrefix = isInt || focusable ? `${ariaRefKind(role)}? ` : "";
      lines.push(`${"  ".repeat(Math.min(depth, 10))}- ${refPrefix}${role}${nameStr}${attrs ? " " + attrs : ""}${valueStr}`);
      if ((isInt || focusable) && node.backendDOMNodeId) {
        const idx = interactiveNodes.length;
        interactiveNodes.push({ role, name: name || "", backendDOMNodeId: node.backendDOMNodeId });
        lines[lines.length - 1] = lines[lines.length - 1].replace(/^(\s*- )[ebl]\? /, `$1REF${idx} `);
      } else {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/[ebl]\? /, "");
      }
    }
    for (const child of node._children || []) {
      visit(child, show && depth <= maxDepth ? depth + 1 : depth);
    }
  }
  for (const root of roots) visit(root, 0);
  const text = lines.length ? finalizeAriaRefs(lines, interactiveNodes) : "(empty tree)";
  return { text, interactiveNodes, lines: lines.length, truncated };
}

function finalizeAriaRefs(lines, interactiveNodes) {
  const counters = {};
  const text = lines.map((line) => {
    const match = line.match(/^(\s*- )REF(\d+) /);
    if (!match) return line;
    const node = interactiveNodes[Number(match[2])];
    const kind = ariaRefKind(node.role);
    counters[kind] = (counters[kind] || 0) + 1;
    const ref = `${kind}${counters[kind]}`;
    node.ref = ref;
    return line.replace(`REF${match[2]} `, `${ref} `);
  }).join("\n");
  return text;
}

// detectRecentSearchHint scans cursor-clickable lines for booking-style
// "saved/recent search" bubbles — items whose label looks like a saved
// search row (city codes + dates). When 2+ near-duplicate bubbles match,
// return a short HINT line that tells agents these are click-once
// shortcuts that pre-fill the form (skipping airport/date pickers).
// Generic — matches 3-letter code pairs + date tokens. False-positive
// cost is one extra HINT line. Pattern intentionally broad: any "FOO BAR
// <date>" string (codes + date) signals a recent-action chip on
// homepage. Localized date words (en/vi/de/fr/es month names) handled
// by the date regex.
function detectRecentSearchHint(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return "";
  const matches = [];
  // Heuristic: line text matches CODE-CODE + date pattern, or repeats a
  // 3-letter code twice with a date-ish token between/after.
  // Examples that should match:
  //   - "ABC XYZ 10 month-name 2026 12 month-name 2026"
  //   - "From CityName to CityName Mar 5"
  //   - "ABC -> XYZ 2026-05-10"
  // Examples that should NOT match: navigation links, single buttons.
  const cityPair = /\b[A-Z]{3}\b[^A-Za-z]+\b[A-Z]{3}\b/;
  const dateLike = /\b(\d{1,2})\b.{0,4}\b(thg|th|month|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|\d{4})\b/i;
  const isoDate = /\b\d{4}-\d{2}-\d{2}\b/;
  for (const line of lines) {
    const text = line.replace(/^[-\s]*c\d+\s+\S+\s+"/, "").replace(/"\s*\[[^\]]+\]\s*$/, "");
    if (!text || text.length < 8) continue;
    if (cityPair.test(text) && (dateLike.test(text) || isoDate.test(text))) matches.push(line);
  }
  if (matches.length < 2) return "";
  const refs = matches.slice(0, 5).map((l) => (l.match(/\b(c\d+)\b/) || [])[1]).filter(Boolean);
  if (refs.length < 2) return "";
  return `# HINT: ${refs.length} recent-action chips detected (${refs.slice(0, 3).join(", ")}${refs.length > 3 ? ", ..." : ""}). On form-driven SPAs, one click on the matching chip pre-fills the form and skips the picker UI entirely. Match by the user's intent (codes + dates) in the label.`;
}

function stripUnstampedRefs(text, refs) {
  const stamped = new Set(Object.keys(refs));
  return text.split("\n").map((line) => {
    const m = line.match(/^(\s*- )([blec])(\d+) /);
    if (!m) return line;
    const refName = `${m[2]}${m[3]}`;
    if (stamped.has(refName)) return line;
    return line.replace(/^(\s*- )([blec])\d+ /, "$1");
  }).join("\n");
}

function lineDiff(before, after, contextLines = 2) {
  if (!before) return `${after}\n\n(no previous snapshot to diff against)`;
  if (before === after) return "(no changes)";
  const a = before.split("\n");
  const b = after.split("\n");
  let prefixLen = 0;
  while (prefixLen < a.length && prefixLen < b.length && a[prefixLen] === b[prefixLen]) prefixLen++;
  let suffixLen = 0;
  while (suffixLen < a.length - prefixLen && suffixLen < b.length - prefixLen && a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]) suffixLen++;
  const aSlice = a.slice(prefixLen, a.length - suffixLen);
  const bSlice = b.slice(prefixLen, b.length - suffixLen);
  const m = aSlice.length;
  const n = bSlice.length;
  if (m === 0 && n === 0) return "(no changes)";
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = aSlice[i - 1] === bSlice[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aSlice[i - 1] === bSlice[j - 1]) {
      ops.push({ type: " ", line: aSlice[i - 1], aIdx: prefixLen + i - 1, bIdx: prefixLen + j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "+", line: bSlice[j - 1], bIdx: prefixLen + j - 1 });
      j--;
    } else {
      ops.push({ type: "-", line: aSlice[i - 1], aIdx: prefixLen + i - 1 });
      i--;
    }
  }
  ops.reverse();
  const changed = new Set();
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== " ") {
      for (let c = Math.max(0, k - contextLines); c <= Math.min(ops.length - 1, k + contextLines); c++) changed.add(c);
    }
  }
  const out = ["--- previous snapshot", "+++ current snapshot"];
  let inHunk = false;
  for (let k = 0; k < ops.length; k++) {
    if (changed.has(k)) {
      if (!inHunk) { out.push(""); inHunk = true; }
      out.push(`${ops[k].type} ${ops[k].line}`);
    } else {
      if (inHunk) { out.push("  ..."); inHunk = false; }
    }
  }
  return out.join("\n");
}

function redacted(value) {
  return String(value || "").replace(/(token|key|secret|password|authorization|cookie)=([^&\s]+)/ig, "$1=[redacted]");
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    return url.toString();
  } catch {
    return redacted(value);
  }
}

function usage(message, next = []) {
  return new CliError(message, { code: "usage", exitCode: 2, next });
}

function printHelp(argv = []) {
  const group = argv[0] === "help" ? argv[1] : argv[0];
  const command = argv[0] === "help" ? argv[2] : argv[1];
  const topic = command && !String(command).startsWith("-") ? `${group} ${command}` : group;
  const text = HELP[topic] || HELP[group] || HELP._;
  stdout(`${text.trim()}\n`);
}

const HELP = {
  _: `
realbrowser

Usage:
  realbrowser [global flags] <group> <command> [args] [flags]
  realbrowser help <group>

Target-first model:
  profile/session/anonymous choose the allowed browser context.
  --anonymous means isolated temporary browser state; add --incognito for
  Chrome's visual private window on an anonymous managed session.
  tab ensure/select/new returns a stable suggested target.
  every read/action/debug command requires -t/--target or --handle.
  action upload and submit default to the active root.
  large outputs go to --out; --json is valid JSON for jq.
  reusable flows use generic roots/refs/roles and observed labels, not site copy.
  with --profile and browser-scoped CDP, existing tabs are unproven; create a
  new tab through the profile instead of selecting a related tab from another profile.

Common:
  realbrowser profile list --active
  realbrowser tab list app.example --profile chrome:Default
  realbrowser tab ensure https://example.com --profile chrome:Default --label app --background
  realbrowser tab ensure https://example.com --anonymous --session check --label page
  realbrowser tab ensure https://example.com --anonymous --session private --label page --front --incognito
  realbrowser read observe -t app
  realbrowser read size -t app --json
  realbrowser read item -t group --collection auto --direct-children --index 4
  realbrowser action state -t app --root active --compact --screenshot --annotate-refs
  realbrowser action upload -t app --root active --input-ref e2 ~/Downloads/file.png
  realbrowser action upload -t app --root active --trigger-ref b7 ~/Downloads/file.png
  realbrowser action submit -t app --root active --text "Submit"
  realbrowser console list -t app --errors --limit 50
  realbrowser network capture -t app --reload --duration 5000 --out tmp/network.json
  realbrowser screenshot device -t page --anonymous --session check --devices desktop:1440x900,tablet:768x1024,mobile:390x844 --settle-ms 300 tmp/page
  realbrowser export pdf -t app tmp/page.pdf --print-background

Global flags:
  --owner <id> scopes labels, default context, and leases to a Codex/project owner
  --take-lease intentionally takes a target leased by another owner
  --global uses the shared global owner namespace intentionally

Groups:
  profile session daemon tab handle read wait action screenshot console network state dialog perf download export devtools chain completion self-test
`,
  profile: `
realbrowser profile

  profile list [query] [--active] [--json]
  profile inspect <profile>
  profile relaunch <profile> --confirm [--front]

Use profile list --active before signed-in/current-state work. JSON includes
cdpScope so agents can distinguish profile-scoped and browser-scoped endpoints.
Profile listing is passive: it reads DevToolsActivePort and loopback readiness,
but does not open CDP WebSockets or trigger Chrome Allow prompts.
relaunch is last-resort and approval-gated: ask the user first because it quits
the browser app for that user data directory, then starts it with remote
debugging enabled.
`,
  daemon: `
realbrowser daemon

  daemon status [--json]
  daemon doctor [--json]
  daemon monitor [--json]
  daemon restart
  daemon stop

monitor reports CDP health, target counts, sessions, and buffer sizes without
dumping page content. If Chrome is waiting for Allow debugging, retrying should
wait for the same starting daemon instead of spawning another controller.
`,
  tab: `
realbrowser tab

  tab list [query] [--mine] [--profile P|--anonymous --session S|--browser-url URL]
  tab select <query|target> [--label L] [--front]
  tab ensure <url> --label L [--background|--front|--best-effort-background] [--incognito] [--force-new]
  tab new <url> [--label L]
  tab navigate <target> <url|link-ref> [--allow-user-tab-mutation]
  tab label <target> <label>
  tab focus|handoff|resume <target>
  tab close <target> [--mine]
  tab done [--task ID] [--close]

Labels are owner-scoped. Each invocation has a task; the per-task tab registry
prevents duplicate same-origin tabs. tab list --mine shows only this task's
agent-owned tabs. Mutating commands (navigate, close) refuse user-owned tabs
unless --take-lease, --force, or --allow-user-tab-mutation is explicit.
If tab ensure errors with duplicate_task_origin, USE the existing handle —
the error gives you the exact next command verbatim.
`,
  "tab ensure": `
realbrowser tab ensure <url>

Creates or reuses a stable target in the selected context.

  tab ensure https://example.com --anonymous --session check --label page --background
  tab ensure https://example.com --anonymous --session private --label page --front --incognito
  tab ensure https://example.com --profile chrome:Default --label app --background

Safe rule: --background only uses background-safe browser/CDP paths. Running
browser-scoped profiles are never OS-launched in background; use --front for
explicit visual handoff.
--anonymous uses an isolated temporary Chrome profile. --incognito/--private
adds Chrome's visual private window and is supported only with anonymous managed
sessions, not signed-in profiles or arbitrary CDP endpoints.
Browser-scoped profile tabs from tab list are diagnostic only unless they were
created by realbrowser through that profile; do not select/navigate them for a
named-profile open without --allow-browser-scope-target.
`,
  session: `
realbrowser session

  session list
  session use <anonymous:name|session:name|profile:chrome:Default|endpoint:http://127.0.0.1:9222> [--owner id]
  session clear [--owner id|--all]
  session stop [query] [--owner id|--all]

session use sets an owner-scoped default context only; target-changing/read/action
commands still require a target label, target id, or handle.
`,
  handle: `
realbrowser handle

  handle create <target> [--name app] [--handle-out tmp/app.handle]
  handle list
  handle release <name|path>

Handles persist a target reference for scripts while preserving target safety.
`,
  read: `
realbrowser read

All read commands require -t/--target or --handle.

  read observe -t app
  read size -t app --json
  read tree -t app --interactive --compact --diff
  read tree -t app --selector main --depth 4
  read tree -t app -i -c -D
  read query -t app "button,input" --limit 20 --json
  read items -t app --root "[role=feed]" --direct-children --limit 8
  read item -t app --collection auto --direct-children --index 4 --max-text-chars 4000
  read snapshot -t app --selector main --compact --urls
  read snapshot -t app --interactive --cursor-interactive --diff
  read query -t app "button,input" --limit 100 --out tmp/controls.json
  read text -t app --max-chars 50000 --out tmp/page-text.txt
  read text|html|links|forms|url|is -t app ...
  read autocomplete -t app                  (after typing into a focused input;
                                             enumerates the floating layer's
                                             items as o1, o2, ... refs)
  read autocomplete -t app --near b21       (anchor at the button you just
                                             clicked; preferred for
                                             click-then-popup widgets where
                                             activeElement is unreliable)

read query expects CSS selectors, not literal text. For text checks, use
wait text, read text --out plus rg, or read query '<css>' --text-filter '<text>'.
Use --out for large/debug reads. Text-like reads write plain text; structured
reads write JSON for jq/rg/editor inspection.

read autocomplete (alias: read overlay) finds the floating layer near the
input or button you specify (--near <ref>) or near document.activeElement
and emits o1, o2, ... refs for its visible items. Eligibility rules: layer
must be >= 150x80 OR contain >= 3 list-like items (li, [role=option],
[role=menuitem], etc.). Use after action type or after a click that opens a
custom dropdown. Then action click <ref> works without selector hunting.
If the result reports "no eligible layer near anchor", the dropdown likely
closed — re-click the field, then retry with --near <field-ref>.
`,
  wait: `
realbrowser wait

  wait ready -t app [--timeout 10000]
  wait ready -t app --visual-stable --screenshot --out tmp/ready.png
  wait selector -t app "button[type=submit]"
  wait text -t app "Saved"
  wait url -t app --contains "/done"
  wait load -t app [complete|domcontentloaded]
  wait network -t app [--timeout 5000]

wait ready --screenshot is a visible checkpoint, not a full-page capture.
`,
  action: `
realbrowser action

All actions require -t/--target or --handle.

  action state -t app --root active --compact
  action state -t app --root active --compact --screenshot --annotate-refs
  action click -t app b1
  action fill -t app e1 "hello"
  action type -t app e1 "hello"
  action type -t app --stdin
  action press -t app Escape
  action drag -t app b1 --to b2
  action drag -t app b1 --to-point 320,180
  action drag -t app --from-point 20,40 --to-point 300,40
  action drag -t app b1 --by 80,0 --steps 16 --duration 400
  action upload -t app --root active --input-ref e2 ~/Downloads/file.png
  action upload -t app --root active --trigger-ref b7 ~/Downloads/file.png
  action submit -t app --root active --text "Submit"
  action submit -t app b4

  Plain click blocks actual file inputs/labels and protocol-detected file chooser
  openings. Use upload --trigger-ref for visible picker buttons, or pass
  --allow-file-dialog when a native picker is intentional.

  action scroll -t app down 500
  action scroll -t app up 300
  action scroll -t app --selector '[data-scroll-root]' down 800
  action scroll -t app e1 down 400

  Scroll scrolls the window or a specific element. Directions: up/down/left/right.
  Default: down 500. Use --selector or a ref to scroll a container.

  Drag performs a pointer drag and drops by releasing at the destination. Sources
  and destinations are viewport CSS pixels or current refs/selectors. Use
  --to <ref|selector>, --to-point <x,y>, or --by <dx,dy>. Options:
  --steps <n>, --duration <ms>, --hold <ms>, --button left|middle|right.

  action state --screenshot captures the visible active root/viewport. Use
  screenshot area/full only when a tall artifact is explicitly needed.

  Submit labels are exact observed root labels. Use action state first and submit
  by ref when labels are ambiguous or localized.
`,
  console: `
realbrowser console

  console list -t app [--errors] [--limit 80] [--json]
  console get -t app c1
  console capture -t app [--clear] [--reload] [--duration 3000] [--out tmp/console.json]
  console clear -t app

For copy-console tasks, select and verify one exact tab first, then paste the
DevTools-style lines verbatim. Use capture --reload when startup logs are
expected and preserved buffers are empty.
`,
  network: `
realbrowser network

  network list -t app [--failed] [--filter /api/] [--limit 50] [--json]
  network get -t app req_12 --out tmp/req.json
  network body -t app req_12 --response --out tmp/body.json --full
  network capture -t app --reload --duration 5000 --out tmp/network.json
  network capture -t app --include-body --out tmp/network-with-bodies.json
  network export -t app --format har --out tmp/network.har

network capture --include-body requires --out unless --force is explicit.
`,
  state: `
realbrowser state

  state cookies -t app [--values]
  state storage -t app [get|set|clear] [local|session] [key] [value]
  state headers set -t app --header "X-Debug: 1"
  state headers clear -t app
  state permissions grant -t app clipboardReadWrite --origin https://example.com --force
  state permissions reset -t app --force
  state clipboard read -t app --values
  state clipboard write -t app --stdin
  state emulate -t app --cpu 4 --network slow-3g --timezone UTC --locale en-US
  state emulate -t app reset

Permission grant/reset uses browser-wide Chrome APIs and requires --force.
`,
  screenshot: `
realbrowser screenshot

  screenshot capture -t app out.png
  screenshot capture -t app out.jpg --max-side 1600 --max-bytes 2mb
  screenshot capture -t app --raw-size out.png
  screenshot capture -t app --selector '[role=dialog]' out.png
  screenshot full -t app out.png
  screenshot full -t app --selector '[data-scroll-root]' out/panel-full.png
  screenshot area -t app b2 out/button.png --annotate-refs
  screenshot area -t app --selector main out.png
  screenshot device -t page --anonymous --session responsive --devices desktop:1440x900,tablet:768x1024,mobile:390x844 --visual-stable --settle-ms 300 out/page

  Use capture/area for live signed-in tabs. Use device for explicit responsive
  viewport evidence, preferably on anonymous or disposable targets. action
  state and wait ready screenshots are visible checkpoints; area/full are the
  explicit tall-artifact commands. Default screenshots are normalized for agent
  use: JPEG quality 85, max side 2000px, max bytes 5mb. Use --raw-size or
  --format png when exact browser pixels are required. --annotate-refs draws
  the active root plus visible refs; use --max-labels to bound overlay density.
  Device screenshots use DPR 1 by default, so mobile:390x844 writes 390x844.
  screenshot full stitches a dominant internal scroll container when the
  document itself is fixed-height; pass --selector when the target panel is
  already known.
`,
  dialog: `
realbrowser dialog

  dialog list -t app
  dialog arm -t app [accept|dismiss]
  dialog accept -t app [text]
  dialog dismiss -t app
`,
  perf: `
realbrowser perf

  perf timing -t app
  perf vitals -t app
  perf trace -t app start
  perf trace -t app stop --out tmp/trace.json
`,
  download: `
realbrowser download

  download click -t app <ref> [--dir ~/Downloads] [--out ~/Downloads/file.ext]
  download wait -t app [--dir ~/Downloads] [--timeout 30000]
`,
  export: `
realbrowser export

  export pdf -t app tmp/page.pdf --print-background
`,
  devtools: `
realbrowser devtools

  devtools list -t app
  devtools raw -t app <CDP.method> [--params '{"key":"value"}']

Use raw only for explicit debugging when a first-class command is missing.
`,
  chain: `
realbrowser chain

  chain -t app '[["read","observe"],["read","query","button"]]'
  chain -t app --from flow.json --return summary
  chain -t app --from - --return summary < flow.json
  chain --profile chrome:Default --foreach groups.json --var group --set media=~/Downloads/post.png --from flow.json

Steps are JSON arrays matching normal CLI tokens. A target declared on the
chain is injected into target-required steps that do not specify their own.
--foreach substitutes $group.field, $index, and --set key=value variables.
The chain runs inside one browser context; put --profile/--anonymous/--browser-url
on the chain command, not inside individual steps.
`,
};

function completionScript(shell) {
  const words = Object.keys(GROUPS).concat(["completion", "self-test", "help"]).join(" ");
  if (shell === "fish") return words.split(" ").map((word) => `complete -c realbrowser -f -a ${word}`).join("\n") + "\n";
  if (shell === "powershell") return `Register-ArgumentCompleter -Native -CommandName realbrowser -ScriptBlock { param($wordToComplete) "${words}".Split(" ") | Where-Object { $_ -like "$wordToComplete*" } }\n`;
  return `_realbrowser_complete() { COMPREPLY=( $(compgen -W "${words}" -- "$\{COMP_WORDS[COMP_CWORD]}") ); }\ncomplete -F _realbrowser_complete realbrowser\n`;
}

async function runSelfTest() {
  await ensureBaseDirs();
  const parsed = parseCli(["tab", "ensure", "https://example.com", "--label", "app", "--anonymous", "--session", "st"]);
  assert(parsed.group === "tab" && parsed.command === "ensure", "parser tab ensure");
  const read = parseCli(["read", "observe", "-t", "app", "--json"]);
  assert(read.flags.target === "app" && read.flags.json === true, "target/json parser");
  const ctx = parseCli(["tab", "list", "--context", "profile:chrome:Default"]);
  assert(ctx.flags.context === "profile:chrome:Default", "context flag parser");
  assert(contextFlagsFromString("profile:chrome:Default").profile === "chrome:Default", "profile context parser");
  assert(contextFlagsFromString("session:check").anonymous === true, "session context parser");
  assert(endpointBrowserUrl({ httpUrl: "http://127.0.0.1:9222", wsUrl: "ws://127.0.0.1:9222/devtools/browser/mock" }) === "ws://127.0.0.1:9222/devtools/browser/mock", "direct WS endpoint is preferred over HTTP discovery root");
  assert(browserEndpointsMatch("http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser/mock"), "HTTP and direct WS endpoints match by origin");
  assert(daemonReadyForContext({ ok: true, cdpReady: true, browserUrl: "ws://127.0.0.1:9222/devtools/browser/mock" }, { browserUrl: "http://127.0.0.1:9222" }), "ready daemon health matches endpoint context");
  assert(!daemonReadyForContext({ ok: true, cdpReady: false, browserUrl: "ws://127.0.0.1:9222/devtools/browser/mock" }, { browserUrl: "http://127.0.0.1:9222" }), "daemon health rejects closed CDP socket");
  assert(!daemonReadyForContext({ ok: true, cdpReady: true, browserUrl: "ws://127.0.0.1:9223/devtools/browser/mock" }, { browserUrl: "http://127.0.0.1:9222" }), "daemon health rejects mismatched endpoint context");
  assert(daemonConnectionKey({ key: "profile:chrome:Default", browserUrl: "ws://127.0.0.1:9222/devtools/browser/mock" }) === daemonConnectionKey({ key: "profile:chrome:Profile 1", browserUrl: "ws://127.0.0.1:9222/devtools/browser/mock" }), "same browser endpoint shares one daemon across profile contexts");
  const relaunch = parseCli(["profile", "relaunch", "chrome:Default", "--confirm"]);
  assert(relaunch.group === "profile" && relaunch.command === "relaunch" && relaunch.flags.confirm === true, "profile relaunch parser");
  const allowBrowserScope = parseCli(["tab", "select", "ABCDEF12", "--profile", "chrome:Default", "--allow-browser-scope-target"]);
  assert(allowBrowserScope.flags.allowBrowserScopeTarget === true, "browser-scope target override parser");
  const ownerParsed = parseCli(["tab", "ensure", "https://example.com", "--anonymous", "--session", "st", "--owner", "owner-a"]);
  assert(ownerParsed.flags.owner === "owner-a", "owner parser");
  const ownerContext = await resolveContext({ ...ownerParsed.flags }, ownerParsed);
  assert(ownerContext.owner === "owner-a" && ownerContext.key === "anonymous:st", "owner anonymous context");
  assert(daemonConnectionKey(ownerContext).includes(`${OWNER_SCOPE_SEPARATOR}owner-a`), "anonymous daemon key is owner scoped");
  const incognito = parseCli(["tab", "ensure", "https://example.com", "--label", "page", "--anonymous", "--session", "private", "--front", "--incognito"]);
  assert(incognito.flags.anonymous === true && incognito.flags.incognito === true, "incognito parser");
  const privateContext = contextFlagsFromString("private:check");
  assert(privateContext.anonymous === true && privateContext.incognito === true && privateContext.session === "check", "private context parser");
  const incognitoContext = await resolveContext({ ...incognito.flags }, incognito);
  assert(incognitoContext.key === "anonymous-incognito:private" && incognitoContext.headless === false && incognitoContext.incognito === true, "incognito anonymous context");
  const headers = parseCli(["state", "headers", "set", "-t", "app", "--header", "X-A: 1", "--header", "X-B: 2"]);
  assert(headers.flags.header.length === 2, "repeated header parser");
  const inlineChain = parseCli(["chain", "[[\"read\",\"observe\"]]", "-t", "app"]);
  assert(inlineChain.command === "run" && inlineChain.args[0].startsWith("[["), "inline chain parser");
  assertThrows(() => parseCli(["read", "observe", "--bad"]), "unknown flags rejected");
  assertThrows(() => assertNavigationUrl("http://169.254.169.254/latest/meta-data"), "metadata URL guard");
  assert(getDisplayPrefixLength(["AAAAAAAA1111", "AAAAAAAB2222"]) === 8, "unique prefix length");
  const buf = new CircularBuffer(2);
  buf.push(1); buf.push(2); buf.push(3);
  assert(JSON.stringify(buf.toArray()) === "[2,3]", "circular buffer overwrites oldest");
  assert(actionOptions([], {}).activeRoot === true, "actions default to active root");
  assert(actionOptions([], { root: "page" }).activeRoot === false, "explicit page root is honored");
  assert(screenshotCommandMutates("device", {}) && screenshotCommandMutates("capture", { full: true }) && screenshotCommandMutates("capture", { annotateRefs: true }) && !screenshotCommandMutates("capture", {}), "screenshot mutation classifier");
  assert(rawCdpMethodMutates("Runtime.evaluate") && rawCdpMethodMutates("Page.reload") && !rawCdpMethodMutates("DOM.getDocument"), "raw CDP mutation classifier");
  const fakeDaemon = Object.create(BrowserDaemon.prototype);
  fakeDaemon.context = { kind: "profile", key: "profile:chrome:Default", profile: { id: "chrome:Default" }, endpointScope: "browser" };
  fakeDaemon.labels = { "profile:chrome:Default": { app: "target-1" } };
  fakeDaemon.labelMeta = { "profile:chrome:Default": { app: { targetId: "target-1", profileOwned: true, profile: "chrome:Default", source: "profile-open" } } };
  fakeDaemon.targetMeta = { "profile:chrome:Default": { "target-3": { targetId: "target-3", profileOwned: true, profile: "chrome:Default", source: "profile-open" } } };
  fakeDaemon.leases = {};
  fakeDaemon.sessionRegistry = {};
  assert(fakeDaemon.profileTargetProven({ targetId: "target-1", label: "app" }) === true, "profile-open label proves browser-scoped target");
  assert(fakeDaemon.profileTargetProven({ targetId: "target-2", label: "other" }) === false, "browser-scoped profile target is unproven by default");
  assert(fakeDaemon.profileTargetProven({ targetId: "target-3" }) === true, "profile-open target provenance works without a label");
  fakeDaemon.tabs = async () => [
    { targetId: "target-2", targetPrefix: "target-2", suggestedTarget: "target-2", label: "", title: "Other", url: "https://example.com" },
    { targetId: "target-3", targetPrefix: "target-3", suggestedTarget: "target-3", label: "", title: "Owned", url: "https://example.org" },
  ];
  await assertRejects(() => fakeDaemon.resolveTargetForOperation("target-2", {}, "read observe"), "unproven browser-scoped target is rejected");
  const allowedUnproven = await fakeDaemon.resolveTargetForOperation("target-2", { allowBrowserScopeTarget: true }, "read observe");
  assert(allowedUnproven.targetId === "target-2", "explicit browser-scope override resolves unproven target");
  const ownedNoLabel = await fakeDaemon.resolveTargetForOperation("target-3", {}, "read observe");
  assert(ownedNoLabel.targetId === "target-3", "target provenance allows unlabeled created profile tab");
  const ownerDaemon = Object.create(BrowserDaemon.prototype);
  ownerDaemon.context = { kind: "profile", key: "profile:chrome:Default", owner: "owner-b", profile: { id: "chrome:Default" }, endpointScope: "profile" };
  ownerDaemon.labels = {
    "profile:chrome:Default@@owner:owner-a": { app: "target-a" },
    "profile:chrome:Default@@owner:owner-b": { app: "target-b" },
  };
  ownerDaemon.labelMeta = {};
  ownerDaemon.targetMeta = {};
  ownerDaemon.leases = { "profile:chrome:Default": { "target-a": { targetId: "target-a", owner: "owner-a", updatedAt: new Date().toISOString() } } };
  assert(ownerDaemon.labelsForContext().app === "target-b", "labels are scoped by owner");
  assert(ownerDaemon.targetLeaseWouldConflict({ targetId: "target-a" }, {}) === true, "lease conflict preflight detects cross-owner target");
  await assertRejects(() => ownerDaemon.assertTargetLease({ targetId: "target-a" }, {}, "action click"), "lease conflict rejects cross-owner mutation");
  assert(newestLease([{ owner: "old", updatedAt: "2026-01-01T00:00:00Z" }, { owner: "new", updatedAt: "2026-01-02T00:00:00Z" }]).owner === "new", "newest lease wins stale duplicate resolution");
  assertThrows(() => assertBrowserWideStateChangeAllowed("state permissions reset", {}), "browser-wide permission reset requires force");
  assertBrowserWideStateChangeAllowed("state permissions reset", { force: true });
  ownerDaemon.refStores = new Map();
  ownerDaemon.storeRefs("target-b", { b1: { selector: "#owned" } });
  assert(ownerDaemon.selectorFor("target-b", "b1") === "#owned", "owner ref lookup works");
  ownerDaemon.context = { ...ownerDaemon.context, owner: "owner-c" };
  assertThrows(() => ownerDaemon.selectorFor("target-b", "b1"), "refs are scoped by owner");
  const oldTargetDaemon = { tabs: async () => [{ targetId: "old-1", url: "https://example.com", title: "Example" }] };
  const oldMatch = await waitForOpenedTab(oldTargetDaemon, "https://example.com", new Set(["old-1"]), 1);
  assert(oldMatch.targetId === "old-1", "opened-tab waiter can reuse a single old match when allowed");
  await assertRejects(() => waitForOpenedTab(oldTargetDaemon, "https://example.com", new Set(["old-1"]), 1, { requireFresh: true }), "profile-open waiter requires a fresh target");
  assert(looksLikeActionTargetToken("b1") && looksLikeActionTargetToken("selector:button") && !looksLikeActionTargetToken("Submit"), "action target token classifier");
  const submitText = parseCli(["action", "submit", "-t", "app", "Submit"]);
  assert(submitText.command === "submit" && submitText.args[0] === "Submit", "submit label parser");
  const dragElement = parseCli(["action", "drag", "-t", "app", "b1", "--to", "b2", "--steps", "8", "--duration", "160"]);
  assert(dragElement.command === "drag" && dragElement.args[0] === "b1" && dragElement.flags.to === "b2" && dragElement.flags.steps === "8", "drag element parser");
  const dragPoint = parseCli(["action", "drag", "-t", "app", "--from-point", "10,20", "--to-point", "30,40"]);
  assert(dragPoint.flags.fromPoint === "10,20" && dragPoint.flags.toPoint === "30,40", "drag point parser");
  const dragDelta = parseCli(["action", "drag", "-t", "app", "b1", "--by", "25,-10"]);
  assert(dragDelta.flags.by === "25,-10", "drag delta parser");
  assertThrows(() => validateBeforeContext(parseCli(["action", "drag", "-t", "app", "b1"])), "action drag destination is validated before context attach");
  assert(parsePoint("12.5,-3", "point").x === 12.5 && parsePoint("12.5,-3", "point").y === -3, "drag point parser accepts decimals");
  assert(mouseButtonsFor(parseMouseButton("right")) === 2, "drag button parser");
  const keyAction = parseCli(["action", "key", "-t", "app", "Escape"]);
  assert(keyAction.command === "key" && keyAction.args[0] === "Escape", "key alias parser");
  const typeRef = parseCli(["action", "type", "-t", "app", "e1", "hello"]);
  assert(typeRef.command === "type" && typeRef.args[0] === "e1" && typeRef.args[1] === "hello", "type ref parser");
  const uploadInputRef = parseCli(["action", "upload", "-t", "app", "--input-ref", "e2", "file.png"]);
  assert(uploadInputRef.flags.inputRef === "e2" && uploadInputRef.args[0] === "file.png", "upload input-ref parser");
  const uploadTriggerRef = parseCli(["action", "upload", "-t", "app", "--trigger-ref", "b7", "file.png"]);
  assert(uploadTriggerRef.flags.triggerRef === "b7" && uploadTriggerRef.args[0] === "file.png", "upload trigger-ref parser");
  const allowFileDialog = parseCli(["action", "click", "-t", "app", "b7", "--allow-file-dialog"]);
  assert(allowFileDialog.flags.allowFileDialog === true, "allow file dialog parser");
  assert(fileDialogTriggerReason({ tagName: "INPUT", getAttribute: (name) => (name === "type" ? "file" : null), querySelector: () => null }) === "input[type=file]", "file input structural guard");
  assert(fileDialogTriggerReason({ tagName: "BUTTON", getAttribute: () => null, querySelector: () => null, innerText: "Example picker label" }) === "", "file dialog guard does not depend on text language");
  const actionScreenshot = parseCli(["action", "state", "-t", "app", "--screenshot", "--annotate-refs", "--max-labels", "40", "--out", "tmp/state.png"]);
  assert(actionScreenshot.flags.screenshot === true && actionScreenshot.flags.annotateRefs === true && actionScreenshot.flags.maxLabels === "40" && actionScreenshot.flags.out === "tmp/state.png", "action screenshot parser");
  const waitScreenshot = parseCli(["wait", "ready", "-t", "app", "--visual-stable", "--settle-ms", "300", "--screenshot"]);
  assert(waitScreenshot.flags.visualStable === true && waitScreenshot.flags.settleMs === "300" && waitScreenshot.flags.screenshot === true, "wait screenshot parser");
  const areaScreenshot = parseCli(["screenshot", "area", "-t", "app", "b2", "tmp/button.png", "--annotate-refs"]);
  assert(areaScreenshot.args[0] === "b2" && areaScreenshot.args[1] === "tmp/button.png" && areaScreenshot.flags.annotateRefs === true, "area screenshot ref parser");
  assert(defaultScreenshotFormat({}) === "jpeg" && defaultScreenshotFormat({ rawSize: true }) === "png", "screenshot default normalization format");
  assert(inferScreenshotFormat("tmp/out.png", {}) === "png" && inferScreenshotFormat("tmp/out.jpg", {}) === "jpeg", "screenshot extension format inference");
  assert(screenshotFormatForCapture("tmp/checkpoint.png", {}, { checkpoint: true }) === "jpeg", "checkpoint screenshot defaults to normalized jpeg");
  assert(screenshotFormatForCapture("tmp/checkpoint.png", { rawSize: true }, { checkpoint: true }) === "png", "checkpoint raw-size keeps png");
  assert(appleScriptString('A "quoted" App') === '"A \\"quoted\\" App"', "AppleScript string escaping");
  assert(parseByteSize("5mb", "max-bytes") === 5 * 1024 * 1024, "screenshot byte-size parser");
  assert(JSON.stringify(buildImageResizeSideGrid(2000, 2100)) === "[2000,1800,1600,1400,1200,1000,800]", "screenshot side ladder matches OpenClaw shape");
  const pngHeader = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader, 0);
  pngHeader.write("IHDR", 12, "ascii");
  pngHeader.writeUInt32BE(123, 16);
  pngHeader.writeUInt32BE(45, 20);
  assert(imageDimensionsFromBuffer(pngHeader).width === 123 && imageDimensionsFromBuffer(pngHeader).height === 45, "screenshot PNG dimension parser");
  const deviceViewports = parseDevices("desktop=1440x900,phone=390x844");
  assert(deviceViewports[0].width === 1440 && deviceViewports[1].mobile === true && deviceViewports[1].dpr === 1, "device viewport parser handles equals and phone with exact CSS pixels");
  const readOut = parseCli(["read", "query", "-t", "app", "button,input", "--out", "tmp/controls.json"]);
  assert(readOut.flags.out === "tmp/controls.json", "read --out parser");
  const consoleClearCapture = parseCli(["console", "capture", "-t", "app", "--clear", "--reload", "--out", "tmp/console.json"]);
  assert(consoleClearCapture.flags.clear === true && consoleClearCapture.flags.reload === true, "console capture clear parser");
  const networkBodyCapture = parseCli(["network", "capture", "-t", "app", "--include-body", "--out", "tmp/network.json"]);
  assert(networkBodyCapture.flags.includeBody === true && networkBodyCapture.flags.out === "tmp/network.json", "network include-body out parser");
  assertThrows(() => assertNetworkCaptureBodyOut({ includeBody: true }), "network include-body guard requires out before side effects");
  assertNetworkCaptureBodyOut({ includeBody: true, out: "tmp/network.json" });
  assertNetworkCaptureBodyOut({ includeBody: true, force: true });
  assertThrows(() => validateBeforeContext(parseCli(["network", "capture", "-t", "app", "--include-body"])), "network include-body is validated before context attach");
  assertThrows(() => validateBeforeContext(parseCli(["action", "submit", "-t", "app"])), "action submit target is validated before context attach");
  validateBeforeContext(networkBodyCapture);
  const readOutPath = path.join(ARTIFACT_DIR, `self-test-read-out-${Date.now()}.json`);
  const readOutPayload = await maybeWriteReadOut(result({ text: "raw", matches: [{ ref: "b1" }] }), { out: readOutPath }, { matches: [{ ref: "b1" }] }, "query", { omit: ["matches"] });
  assert(readOutPayload.text.includes("written") && readOutPayload.outPath === readOutPath && !("matches" in readOutPayload), "read --out writes compact stdout payload");
  assert(fs.existsSync(readOutPath), "read --out artifact exists");
  await fsp.rm(readOutPath, { force: true });
  for (const group of Object.keys(GROUPS)) {
    assert(HELP[group] && HELP[group].includes(`realbrowser ${group}`), `help exists for ${group}`);
  }
  const substituted = substituteVariables(["tab", "ensure", "$group.url", "--label", "$group.label", "$media"], { group: { url: "https://example.com", label: "ex" }, media: "file.png" });
  assert(substituted[2] === "https://example.com" && substituted[4] === "ex" && substituted[5] === "file.png", "chain variable substitution");
  const profiles = await listProfiles().catch(() => []);
  assert(Array.isArray(profiles), "profile list returns array");
  // lineDiff tests
  assert(lineDiff("a\nb\nc", "a\nb\nc") === "(no changes)", "lineDiff identical");
  assert(lineDiff("", "hello") === "hello\n\n(no previous snapshot to diff against)", "lineDiff first call");
  const d1 = lineDiff("a\nb\nc", "a\nx\nc");
  assert(d1.includes("- b") && d1.includes("+ x"), "lineDiff single change");
  const d2 = lineDiff("a\na\nb", "a\na\nc");
  assert(d2.includes("- b") && d2.includes("+ c"), "lineDiff duplicate lines preserved");
  // ariaRefKind tests
  assert(ariaRefKind("button") === "b" && ariaRefKind("link") === "l" && ariaRefKind("textbox") === "e", "ariaRefKind mapping");
  assert(ariaRefKind("menuitem") === "b" && ariaRefKind("tab") === "b" && ariaRefKind("checkbox") === "e", "ariaRefKind extended mapping");
  assert(ariaRefKind("tabpanel") === "e" && ariaRefKind("tablist") === "e" && ariaRefKind("toolbar") === "e", "ariaRefKind non-button roles");
  // formatAxTreeV2 tests
  const mockNodes = [
    { nodeId: "1", role: { value: "document" }, name: { value: "Test" }, childIds: ["2", "3"], properties: [] },
    { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Submit" }, childIds: [], backendDOMNodeId: 10, properties: [{ name: "focusable", value: { value: true } }] },
    { nodeId: "3", parentId: "1", role: { value: "link" }, name: { value: "Home" }, childIds: [], backendDOMNodeId: 11, properties: [{ name: "focusable", value: { value: true } }] },
  ];
  const tree = formatAxTreeV2(mockNodes, { interactive: false, compact: false });
  assert(tree.text.includes("document") && tree.text.includes("button") && tree.text.includes("link"), "formatAxTreeV2 basic output");
  assert(tree.interactiveNodes.length === 2, "formatAxTreeV2 interactive nodes");
  const treeI = formatAxTreeV2(mockNodes, { interactive: true, compact: false });
  assert(!treeI.text.includes("document") && treeI.text.includes("button"), "formatAxTreeV2 interactive filter");
  // 0.3.0: context roles preserved with interactive descendants
  const hierMockNodes = [
    { nodeId: "1", role: { value: "WebArea" }, name: { value: "Page" }, childIds: ["2", "9"], properties: [] },
    { nodeId: "2", parentId: "1", role: { value: "main" }, name: { value: "" }, childIds: ["3", "5"], properties: [] },
    { nodeId: "3", parentId: "2", role: { value: "region" }, name: { value: "Search" }, childIds: ["4"], properties: [] },
    { nodeId: "4", parentId: "3", role: { value: "button" }, name: { value: "Find" }, childIds: [], backendDOMNodeId: 100, properties: [{ name: "focusable", value: { value: true } }] },
    { nodeId: "5", parentId: "2", role: { value: "tabpanel" }, name: { value: "Departures" }, childIds: ["6"], properties: [] },
    { nodeId: "6", parentId: "5", role: { value: "button" }, name: { value: "Origin" }, childIds: [], backendDOMNodeId: 101, properties: [{ name: "focusable", value: { value: true } }] },
    { nodeId: "9", parentId: "1", role: { value: "region" }, name: { value: "Empty" }, childIds: [], properties: [] },
  ];
  const hier = formatAxTreeV2(hierMockNodes, { interactive: true, compact: true });
  assert(hier.text.includes("main") && hier.text.includes("Search"), "formatAxTreeV2 keeps named main+region in interactive mode");
  assert(hier.text.includes("tabpanel") && hier.text.includes("Departures"), "formatAxTreeV2 keeps tabpanel in interactive mode");
  assert(hier.text.includes("Origin") && hier.text.includes("Find"), "formatAxTreeV2 keeps interactive buttons");
  assert(!hier.text.includes("Empty"), "formatAxTreeV2 skips context role with no interactive descendants");
  // Indentation: button under main->region nests deeper than direct button under main
  const lineFind = hier.text.split("\n").find((l) => l.includes("Find"));
  const lineOrigin = hier.text.split("\n").find((l) => l.includes("Origin"));
  const indent = (line) => line ? line.match(/^\s*/)[0].length : 0;
  assert(indent(lineFind) > 0 && indent(lineOrigin) > 0, "formatAxTreeV2 indents interactive elements under context");
  // read tree parser
  const readTree = parseCli(["read", "tree", "-t", "app", "-i", "-c", "-D", "-d", "4"]);
  assert(readTree.group === "read" && readTree.command === "tree", "read tree parser group/command");
  assert(readTree.flags.interactive === true && readTree.flags.compact === true && readTree.flags.diff === true && readTree.flags.depth === "4", "read tree short flags");
  // bug fix regressions
  const aopts = actionOptions([], {});
  assert(aopts.root === undefined, "actionOptions no flags yields undefined root");
  assert(actionOptions([], { root: "e5" }).rootSelector === "e5", "actionOptions ref root passes rootSelector");
  const wopts = waitReadyOptions(["/tmp/ready.png"], { screenshot: true }, 10000);
  assert(wopts.selector === "", "waitReadyOptions does not use positional arg as selector");
  // 0.3.0 features
  assert(actionOptions([], { bypassOverlay: true }).bypassOverlay === true, "actionOptions surfaces bypassOverlay");
  const bypassParsed = parseCli(["action", "click", "-t", "app", "b3", "--bypass-overlay"]);
  assert(bypassParsed.flags.bypassOverlay === true, "--bypass-overlay parsed as boolean flag");
  const autoParsed = parseCli(["read", "autocomplete", "-t", "app"]);
  assert(autoParsed.group === "read" && autoParsed.command === "autocomplete", "read autocomplete parser");
  const overlayParsed = parseCli(["read", "overlay", "-t", "app", "--limit", "10"]);
  assert(overlayParsed.command === "overlay" && overlayParsed.flags.limit === "10", "read overlay parser");
  const oRefParsed = parseCli(["action", "click", "-t", "app", "o4"]);
  assert(oRefParsed.args[0] === "o4", "o-ref accepted as click target");
  // o-ref recognized by selectorFor regex (validated indirectly: ref should match the same shape as b/e/l)
  assert(/^[ebfrilco]\d+$/i.test("o7") && /^[ebfrilco]\d+$/i.test("b1"), "ref pattern accepts o-prefix");
  // 0.3.0: --near anchor flag for read autocomplete
  const nearParsed = parseCli(["read", "autocomplete", "-t", "app", "--near", "b21"]);
  assert(nearParsed.command === "autocomplete" && nearParsed.flags.near === "b21", "read autocomplete --near parser");
  const nearShortRef = parseCli(["read", "overlay", "-t", "app", "--near", "e9", "--limit", "20"]);
  assert(nearShortRef.flags.near === "e9" && nearShortRef.flags.limit === "20", "read overlay --near + --limit parser");
  // 0.3.0: --require-change flag for action fill (silent no-op detection)
  const reqChange = parseCli(["action", "fill", "-t", "app", "e3", "09/05/2026", "--require-change"]);
  assert(reqChange.flags.requireChange === true, "--require-change parsed as boolean flag");
  const aoptsChange = actionOptions([], { requireChange: true });
  assert(aoptsChange.requireChange === true, "actionOptions surfaces requireChange");
  // 0.3.0: click auto-fallback. We can't run the in-page functions here,
  // but we verify their shape and that the wiring functions exist so a
  // refactor that drops the auto-fallback breaks the self-test.
  assert(typeof postClickFallbackFunction === "function" && postClickFallbackFunction.length === 2,
    "postClickFallbackFunction takes (selector, preSignature)");
  assert(typeof maybeRunClickAutoFallback === "function",
    "maybeRunClickAutoFallback wired into click pipeline");
  assert(typeof elementInFloatingLayer === "function" && typeof pageStateSignature === "function",
    "floating-layer detection helpers exist");
  // The synthetic dispatch sequence in postClickFallbackFunction must include
  // a PointerEvent for AntD's outside-click detector. Hard-fail if we
  // accidentally drop the pointerdown step in a future refactor.
  const fallbackSrc = postClickFallbackFunction.toString();
  assert(fallbackSrc.includes("PointerEvent") && fallbackSrc.includes("pointerdown"),
    "postClickFallbackFunction dispatches PointerEvent('pointerdown') (required for AntD popovers)");
  assert(fallbackSrc.includes("mousedown") && fallbackSrc.includes("mouseup") && fallbackSrc.includes("click"),
    "postClickFallbackFunction dispatches full mouse sequence");
  // clickFunction must annotate payload with `inFloatingLayer` and
  // `preClickSignature` so the caller can run the auto-fallback.
  const clickSrc = clickFunction.toString();
  assert(clickSrc.includes("inFloatingLayer") && clickSrc.includes("preClickSignature"),
    "clickFunction surfaces inFloatingLayer + preClickSignature on payload");
  assert(clickSrc.includes("clickMethod = \"cdp\""),
    "clickFunction defaults clickMethod to 'cdp' for the CDP-dispatch path");
  // 0.3.0: cursor-clickables (non-ARIA DOM clickables surfaced in read tree).
  // Verify the function exists, accepts opts, and contains the expected
  // predicates so a refactor that drops a predicate fails the self-test.
  assert(typeof cursorClickablesFunction === "function",
    "cursorClickablesFunction defined — wired into ariaTree");
  const ccSrc = cursorClickablesFunction.toString();
  assert(ccSrc.includes('cursor === "pointer"'), "cursorClickablesFunction checks cursor:pointer");
  assert(ccSrc.includes('tabindex'), "cursorClickablesFunction checks tabindex");
  assert(ccSrc.includes('onclick'), "cursorClickablesFunction checks onclick");
  assert(ccSrc.includes('contenteditable'), "cursorClickablesFunction checks contenteditable");
  assert(ccSrc.includes('aria-haspopup'), "cursorClickablesFunction checks aria-haspopup");
  assert(ccSrc.includes('data-realbrowser-ref'), "cursorClickablesFunction de-dups against AX-stamped refs");
  assert(ccSrc.includes('parentElement') && ccSrc.includes('cursor === "pointer"'),
    "cursorClickablesFunction parent-collapse rule preserved");
  // The c-ref namespace must round-trip through selectorFor's regex —
  // refs come back as e.g. "c5", and the regex must accept them.
  assert(/^[ebfrilco]\d+$/i.test("c1") && /^[ebfrilco]\d+$/i.test("c99"),
    "c-ref pattern accepted by selectorFor (cursor-clickables clickable via standard click path)");
  // ariaTree must wire the cursor-clickables pass after assignAriaRefs.
  const ariaTreeSrc = BrowserDaemon.prototype.ariaTree.toString();
  assert(ariaTreeSrc.includes('cursorClickablesFunction'),
    "ariaTree calls cursorClickablesFunction after AX stamping");
  assert(ariaTreeSrc.includes('cursor-clickables'),
    "ariaTree appends cursor-clickables section header");
  // v0.3.0: click auto-fallback now fires for ALL CDP clicks (not just
  // floating-layer or c-ref). Plain SPA route-swap buttons can drop
  // events too. The eligibility tag is diagnostic, no longer a gate.
  const fallbackEntrySrc = maybeRunClickAutoFallback.toString();
  assert(fallbackEntrySrc.includes('isCRef') && fallbackEntrySrc.includes('data-realbrowser-ref="c'),
    "maybeRunClickAutoFallback tags c-ref clicks for diagnostics");
  assert(!fallbackEntrySrc.match(/if\s*\(\s*!payload\.inFloatingLayer\s*&&\s*!isCRef\s*\)\s*return/),
    "maybeRunClickAutoFallback no longer gates on floating-layer || c-ref (drops the v0.3.01 gate)");
  // Signature must include scrollHeight + xhrCount (catches panel-swap
  // SPAs whose body text doesn't change and submit handlers that kick
  // off fetches before any DOM mutation). xhrCount filters to
  // user-initiated fetch/XHR so passive prefetch/analytics polls don't
  // falsely flip the signal.
  const sigSrc = pageStateSignature.toString();
  assert(sigSrc.includes('scrollHeight') && sigSrc.includes('xhrCount'),
    "pageStateSignature includes scrollHeight + xhrCount");
  assert(sigSrc.includes('"fetch"') && sigSrc.includes('"xmlhttprequest"'),
    "pageStateSignature filters resource entries to fetch + xmlhttprequest only");
  assert(GROUPS.action.includes("drag"), "action group includes drag");
  assert(typeof dragPointFunction === "function" && typeof dispatchMouseDrag === "function",
    "drag helpers are defined");
  const dragDispatchSrc = dispatchMouseDrag.toString();
  assert(dragDispatchSrc.includes("mousePressed") && dragDispatchSrc.includes("mouseMoved") && dragDispatchSrc.includes("mouseReleased"),
    "dispatchMouseDrag sends press/move/release CDP events");
  // 0.3.0: multi-OS browser executable resolver. We can't fs.existsSync the
  // candidate paths in a portable test, so we exercise the candidate
  // generator + the kind-filtering logic that drives findBrowserExecutable.
  const candidates = browserExecutableCandidates();
  assert(Array.isArray(candidates) && candidates.length >= 4, "browserExecutableCandidates returns a non-empty list");
  const kinds = new Set(candidates.map((entry) => entry.kind));
  assert(kinds.has("chrome") && kinds.has("brave") && kinds.has("edge"), "candidate list spans chrome+brave+edge");
  if (process.platform === "darwin") {
    assert(kinds.has("vivaldi") && kinds.has("arc"), "macOS candidates include vivaldi and arc");
    assert(candidates[0].path === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "macOS chrome candidate is first");
    const braveOnMac = candidates.filter((c) => c.kind === "brave");
    assert(braveOnMac.every((c) => c.path.startsWith("/Applications/")), "macOS brave candidates live under /Applications");
  } else if (process.platform === "linux") {
    assert(candidates.some((c) => c.kind === "chrome" && c.path === "/usr/bin/google-chrome"), "linux includes /usr/bin/google-chrome");
    assert(candidates.some((c) => c.kind === "chromium" && c.path === "/snap/bin/chromium"), "linux includes /snap/bin/chromium");
    assert(candidates.some((c) => c.kind === "brave" && c.path.includes("brave-browser")), "linux includes brave");
    assert(candidates.some((c) => c.kind === "edge" && c.path === "/usr/bin/microsoft-edge"), "linux includes /usr/bin/microsoft-edge");
  } else if (IS_WINDOWS) {
    assert(candidates.some((c) => c.kind === "chrome" && c.path.toLowerCase().endsWith("chrome.exe")), "windows candidates contain chrome.exe");
    assert(candidates.some((c) => c.kind === "brave" && c.path.toLowerCase().endsWith("brave.exe")), "windows candidates contain brave.exe");
    assert(candidates.some((c) => c.kind === "edge" && c.path.toLowerCase().endsWith("msedge.exe")), "windows candidates contain msedge.exe");
  }
  // CHROME_PATH override semantics — synthesize a candidate file and test
  // that the override wins regardless of platform.
  const overrideStashPath = path.join(os.tmpdir(), `realbrowser-self-test-${process.pid}-chrome`);
  await fsp.writeFile(overrideStashPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const priorChromePath = process.env.CHROME_PATH;
  try {
    process.env.CHROME_PATH = overrideStashPath;
    assert(findBrowserExecutable() === overrideStashPath, "CHROME_PATH override wins over default candidates");
    assert(findBrowserExecutable("chrome") === overrideStashPath, "CHROME_PATH override honored when --browser=chrome");
    // A mismatched browser hint should bypass the override (the override path
    // doesn't include "brave" in its name) and fall through to fs.existsSync.
    const braveResolved = findBrowserExecutable("brave");
    assert(braveResolved === null || braveResolved !== overrideStashPath, "CHROME_PATH does not satisfy --browser=brave when name doesn't match");
    process.env.CHROME_PATH = "/this/path/definitely/does/not/exist/realbrowser-test";
    const fallbackResolved = findBrowserExecutable();
    // Either a real candidate matched on this host, or no browser exists; the
    // override must NOT be returned because fs.existsSync is false.
    assert(fallbackResolved !== "/this/path/definitely/does/not/exist/realbrowser-test", "missing CHROME_PATH does not poison the resolver");
  } finally {
    if (priorChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = priorChromePath;
    await fsp.rm(overrideStashPath, { force: true });
  }
  // 0.3.0: cross-owner label fallback (rescues terminal-pane / multi-session
  // workflow where TERM_SESSION_ID-derived owner changes between calls).
  const xLabels = {
    [`profile:chrome:Default${OWNER_SCOPE_SEPARATOR}owner-old`]: { vn: "TID-VN-OLD", solo: "TID-SOLO" },
    [`profile:chrome:Default${OWNER_SCOPE_SEPARATOR}owner-new`]: { other: "TID-OTHER" },
    [`anonymous:s1${OWNER_SCOPE_SEPARATOR}owner-old`]: { aaa: "TID-A" },
  };
  const xDaemon = {
    labels: xLabels,
    context: { key: "profile:chrome:Default" },
    contextScopeKey: () => `profile:chrome:Default${OWNER_SCOPE_SEPARATOR}owner-new`,
    labelsForContext: BrowserDaemon.prototype.labelsForContext,
  };
  const sameOwner = xDaemon.labelsForContext.call(xDaemon);
  assert(!sameOwner.vn, "labelsForContext same-owner does not see other owner's vn label");
  assert(!sameOwner.solo, "labelsForContext same-owner does not see other owner's solo");
  const cross = xDaemon.labelsForContext.call(xDaemon, { includeCrossOwner: true });
  assert(cross.vn === "TID-VN-OLD", "labelsForContext cross-owner picks up vn from other owner under same base context");
  assert(cross.solo === "TID-SOLO", "labelsForContext cross-owner picks up solo from other owner");
  assert(!cross.aaa, "labelsForContext cross-owner does not bleed across base contexts (anonymous != profile)");
  // contextFlagsForKnownTarget cross-owner fallback
  // (uses LABELS_FILE so we test the function structurally with unique vs ambiguous)
  const cfRaw = "vn";
  const cfOwner = "owner-fresh";
  const cfMatchesSame = [];
  const cfMatchesOther = [];
  for (const [contextKey, contextLabels] of Object.entries(xLabels)) {
    if (typeof contextLabels[cfRaw] !== "string") continue;
    const so = ownerFromScopedContextKey(contextKey);
    if (!so || so === cfOwner) cfMatchesSame.push(contextKey);
    else cfMatchesOther.push(contextKey);
  }
  assert(cfMatchesSame.length === 0, "contextFlagsForKnownTarget no same-owner matches when owner is fresh");
  const cfOtherUnique = [...new Set(cfMatchesOther.map(baseContextKeyFromScopedKey))];
  assert(cfOtherUnique.length === 1 && cfOtherUnique[0] === "profile:chrome:Default", "contextFlagsForKnownTarget cross-owner unique base context");
  // 0.3.0: resolveBrowserContextIdForProfile picks the right browserContextId
  // when Chrome runs browser-scoped CDP across multiple profiles. Single
  // strict pass: only profileOwned=true with a trusted source
  // (profile-open from --profile-directory launch, or cdp-create-with-context
  // from a verified Target.createTarget). Labels and untrusted sources are
  // intentionally skipped — under multi-profile Chrome they may anchor to
  // tabs in any profile and would re-introduce the wrong-profile bug.
  // Bootstrap (no proven tab yet) → caller must probe safely or return
  // background_create_unavailable.
  const bcDaemon = Object.create(BrowserDaemon.prototype);
  bcDaemon.context = { kind: "profile", key: "profile:chrome:Default", profile: { id: "chrome:Default" }, endpointScope: "browser" };
  const bcOwnedKey = `profile:chrome:Default${OWNER_SCOPE_SEPARATOR}owner-me`;
  const bcCrossKey = `profile:chrome:Default${OWNER_SCOPE_SEPARATOR}owner-other`;
  bcDaemon.contextScopeKey = () => bcOwnedKey;
  bcDaemon.labels = {};
  bcDaemon.targetMeta = {
    [bcOwnedKey]: {
      "tid-proven": { profile: "chrome:Default", profileOwned: true, source: "profile-open" },
      "tid-untrusted": { profile: "chrome:Default", profileOwned: true, source: "browser-scope-cdp-create" },
      "tid-other-profile": { profile: "chrome:Profile 1", profileOwned: true, source: "profile-open" },
    },
    [bcCrossKey]: {
      "tid-cross-proven": { profile: "chrome:Default", profileOwned: true, source: "profile-open" },
    },
  };
  bcDaemon.tabsRaw = async () => [
    { targetId: "tid-untrusted", browserContextId: "ctx-WRONG" },
    { targetId: "tid-other-profile", browserContextId: "ctx-OTHER" },
    { targetId: "tid-proven", browserContextId: "ctx-DEFAULT" },
    { targetId: "tid-cross-proven", browserContextId: "ctx-DEFAULT" },
  ];
  const bcResolved = await bcDaemon.resolveBrowserContextIdForProfile("chrome:Default");
  assert(bcResolved === "ctx-DEFAULT", "resolveBrowserContextIdForProfile picks proven same-owner context, not untrusted source");
  // Cross-owner fallback: same-owner has no proven entry, cross-owner does.
  bcDaemon.targetMeta[bcOwnedKey] = {
    "tid-untrusted": { profile: "chrome:Default", profileOwned: true, source: "browser-scope-cdp-create" },
  };
  const bcCross = await bcDaemon.resolveBrowserContextIdForProfile("chrome:Default");
  assert(bcCross === "ctx-DEFAULT", "resolveBrowserContextIdForProfile falls back to cross-owner proven entry");
  // Untrusted-source only: returns null so caller does not anchor on unsafe
  // history. We intentionally do NOT use the "tid-untrusted" tab as
  // a context anchor: that target was created by pre-0.3.0 cdp-create which
  // lied about profile attribution. Trusting it would re-introduce the
  // wrong-profile bug under multi-profile Chrome.
  bcDaemon.targetMeta = {
    [bcOwnedKey]: { "tid-untrusted": { profile: "chrome:Default", profileOwned: true, source: "browser-scope-cdp-create" } },
  };
  const bcUntrustedOnly = await bcDaemon.resolveBrowserContextIdForProfile("chrome:Default");
  assert(bcUntrustedOnly === null, "resolveBrowserContextIdForProfile rejects untrusted-source-only state to force --profile-directory bootstrap");
  // No live tab matching: also null.
  bcDaemon.targetMeta = {
    [bcOwnedKey]: { "tid-dead": { profile: "chrome:Default", profileOwned: true, source: "profile-open" } },
  };
  const bcNone = await bcDaemon.resolveBrowserContextIdForProfile("chrome:Default");
  assert(bcNone === null, "resolveBrowserContextIdForProfile returns null when no live tab matches");
  // cdp-create-with-context source is trusted (we passed browserContextId).
  bcDaemon.targetMeta = {
    [bcOwnedKey]: { "tid-proven": { profile: "chrome:Default", profileOwned: true, source: "cdp-create-with-context" } },
  };
  const bcVerified = await bcDaemon.resolveBrowserContextIdForProfile("chrome:Default");
  assert(bcVerified === "ctx-DEFAULT", "resolveBrowserContextIdForProfile trusts cdp-create-with-context source");
  // Legacy unscoped key (pre-owner-scoping) is read as a last-resort fallback.
  bcDaemon.targetMeta = {
    "profile:chrome:Default": { "tid-proven": { profile: "chrome:Default", profileOwned: true, source: "profile-open" } },
  };
  const bcLegacy = await bcDaemon.resolveBrowserContextIdForProfile("chrome:Default");
  assert(bcLegacy === "ctx-DEFAULT", "resolveBrowserContextIdForProfile reads legacy unscoped meta store");

  // v0.3.0: enumerateLiveBrowserContexts unions explicit context list with
  // contexts visible on live page targets. Size > 1 = multi-profile ambiguity
  // for the default-context fallback in tab ensure --background.
  const enumDaemon = Object.create(BrowserDaemon.prototype);
  enumDaemon.cdp = { send: async (method) => { if (method === "Target.getBrowserContexts") return { browserContextIds: ["ctx-A"] }; return null; } };
  enumDaemon.tabsRaw = async () => [
    { targetId: "tid-a", browserContextId: "ctx-A" },
    { targetId: "tid-b", browserContextId: "ctx-B" },
    { targetId: "tid-c", browserContextId: "" },
  ];
  const enumSet = await enumDaemon.enumerateLiveBrowserContexts();
  assert(enumSet instanceof Set, "enumerateLiveBrowserContexts returns a Set");
  assert(enumSet.size === 2, "enumerateLiveBrowserContexts unions getBrowserContexts and tab targets, drops empty");
  assert(enumSet.has("ctx-A") && enumSet.has("ctx-B"), "enumerateLiveBrowserContexts captures both distinct contexts");
  // Single-profile case: only one context visible across all surfaces.
  enumDaemon.cdp = { send: async () => ({ browserContextIds: [] }) };
  enumDaemon.tabsRaw = async () => [
    { targetId: "tid-x", browserContextId: "ctx-ONLY" },
    { targetId: "tid-y", browserContextId: "ctx-ONLY" },
  ];
  const enumSingle = await enumDaemon.enumerateLiveBrowserContexts();
  assert(enumSingle.size === 1 && enumSingle.has("ctx-ONLY"), "enumerateLiveBrowserContexts collapses identical contexts to single entry");

  // Task-tab registry: origin canonicalization, classifyTabOwnership, and
  // duplicate-task-origin guard (Codex § 7 self-test additions).
  const originA = canonicalOriginKey("https://www.example.com/?x=1");
  const originB = canonicalOriginKey("https://www.example.com/vn/en/home");
  assert(originA === originB, "canonicalOriginKey dedupes same web origin across paths/queries");
  assert(canonicalOriginKey("https://Example.COM:443/foo") === "https://example.com", "canonicalOriginKey lowercases host and strips default port");
  assert(canonicalOriginKey("http://example.com:8080/") === "http://example.com:8080", "canonicalOriginKey keeps non-default port");
  assert(canonicalOriginKey("about:blank").startsWith("url:"), "canonicalOriginKey falls back to url: for non-http schemes");

  const taskScope = taskRegistryScopeKey("profile:chrome:Default@@owner:owner-a", "task-x");
  assert(taskScope === "profile:chrome:Default@@owner:owner-a@@task:task-x", "taskRegistryScopeKey composes context+task key");

  const taskDaemon = Object.create(BrowserDaemon.prototype);
  taskDaemon.context = { kind: "profile", key: "profile:chrome:Default", owner: "owner-a", profile: { id: "chrome:Default" }, endpointScope: "profile" };
  taskDaemon.labels = {};
  taskDaemon.labelMeta = {};
  taskDaemon.targetMeta = {};
  taskDaemon.leases = {};
  taskDaemon.taskTabs = {
    "profile:chrome:Default@@owner:owner-a@@task:owner-a": {
      "https://www.example.com": {
        targetId: "target-example",
        label: "app",
        owner: "owner-a",
        taskId: "owner-a",
        origin: "https://www.example.com",
      },
    },
  };
  assert(taskDaemon.classifyTabOwnership({ targetId: "target-example" }, {}) === "mine", "task registry marks current task tab as mine");
  assert(taskDaemon.classifyTabOwnership({ targetId: "target-other" }, {}) === "user", "unregistered tab is user-owned by default");
  // Cross-task-same-owner classification should yield 'my-other-task'.
  taskDaemon.taskTabs["profile:chrome:Default@@owner:owner-a@@task:other-task"] = {
    "https://example.com": { targetId: "target-other-task", owner: "owner-a", taskId: "other-task" },
  };
  assert(taskDaemon.classifyTabOwnership({ targetId: "target-other-task" }, {}) === "my-other-task", "another-task-same-owner tab classifies as my-other-task");

  // Duplicate-task-origin error shape — the agent must see the next commands.
  let dupErr = null;
  try {
    throw duplicateTaskOriginError({
      origin: "https://www.example.com",
      existing: { targetId: "target-example", label: "app", url: "https://www.example.com/", owner: "owner-a", taskId: "owner-a" },
      requestedLabel: "app2",
      url: "https://www.example.com/",
    });
  } catch (err) {
    dupErr = err;
  }
  assert(dupErr instanceof CliError, "duplicateTaskOriginError yields a CliError");
  assert(dupErr.code === "duplicate_task_origin", "duplicate_task_origin error code");
  assert(Array.isArray(dupErr.next) && dupErr.next.some((s) => s.startsWith("realbrowser tab navigate ")), "duplicate_task_origin includes navigate hint");
  assert(dupErr.next.some((s) => s.includes("--force-new")), "duplicate_task_origin includes force-new escape hatch");

  // resolveTaskId precedence: explicit task > REALBROWSER_TASK_ID env > owner.
  assert(resolveTaskId({ task: "explicit-t" }) === "explicit-t", "resolveTaskId honors explicit task flag");
  const prevEnvTask = process.env.REALBROWSER_TASK_ID;
  process.env.REALBROWSER_TASK_ID = "env-t";
  assert(resolveTaskId({}) === "env-t", "resolveTaskId reads REALBROWSER_TASK_ID env");
  delete process.env.REALBROWSER_TASK_ID;
  if (prevEnvTask !== undefined) process.env.REALBROWSER_TASK_ID = prevEnvTask;
  assert(resolveTaskId({ owner: "owner-z" }) === "owner-z", "resolveTaskId falls back to owner when no task given");
  assert(resolveTaskId({}) === DEFAULT_TASK_ID || resolveTaskId({}) !== "", "resolveTaskId always returns a non-empty id");

  // Parser: --mine, --force-new, --allow-user-tab-mutation, --task value.
  const mineParsed = parseCli(["tab", "list", "--mine"]);
  assert(mineParsed.flags.mine === true, "tab list --mine parser");
  const forceNewParsed = parseCli(["tab", "ensure", "https://example.com", "--label", "x", "--force-new"]);
  assert(forceNewParsed.flags.forceNew === true, "tab ensure --force-new parser");
  const allowUserMutate = parseCli(["tab", "navigate", "-t", "x", "https://example.com", "--allow-user-tab-mutation"]);
  assert(allowUserMutate.flags.allowUserTabMutation === true, "tab navigate --allow-user-tab-mutation parser");
  const taskFlagParsed = parseCli(["tab", "list", "--task", "task-9f3a"]);
  assert(taskFlagParsed.flags.task === "task-9f3a", "tab list --task parser");
  const closeMineParsed = parseCli(["tab", "close", "--mine"]);
  assert(closeMineParsed.flags.mine === true, "tab close --mine parser");
  const doneParsed = parseCli(["tab", "done", "--close"]);
  assert(doneParsed.command === "done" && doneParsed.flags.close === true, "tab done parser with --close");

  stdout("realbrowser self-test passed\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, message) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(message);
}

async function assertRejects(fn, message) {
  let rejected = false;
  try { await fn(); } catch { rejected = true; }
  if (!rejected) throw new Error(message);
}

function cleanActionErrorMessage(error) {
  return String(error?.message || error || "action failed").split("\n")[0].replace(/^Error:\s*/, "");
}

function formatError(error, json = false) {
  const payload = {
    error: { code: error.code || "error", message: error.message || String(error) },
    next: error.next || [],
  };
  if (json) return `${JSON.stringify(payload)}\n`;
  const lines = [`error: ${payload.error.message}`];
  if (payload.next.length) lines.push("", "next:", ...payload.next.map((entry) => `  ${entry}`));
  return `${lines.join("\n")}\n`;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(formatError(error, process.argv.includes("--json")));
  process.exitCode = error.exitCode || 1;
}
