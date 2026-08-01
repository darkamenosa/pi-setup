/**
 * Pi Schedule Extension
 *
 * Long-term scheduling foundation for Pi:
 * - canonical natural-language `/schedule` command plus goal-style lifecycle tools
 * - AI structured parser with deterministic validation and safe fallbacks
 * - SQLite scheduled task definitions plus Codex-style leased execution rows
 * - idle main-thread delivery via available extension APIs
 * - compact footer/status UI, similar in spirit to Keep Thinking
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

const STATUS_KEY = "schedule";
const EVENT_TYPE = "schedule-event";
const AUTONOMOUS_YIELD_CHANNEL = "pi:autonomous-continuation-yield:v1";
const AUTONOMOUS_QUERY_CHANNEL = "pi:autonomous-continuation-query:v1";
const BUFFERED_INPUT_EVENT_CHANNEL = "pi:autocompact-buffered-input:v1";
const BUFFERED_INPUT_MESSAGE_TYPE = "autocompact-buffered-input";
const DB_FILE = "state.sqlite";
const SCHEDULE_SCHEMA_VERSION = 4;
const IDLE_RETRY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 60 * 1000;
const DEFAULT_RETRY_REMAINING = 3;
const DEFAULT_MISFIRE_GRACE_MS = 10 * 60 * 1000;
const POLL_ERROR_RETRY_MS = 30 * 1000;
const HANDOFF_LEASE_RENEWAL_MS = DEFAULT_LEASE_MS / 2;
const HANDOFF_LEASE_RETRY_MS = 30 * 1000;
const MAX_PROMPT_CHARS = 8_000;
const RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const RUN_RETENTION_MAINTENANCE_MS = 60 * 60 * 1000;
const RUN_RETENTION_META_KEY = "last_run_retention_at";
const MAX_TERMINAL_RUNS_PER_TASK = 1_000;
const MAX_LIST_ITEMS = 50;

type ScopeKind = "thread" | "project" | "user";
type ScheduleTaskStatus = "active" | "paused" | "completed" | "missed" | "failed" | "cancelled";
type TaskLastStatus = "idle" | "waiting_idle" | "delivered" | "delivery_error" | "delivery_failed" | "missed" | "skipped";
type RunStatus = "pending" | "claimed" | "delivered" | "delivery_error" | "delivery_failed" | "missed" | "skipped";
type CompletionStatus = "unknown" | "success" | "failed" | "not_applicable";

type Trigger =
	| { kind: "once"; at: number }
	| { kind: "interval"; everyMs: number }
	| { kind: "cron"; expr: string; timezone: string };

type Target = { kind: "main_thread" };

interface ParsedScheduleCreate {
	action: "create";
	prompt: string;
	trigger: Trigger;
	target: Target;
	runImmediately: boolean;
	timezone: string;
}

interface ParsedScheduleClarify {
	action: "clarify";
	question: string;
}

type ParsedSchedule = ParsedScheduleCreate | ParsedScheduleClarify;

interface ScheduleTask {
	id: string;
	scopeKind: ScopeKind;
	scopeKey: string;
	rawRequest: string;
	prompt: string;
	trigger: Trigger;
	target: Target;
	timezone: string;
	status: ScheduleTaskStatus;
	revision: number;
	nextFireAt?: number;
	lastFireAt?: number;
	runCount: number;
	overlapPolicy: "skip" | "queue" | "parallel";
	catchupPolicy: "none" | "ask" | "one";
	expiresAt?: number;
	manualFireAt?: number;
	createdAt: number;
	updatedAt: number;
	lastStatus?: TaskLastStatus;
	lastError?: string;
}

interface ScheduleRunClaim {
	task: ScheduleTask;
	fireAt: number;
	ownershipToken: string;
	manual: boolean;
}

interface ScheduleRun {
	taskId: string;
	fireAt: number;
	status: RunStatus;
	retryAt?: number;
	retryRemaining: number;
	leaseUntil?: number;
	deliveryRef?: string;
	deliveredAt?: number;
	completionStatus: CompletionStatus;
	completionAt?: number;
	completionError?: string;
	lastError?: string;
	createdAt: number;
	updatedAt: number;
}

type ProcessTaskResult = "handled" | "handed_off";

interface PendingHandoff {
	session: CurrentSession;
	claim: ScheduleRunClaim;
	inputObserved: boolean;
	bufferedReplayId?: string;
}

interface DeliveryResult {
	state: "delivered" | "not_idle";
}

interface CurrentSession {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	workerId: string;
	scope: Scope;
}

interface Scope {
	kind: ScopeKind;
	key: string;
	label: string;
}

type ScheduleCreation =
	| { created: true; task: ScheduleTask; scope: Scope }
	| { created: false; question: string };

interface CronFields {
	minute: number[];
	hour: number[];
	dayOfMonth: number[];
	month: number[];
	dayOfWeek: number[];
}

class UnsupportedScheduleSchemaError extends Error {
	constructor(version: string | undefined) {
		super(`Unsupported schedule database schema ${version ?? "unversioned"}; remove ${dbPath()} to reset schedules`);
		this.name = "UnsupportedScheduleSchemaError";
	}
}

const SCHEDULE_PARSE_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["action", "prompt", "question", "runImmediately", "timezone", "trigger"],
	properties: {
		action: { type: "string", enum: ["create", "clarify"] },
		prompt: { type: ["string", "null"] },
		question: { type: ["string", "null"] },
		runImmediately: { type: "boolean" },
		timezone: { type: "string" },
		trigger: {
			type: "object",
			additionalProperties: false,
			required: ["kind", "at", "everyMs", "expr", "timezone"],
			properties: {
				kind: { type: "string", enum: ["once", "interval", "cron", "none"] },
				at: { type: ["string", "null"] },
				everyMs: { type: ["number", "null"] },
				expr: { type: ["string", "null"] },
				timezone: { type: ["string", "null"] },
			},
		},
	},
};

const SCHEDULE_TOOL_PARAMETERS = Type.Object({
	request: Type.String({
		description: "Natural-language schedule to create, including both the future task and when it should run",
	}),
});

const GET_SCHEDULES_PARAMETERS = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional schedule id to inspect" })),
	include_terminal: Type.Optional(Type.Boolean({ description: "Include completed, missed, failed, and cancelled schedules" })),
});

const UPDATE_SCHEDULE_PARAMETERS = Type.Object({
	id: Type.String({ description: "Schedule id returned by create_schedule or get_schedules" }),
	action: Type.Union([
		Type.Literal("pause"),
		Type.Literal("resume"),
		Type.Literal("cancel"),
	]),
});

let currentSession: CurrentSession | undefined;
let dueTimer: ReturnType<typeof setTimeout> | undefined;
let retentionTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
let pollAgainAfterCurrent = false;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let lastStatusText: string | undefined;
let autonomousYieldRequested = false;
let pendingHandoff: PendingHandoff | undefined;
let handoffLeaseTimer: ReturnType<typeof setTimeout> | undefined;

function setAutonomousYield(session: CurrentSession, pending: boolean, reason?: "delivery" | "withdrawn" | "shutdown"): void {
	if (autonomousYieldRequested === pending) return;
	autonomousYieldRequested = pending;
	session.pi.events.emit(AUTONOMOUS_YIELD_CHANNEL, {
		source: "schedule",
		sessionId: session.scope.key,
		pending,
		...(!pending && reason ? { reason } : {}),
	});
}

function scheduleRoot(): string {
	return process.env.PI_SCHEDULE_HOME || join(getAgentDir(), "schedules");
}

function dbPath(): string {
	return join(scheduleRoot(), DB_FILE);
}
function debugLog(data: Record<string, unknown>): void {
	const file = process.env.PI_SCHEDULE_DEBUG_LOG;
	if (!file) return;
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...data })}\n`, "utf8");
	} catch {
		// Debug logging must never affect scheduling.
	}
}


function isSqliteBusy(error: unknown): boolean {
	return isRecord(error) && error.errcode === 5;
}

function enableScheduleWal(db: DatabaseSync): void {
	// Reissuing journal_mode=WAL can contend with another process's schema
	// transaction even when WAL is already active. Observe first; retry only the
	// one-time mode transition for a fresh shared database.
	let lastBusy: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const current = db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>;
			if (String(current.journal_mode).toLowerCase() === "wal") return;
			const changed = db.prepare("PRAGMA journal_mode = WAL").get() as Record<string, unknown>;
			if (String(changed.journal_mode).toLowerCase() === "wal") return;
			throw new Error(`Unable to enable SQLite WAL mode: ${String(changed.journal_mode)}`);
		} catch (error) {
			if (!isSqliteBusy(error) || attempt === 2) throw error;
			lastBusy = error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
	throw lastBusy;
}

function openDb(): DatabaseSync {
	mkdirSync(dirname(dbPath()), { recursive: true });
	const db = new DatabaseSync(dbPath());
	try {
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
		enableScheduleWal(db);
		initDb(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function createScheduleSchema(db: DatabaseSync): void {
	db.exec(`
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  raw_request TEXT NOT NULL,
  prompt TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind = 'main_thread'),
  target_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'missed', 'failed', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 0,
  next_fire_at INTEGER,
  last_fire_at INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  overlap_policy TEXT NOT NULL DEFAULT 'skip',
  catchup_policy TEXT NOT NULL DEFAULT 'none',
  expires_at INTEGER,
  manual_fire_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_status TEXT,
  last_error TEXT
);
CREATE TABLE scheduled_runs (
  task_id TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  worker_id TEXT,
  ownership_token TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  retry_at INTEGER,
  retry_remaining INTEGER NOT NULL,
  delivered_at INTEGER,
  delivery_ref TEXT,
  completion_status TEXT NOT NULL DEFAULT 'unknown',
  completion_at INTEGER,
  completion_error TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, fire_at),
  FOREIGN KEY(task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
);
CREATE INDEX idx_scheduled_tasks_scope_next ON scheduled_tasks(scope_kind, scope_key, status, next_fire_at);
CREATE INDEX idx_scheduled_tasks_scope_manual ON scheduled_tasks(scope_kind, scope_key, manual_fire_at);
CREATE INDEX idx_scheduled_runs_claim ON scheduled_runs(status, retry_at, lease_until, fire_at);
CREATE INDEX idx_scheduled_runs_task_status ON scheduled_runs(task_id, status, lease_until);
CREATE INDEX idx_scheduled_runs_delivery_ref ON scheduled_runs(delivery_ref);
`);
	db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEDULE_SCHEMA_VERSION));
}

function scheduleSchemaVersion(db: DatabaseSync): string | undefined {
	const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
	if (!hasMeta) return undefined;
	const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
	return row?.value;
}

function migrateScheduleV2ToV3(db: DatabaseSync): void {
	const unsupportedTargets = Number((db.prepare("SELECT COUNT(*) AS count FROM scheduled_tasks WHERE target_kind != 'main_thread'").get() as Record<string, unknown>).count ?? 0);
	if (unsupportedTargets > 0) throw new UnsupportedScheduleSchemaError("2 with unsupported targets");
	const unsupportedRuns = Number((db.prepare(`SELECT COUNT(*) AS count FROM scheduled_runs
WHERE status NOT IN ('pending', 'claimed', 'delivered', 'delivery_error', 'delivery_failed', 'missed', 'skipped')`).get() as Record<string, unknown>).count ?? 0);
	if (unsupportedRuns > 0) throw new UnsupportedScheduleSchemaError("2 with obsolete run states");
	const unsupportedTaskStatuses = Number((db.prepare(`SELECT COUNT(*) AS count FROM scheduled_tasks
WHERE last_status IS NOT NULL AND last_status NOT IN ('idle', 'waiting_idle', 'delivered', 'delivery_error', 'delivery_failed', 'missed', 'skipped')`).get() as Record<string, unknown>).count ?? 0);
	if (unsupportedTaskStatuses > 0) throw new UnsupportedScheduleSchemaError("2 with obsolete task states");
	const manualColumn = db.prepare("SELECT 1 FROM pragma_table_info('scheduled_tasks') WHERE name = 'manual_fire_at'").get();
	if (!manualColumn) db.exec("ALTER TABLE scheduled_tasks ADD COLUMN manual_fire_at INTEGER");
	db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_scope_manual ON scheduled_tasks(scope_kind, scope_key, manual_fire_at)");
	db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
}

function migrateScheduleV3ToV4(db: DatabaseSync): void {
	const invalidEnabled = Number((db.prepare("SELECT COUNT(*) AS count FROM scheduled_tasks WHERE enabled NOT IN (0, 1)").get() as Record<string, unknown>).count ?? 0);
	if (invalidEnabled > 0) throw new UnsupportedScheduleSchemaError("3 with invalid task state");
	db.exec(`
DROP INDEX IF EXISTS idx_scheduled_tasks_scope_next;
ALTER TABLE scheduled_tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'paused', 'completed', 'missed', 'failed', 'cancelled'));
ALTER TABLE scheduled_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
UPDATE scheduled_tasks SET status = CASE
  WHEN enabled = 1 THEN 'active'
  WHEN next_fire_at IS NOT NULL THEN 'paused'
  WHEN trigger_kind = 'once' AND last_status = 'missed' THEN 'missed'
  WHEN trigger_kind = 'once' AND last_status = 'delivery_failed' THEN 'failed'
  WHEN trigger_kind = 'once' AND last_status = 'skipped' THEN 'completed'
  WHEN trigger_kind != 'once' OR last_status = 'delivered' THEN 'completed'
  ELSE 'paused'
END;
ALTER TABLE scheduled_tasks DROP COLUMN enabled;
CREATE INDEX idx_scheduled_tasks_scope_next ON scheduled_tasks(scope_kind, scope_key, status, next_fire_at);
`);
	db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEDULE_SCHEMA_VERSION));
}

function initDb(db: DatabaseSync): void {
	if (scheduleSchemaVersion(db) === String(SCHEDULE_SCHEMA_VERSION)) return;
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		const version = scheduleSchemaVersion(db);
		if (version === String(SCHEDULE_SCHEMA_VERSION)) {
			db.exec("COMMIT");
			begun = false;
			return;
		}
		if (version === undefined) {
			const existingTables = Number((db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
WHERE type = 'table' AND name IN ('meta', 'scheduled_tasks', 'scheduled_runs')`).get() as Record<string, unknown>).count ?? 0);
			if (existingTables > 0) throw new UnsupportedScheduleSchemaError(undefined);
			createScheduleSchema(db);
		} else if (version === "2") {
			migrateScheduleV2ToV3(db);
			migrateScheduleV3ToV4(db);
		} else if (version === "3") {
			migrateScheduleV3ToV4(db);
		} else {
			throw new UnsupportedScheduleSchemaError(version);
		}
		db.exec("COMMIT");
		begun = false;
	} catch (error) {
		if (begun) db.exec("ROLLBACK");
		throw error;
	}
}

function dbString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function triggerToJson(trigger: Trigger): string {
	return JSON.stringify(trigger);
}

function targetToJson(target: Target): string {
	return JSON.stringify(target);
}

function triggerFromRow(kind: string, raw: string, timezone: string): Trigger {
	const data = parseJsonObject(raw);
	if (kind === "once") return { kind: "once", at: Number(data.at ?? 0) };
	if (kind === "interval") return { kind: "interval", everyMs: Number(data.everyMs ?? 0) };
	return { kind: "cron", expr: String(data.expr ?? ""), timezone: String(data.timezone ?? timezone) };
}

function targetFromRow(_kind: string, _raw: string): Target {
	return { kind: "main_thread" };
}

function rowToTask(row: Record<string, unknown>): ScheduleTask {
	const timezone = String(row.timezone || localTimezone());
	const targetKind = String(row.target_kind || "main_thread");
	if (targetKind !== "main_thread") throw new Error(`Unsupported schedule target: ${targetKind}`);
	return {
		id: String(row.id),
		scopeKind: String(row.scope_kind) as ScopeKind,
		scopeKey: String(row.scope_key),
		rawRequest: String(row.raw_request ?? ""),
		prompt: String(row.prompt ?? ""),
		trigger: triggerFromRow(String(row.trigger_kind), String(row.trigger_json ?? "{}"), timezone),
		target: targetFromRow(targetKind, String(row.target_json ?? "{}")),
		timezone,
		status: String(row.status || "paused") as ScheduleTaskStatus,
		revision: Number(row.revision ?? 0),
		nextFireAt: row.next_fire_at == null ? undefined : Number(row.next_fire_at),
		lastFireAt: row.last_fire_at == null ? undefined : Number(row.last_fire_at),
		runCount: Number(row.run_count ?? 0),
		overlapPolicy: String(row.overlap_policy || "skip") as ScheduleTask["overlapPolicy"],
		catchupPolicy: String(row.catchup_policy || "none") as ScheduleTask["catchupPolicy"],
		expiresAt: row.expires_at == null ? undefined : Number(row.expires_at),
		manualFireAt: row.manual_fire_at == null ? undefined : Number(row.manual_fire_at),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		lastStatus: dbString(row.last_status) as TaskLastStatus | undefined,
		lastError: dbString(row.last_error),
	};
}

function rowToRun(row: Record<string, unknown>): ScheduleRun {
	return {
		taskId: String(row.task_id),
		fireAt: Number(row.fire_at ?? 0),
		status: String(row.status || "pending") as RunStatus,
		retryAt: row.retry_at == null ? undefined : Number(row.retry_at),
		retryRemaining: Number(row.retry_remaining ?? 0),
		leaseUntil: row.lease_until == null ? undefined : Number(row.lease_until),
		deliveryRef: dbString(row.delivery_ref),
		deliveredAt: row.delivered_at == null ? undefined : Number(row.delivered_at),
		completionStatus: String(row.completion_status || "unknown") as CompletionStatus,
		completionAt: row.completion_at == null ? undefined : Number(row.completion_at),
		completionError: dbString(row.completion_error),
		lastError: dbString(row.last_error),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
	};
}

function listRunsForTask(db: DatabaseSync, taskId: string, limit = 5): ScheduleRun[] {
	const rows = db.prepare(`SELECT * FROM scheduled_runs WHERE task_id = ? ORDER BY fire_at DESC LIMIT ?`).all(taskId, limit) as Record<string, unknown>[];
	return rows.map(rowToRun);
}
function getRunForOccurrence(db: DatabaseSync, taskId: string, fireAt: number): ScheduleRun | undefined {
	const row = db.prepare("SELECT * FROM scheduled_runs WHERE task_id = ? AND fire_at = ?").get(taskId, fireAt) as Record<string, unknown> | undefined;
	return row ? rowToRun(row) : undefined;
}

function insertTask(db: DatabaseSync, task: ScheduleTask): void {
	db.prepare(`INSERT INTO scheduled_tasks (
  id, scope_kind, scope_key, raw_request, prompt, trigger_kind, trigger_json, target_kind, target_json,
  timezone, status, revision, next_fire_at, last_fire_at, run_count, overlap_policy, catchup_policy, expires_at, manual_fire_at,
  created_at, updated_at, last_status, last_error
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(
			task.id,
			task.scopeKind,
			task.scopeKey,
			task.rawRequest,
			task.prompt,
			task.trigger.kind,
			triggerToJson(task.trigger),
			task.target.kind,
			targetToJson(task.target),
			task.timezone,
			task.status,
			task.revision,
			task.nextFireAt ?? null,
			task.lastFireAt ?? null,
			task.runCount,
			task.overlapPolicy,
			task.catchupPolicy,
			task.expiresAt ?? null,
			task.manualFireAt ?? null,
			task.createdAt,
			task.updatedAt,
			task.lastStatus ?? null,
			task.lastError ?? null,
		);
}

function nextFireForRecurringTask(task: ScheduleTask, fromMs: number): number | undefined {
	if (task.trigger.kind === "once") return undefined;
	const next = computeNextFire(task.trigger, fromMs);
	if (next === undefined) return undefined;
	if (task.expiresAt !== undefined && next > task.expiresAt) return undefined;
	return next;
}

function updateTaskAfterDelivery(db: DatabaseSync, claim: ScheduleRunClaim): void {
	const { task, fireAt, manual } = claim;
	const now = Date.now();
	if (manual) {
		db.prepare(`UPDATE scheduled_tasks SET
  manual_fire_at = CASE WHEN manual_fire_at = ? THEN NULL ELSE manual_fire_at END,
  last_fire_at = ?, run_count = run_count + 1,
  revision = revision + 1, updated_at = ?, last_status = 'delivered', last_error = NULL
WHERE id = ?`)
			.run(fireAt, fireAt, now, task.id);
		return;
	}
	const nextFireAt = nextFireForRecurringTask(task, now);
	const nextStatus: ScheduleTaskStatus = task.trigger.kind === "once" || nextFireAt === undefined ? "completed" : "active";
	const completesPausedOneShot = task.trigger.kind === "once" ? 1 : 0;
	db.prepare(`UPDATE scheduled_tasks SET
  status = CASE
    WHEN status = 'active' AND next_fire_at = ? THEN ?
    WHEN status = 'paused' AND next_fire_at = ? AND ? = 1 THEN 'completed'
    ELSE status
  END,
  next_fire_at = CASE
    WHEN status = 'active' AND next_fire_at = ? THEN ?
    WHEN status = 'paused' AND next_fire_at = ? AND ? = 1 THEN NULL
    ELSE next_fire_at
  END,
  last_fire_at = ?, run_count = run_count + 1,
  revision = revision + 1, updated_at = ?, last_status = 'delivered', last_error = NULL
WHERE id = ?`)
		.run(fireAt, nextStatus, fireAt, completesPausedOneShot, fireAt, nextFireAt ?? null, fireAt, completesPausedOneShot, fireAt, now, task.id);
}

function updateTaskAfterTerminalDeliveryFailure(db: DatabaseSync, claim: ScheduleRunClaim, message: string): void {
	const { task, fireAt, manual } = claim;
	const now = Date.now();
	if (manual) {
		db.prepare(`UPDATE scheduled_tasks SET
  manual_fire_at = NULL, last_fire_at = ?, revision = revision + 1, updated_at = ?, last_status = 'delivery_failed', last_error = ?
WHERE id = ? AND manual_fire_at = ?`)
			.run(fireAt, now, message, task.id, fireAt);
		return;
	}
	const nextFireAt = nextFireForRecurringTask(task, now);
	const nextStatus: ScheduleTaskStatus = task.trigger.kind === "once" ? "failed" : nextFireAt === undefined ? "completed" : "active";
	db.prepare(`UPDATE scheduled_tasks SET
  status = CASE WHEN status = 'active' THEN ? ELSE status END,
  next_fire_at = CASE WHEN status = 'active' THEN ? ELSE next_fire_at END,
  last_fire_at = ?, revision = revision + 1, updated_at = ?, last_status = 'delivery_failed', last_error = ?
WHERE id = ? AND next_fire_at = ?`)
		.run(nextStatus, nextFireAt ?? null, fireAt, now, message, task.id, fireAt);
}

function recordRunDeliveredAndAdvanceTask(db: DatabaseSync, claim: ScheduleRunClaim): boolean {
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		const delivered = markRunDelivered(db, claim);
		if (delivered) updateTaskAfterDelivery(db, claim);
		db.exec("COMMIT");
		begun = false;
		return delivered;
	} catch (err) {
		if (begun) db.exec("ROLLBACK");
		throw err;
	}
}

function updateTaskAfterNonDelivery(
	db: DatabaseSync,
	task: ScheduleTask,
	fireAt: number,
	manual: boolean,
	status: "missed" | "skipped",
	reason: string,
): boolean {
	const now = Date.now();
	if (manual) {
		return db.prepare(`UPDATE scheduled_tasks SET
  manual_fire_at = NULL, last_fire_at = ?, revision = revision + 1, updated_at = ?, last_status = ?, last_error = ?
WHERE id = ? AND manual_fire_at = ?`)
			.run(fireAt, now, status, reason, task.id, fireAt).changes === 1;
	}
	const next = nextFireForRecurringTask(task, now);
	const nextStatus: ScheduleTaskStatus = task.trigger.kind === "once"
		? (status === "missed" ? "missed" : "completed")
		: next === undefined ? "completed" : "active";
	return db.prepare(`UPDATE scheduled_tasks SET
  status = CASE WHEN status = 'active' THEN ? ELSE status END,
  next_fire_at = CASE WHEN status = 'active' THEN ? ELSE next_fire_at END,
  last_fire_at = ?, revision = revision + 1, updated_at = ?, last_status = ?, last_error = ?
WHERE id = ? AND next_fire_at = ? AND status = 'active'`)
		.run(nextStatus, next ?? null, fireAt, now, status, reason, task.id, fireAt).changes === 1;
}

function deferRunUntilIdle(db: DatabaseSync, task: ScheduleTask, fireAt: number, manual: boolean): boolean {
	const occurrencePredicate = manual ? "status = ? AND manual_fire_at = ?" : "status = 'active' AND next_fire_at = ?";
	const occurrenceArgs = manual ? [task.status, fireAt] : [fireAt];
	const now = Date.now();
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		const current = db.prepare(`SELECT 1 FROM scheduled_tasks
WHERE id = ? AND revision = ? AND ${occurrencePredicate}`)
			.get(task.id, task.revision, ...occurrenceArgs);
		if (!current) {
			db.exec("COMMIT");
			begun = false;
			return false;
		}
		db.prepare(`INSERT OR IGNORE INTO scheduled_runs (
  task_id, fire_at, status, retry_remaining, completion_status, created_at, updated_at
) VALUES (?, ?, 'pending', ?, 'unknown', ?, ?)`).run(task.id, fireAt, DEFAULT_RETRY_REMAINING, now, now);
		if (task.lastStatus !== "waiting_idle") {
			db.prepare(`UPDATE scheduled_tasks SET
  last_status = 'waiting_idle', last_error = NULL, revision = revision + 1, updated_at = ?
WHERE id = ? AND revision = ? AND ${occurrencePredicate}`)
				.run(now, task.id, task.revision, ...occurrenceArgs);
		}
		db.exec("COMMIT");
		begun = false;
		return true;
	} catch (error) {
		if (begun) db.exec("ROLLBACK");
		throw error;
	}
}

type ScheduleUpdateAction = "pause" | "resume" | "cancel";

interface ScheduleUpdateResult {
	task: ScheduleTask;
	changed: boolean;
	inFlightRuns: number;
}

function inFlightRunCount(db: DatabaseSync, taskId: string, now = Date.now()): number {
	const row = db.prepare("SELECT COUNT(*) AS count FROM scheduled_runs WHERE task_id = ? AND status = 'claimed' AND lease_until > ?")
		.get(taskId, now) as Record<string, unknown>;
	return Number(row.count ?? 0);
}

function stopPendingRuns(db: DatabaseSync, taskId: string, reason: string, now: number): void {
	db.prepare(`UPDATE scheduled_runs SET
  status = 'skipped', worker_id = NULL, ownership_token = NULL, finished_at = ?, lease_until = NULL,
  retry_at = NULL, retry_remaining = 0, completion_status = 'not_applicable', completion_at = NULL,
  completion_error = NULL, updated_at = ?, last_error = ?
WHERE task_id = ?
  AND (status IN ('pending', 'delivery_error') OR (status = 'claimed' AND COALESCE(lease_until, 0) <= ?))`)
		.run(now, now, reason, taskId, now);
}

function updateScheduleTask(db: DatabaseSync, taskId: string, scope: Scope, action: ScheduleUpdateAction): ScheduleUpdateResult {
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		const task = getTask(db, taskId, scope);
		if (!task) throw new Error(`No scheduled task ${taskId}.`);
		if (action === "pause" && task.status === "paused" && task.manualFireAt === undefined) {
			db.exec("COMMIT");
			begun = false;
			return { task, changed: false, inFlightRuns: inFlightRunCount(db, taskId) };
		}
		if (action === "resume" && task.status === "active") {
			db.exec("COMMIT");
			begun = false;
			return { task, changed: false, inFlightRuns: inFlightRunCount(db, taskId) };
		}
		if (action === "cancel" && task.status === "cancelled") {
			db.exec("COMMIT");
			begun = false;
			return { task, changed: false, inFlightRuns: inFlightRunCount(db, taskId) };
		}
		if (action === "pause" && task.status !== "active" && !(task.status === "paused" && task.manualFireAt !== undefined)) {
			throw new Error(`Cannot pause ${taskId}: its status is ${task.status}.`);
		}
		if (action === "resume" && task.status !== "paused") throw new Error(`Cannot resume ${taskId}: its status is ${task.status}.`);
		if (action === "cancel" && task.status !== "active" && task.status !== "paused") {
			throw new Error(`Cannot cancel ${taskId}: its status is ${task.status}. Use /schedule clear completed to prune terminal schedules.`);
		}

		const now = Date.now();
		let nextFireAt = task.nextFireAt;
		if (action === "resume") {
			nextFireAt = task.trigger.kind === "once" ? (task.trigger.at > now ? task.trigger.at : undefined) : nextFireForRecurringTask(task, now);
			if (nextFireAt === undefined) throw new Error(`Cannot resume ${taskId}: its next fire time is in the past. Use /schedule run ${taskId} to run it now, or create a new schedule.`);
		}
		const nextStatus: ScheduleTaskStatus = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
		const changed = db.prepare(`UPDATE scheduled_tasks SET
  status = ?, next_fire_at = ?, manual_fire_at = CASE WHEN ? = 'active' THEN manual_fire_at ELSE NULL END,
  revision = revision + 1, updated_at = ?, last_error = NULL
WHERE id = ? AND scope_kind = ? AND scope_key = ? AND revision = ? AND status = ?`)
			.run(nextStatus, action === "cancel" ? null : nextFireAt ?? null, nextStatus, now, taskId, scope.kind, scope.key, task.revision, task.status).changes === 1;
		if (!changed) throw new Error(`Scheduled task ${taskId} changed concurrently; inspect it and retry.`);
		if (action !== "resume") stopPendingRuns(db, taskId, action === "pause" ? "schedule paused" : "schedule cancelled", now);
		const inFlightRuns = inFlightRunCount(db, taskId, now);
		const updated = getTask(db, taskId, scope)!;
		db.exec("COMMIT");
		begun = false;
		return { task: updated, changed: true, inFlightRuns };
	} catch (error) {
		if (begun) db.exec("ROLLBACK");
		throw error;
	}
}

function cancelAllSchedules(db: DatabaseSync, scope: Scope): { cancelled: number; inFlightRuns: number } {
	const now = Date.now();
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		const ids = db.prepare("SELECT id FROM scheduled_tasks WHERE scope_kind = ? AND scope_key = ? AND status IN ('active', 'paused')")
			.all(scope.kind, scope.key) as Array<{ id: string }>;
		for (const { id } of ids) stopPendingRuns(db, id, "schedule cancelled", now);
		const inFlightRuns = ids.reduce((count, { id }) => count + inFlightRunCount(db, id, now), 0);
		const cancelled = db.prepare(`UPDATE scheduled_tasks SET
  status = 'cancelled', next_fire_at = NULL, manual_fire_at = NULL,
  revision = revision + 1, updated_at = ?, last_error = NULL
WHERE scope_kind = ? AND scope_key = ? AND status IN ('active', 'paused')`)
			.run(now, scope.kind, scope.key).changes;
		db.exec("COMMIT");
		begun = false;
		return { cancelled, inFlightRuns };
	} catch (error) {
		if (begun) db.exec("ROLLBACK");
		throw error;
	}
}

function clearTerminalSchedules(db: DatabaseSync, scope: Scope, now = Date.now()): number {
	return db.prepare(`DELETE FROM scheduled_tasks
WHERE scope_kind = ? AND scope_key = ? AND status IN ('completed', 'missed', 'failed', 'cancelled')
  AND manual_fire_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM scheduled_runs
    WHERE task_id = scheduled_tasks.id AND status = 'claimed' AND COALESCE(lease_until, 0) > ?
  )`)
		.run(scope.kind, scope.key, now).changes;
}

function queueManualRun(db: DatabaseSync, taskId: string, scope: Scope, now = Date.now()): boolean {
	return db.prepare(`UPDATE scheduled_tasks SET manual_fire_at = ?, revision = revision + 1, updated_at = ?
WHERE id = ? AND scope_kind = ? AND scope_key = ? AND status != 'cancelled' AND manual_fire_at IS NULL`)
		.run(now, now, taskId, scope.kind, scope.key).changes === 1;
}

function getTask(db: DatabaseSync, taskId: string, scope?: Scope): ScheduleTask | undefined {
	const row = scope
		? db.prepare("SELECT * FROM scheduled_tasks WHERE id = ? AND scope_kind = ? AND scope_key = ?").get(taskId, scope.kind, scope.key)
		: db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId);
	return row ? rowToTask(row as Record<string, unknown>) : undefined;
}

function listTasks(db: DatabaseSync, scope: Scope, includeTerminal = true): ScheduleTask[] {
	const rows = db.prepare(`SELECT * FROM scheduled_tasks
WHERE scope_kind = ? AND scope_key = ? ${includeTerminal ? "" : "AND (status IN ('active', 'paused') OR manual_fire_at IS NOT NULL)"}
ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
  COALESCE(manual_fire_at, next_fire_at, 9223372036854775807) ASC, created_at DESC
LIMIT ?`).all(scope.kind, scope.key, MAX_LIST_ITEMS) as Record<string, unknown>[];
	return rows.map(rowToTask);
}

function dueTasks(db: DatabaseSync, scope: Scope, now: number): ScheduleTask[] {
	const rows = db.prepare(`SELECT * FROM scheduled_tasks
WHERE scope_kind = ? AND scope_key = ?
  AND ((status != 'cancelled' AND manual_fire_at IS NOT NULL AND manual_fire_at <= ?)
    OR (status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?))
ORDER BY CASE WHEN manual_fire_at IS NOT NULL AND manual_fire_at <= ? THEN manual_fire_at ELSE next_fire_at END ASC,
  created_at ASC
LIMIT 16`).all(scope.kind, scope.key, now, now, now) as Record<string, unknown>[];
	return rows.map(rowToTask);
}

function nextActiveFireAt(db: DatabaseSync, scope: Scope): number | undefined {
	const row = db.prepare(`SELECT MIN(fire_at) AS next_fire_at FROM (
  SELECT manual_fire_at AS fire_at FROM scheduled_tasks
  WHERE scope_kind = ? AND scope_key = ? AND status != 'cancelled' AND manual_fire_at IS NOT NULL
  UNION ALL
  SELECT next_fire_at AS fire_at FROM scheduled_tasks
  WHERE scope_kind = ? AND scope_key = ? AND status = 'active' AND next_fire_at IS NOT NULL
)`).get(scope.kind, scope.key, scope.kind, scope.key) as { next_fire_at?: number | null } | undefined;
	return row?.next_fire_at == null ? undefined : Number(row.next_fire_at);
}

function dueTasksBlockedUntil(db: DatabaseSync, scope: Scope, now: number): number | undefined {
	const rows = db.prepare(`WITH due AS (
  SELECT t.id,
    CASE WHEN t.manual_fire_at IS NOT NULL AND t.manual_fire_at <= ? THEN t.manual_fire_at ELSE t.next_fire_at END AS fire_at
  FROM scheduled_tasks t
  WHERE t.scope_kind = ? AND t.scope_key = ?
    AND ((t.status != 'cancelled' AND t.manual_fire_at IS NOT NULL AND t.manual_fire_at <= ?)
      OR (t.status = 'active' AND t.next_fire_at IS NOT NULL AND t.next_fire_at <= ?))
)
SELECT due.id, due.fire_at, r.status, r.retry_at, r.lease_until
FROM due
LEFT JOIN scheduled_runs r ON r.task_id = due.id AND r.fire_at = due.fire_at`)
		.all(now, scope.kind, scope.key, now, now) as Array<{
			id: string;
			fire_at: number;
			status?: string | null;
			retry_at?: number | null;
			lease_until?: number | null;
		}>;
	if (rows.length === 0) return undefined;

	let blockedUntil: number | undefined;
	for (const row of rows) {
		const leaseUntil = row.lease_until == null ? undefined : Number(row.lease_until);
		if (row.status === "claimed" && leaseUntil !== undefined && leaseUntil > now) {
			blockedUntil = blockedUntil === undefined ? leaseUntil : Math.min(blockedUntil, leaseUntil);
			continue;
		}
		const retryAt = row.retry_at == null ? undefined : Number(row.retry_at);
		if (retryAt === undefined || retryAt <= now) return undefined;
		blockedUntil = blockedUntil === undefined ? retryAt : Math.min(blockedUntil, retryAt);
	}
	return blockedUntil;
}

function nextSchedulerWakeAt(db: DatabaseSync, scope: Scope, now: number): number | undefined {
	const nextFireAt = nextActiveFireAt(db, scope);
	if (nextFireAt === undefined) return undefined;
	if (nextFireAt > now) return nextFireAt;
	return dueTasksBlockedUntil(db, scope, now) ?? now + IDLE_RETRY_MS;
}

function pruneRunHistory(db: DatabaseSync, now = Date.now()): void {
	const lastMaintenance = db.prepare("SELECT value FROM meta WHERE key = ?").get(RUN_RETENTION_META_KEY) as { value?: string } | undefined;
	if (lastMaintenance && now - Number(lastMaintenance.value) < RUN_RETENTION_MAINTENANCE_MS) return;
	const terminal = "'delivered', 'delivery_failed', 'missed', 'skipped'";
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		const currentMaintenance = db.prepare("SELECT value FROM meta WHERE key = ?").get(RUN_RETENTION_META_KEY) as { value?: string } | undefined;
		if (currentMaintenance && now - Number(currentMaintenance.value) < RUN_RETENTION_MAINTENANCE_MS) {
			db.exec("COMMIT");
			begun = false;
			return;
		}
		db.prepare(`DELETE FROM scheduled_runs
WHERE status IN (${terminal}) AND updated_at < ?`).run(now - RUN_RETENTION_MS);
		db.prepare(`DELETE FROM scheduled_runs WHERE rowid IN (
  SELECT rowid FROM (
    SELECT rowid,
      ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY fire_at DESC, updated_at DESC) AS ordinal
    FROM scheduled_runs
    WHERE status IN (${terminal})
  ) WHERE ordinal > ?
)`).run(MAX_TERMINAL_RUNS_PER_TASK);
		db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(RUN_RETENTION_META_KEY, String(now));
		db.exec("COMMIT");
		begun = false;
	} catch (error) {
		if (begun) db.exec("ROLLBACK");
		throw error;
	}
}

function nextRunRetentionAt(db: DatabaseSync, now = Date.now()): number {
	const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(RUN_RETENTION_META_KEY) as { value?: string } | undefined;
	const last = Number(row?.value);
	return Number.isFinite(last) ? Math.max(now, last + RUN_RETENTION_MAINTENANCE_MS) : now;
}

function clearRetentionTimer(): void {
	if (retentionTimer) clearTimeout(retentionTimer);
	retentionTimer = undefined;
}

function armRetentionTimer(db: DatabaseSync, now = Date.now()): void {
	if (!currentSession) return;
	clearRetentionTimer();
	const delay = Math.max(0, Math.min(nextRunRetentionAt(db, now) - now, MAX_TIMER_DELAY_MS));
	retentionTimer = setTimeout(runRetentionMaintenance, delay);
	retentionTimer.unref?.();
}

function runRetentionMaintenance(): void {
	retentionTimer = undefined;
	if (!currentSession) return;
	try {
		const db = openDb();
		try {
			const now = Date.now();
			pruneRunHistory(db, now);
			armRetentionTimer(db, now);
		} finally { db.close(); }
	} catch {
		retentionTimer = setTimeout(runRetentionMaintenance, POLL_ERROR_RETRY_MS);
		retentionTimer.unref?.();
	}
}

function hasActiveRun(db: DatabaseSync, task: ScheduleTask, now: number, excludingFireAt?: number): boolean {
	const claimed = db.prepare(`SELECT 1 FROM scheduled_runs
WHERE task_id = ? AND status = 'claimed' AND lease_until IS NOT NULL AND lease_until > ?
  AND (? IS NULL OR fire_at != ?)
LIMIT 1`).get(task.id, now, excludingFireAt ?? null, excludingFireAt ?? null);
	return Boolean(claimed);
}

function claimRun(db: DatabaseSync, task: ScheduleTask, fireAt: number, workerId: string, manual: boolean): ScheduleRunClaim | undefined {
	const now = Date.now();
	const ownershipToken = randomUUID();
	const leaseUntil = now + DEFAULT_LEASE_MS;
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		const current = db.prepare("SELECT status, next_fire_at, manual_fire_at FROM scheduled_tasks WHERE id = ?").get(task.id) as { status?: string; next_fire_at?: number | null; manual_fire_at?: number | null } | undefined;
		const stillRunnable = manual
			? current?.status !== "cancelled" && Number(current?.manual_fire_at) === fireAt
			: current?.status === "active" && Number(current.next_fire_at) === fireAt;
		if (!stillRunnable) {
			db.exec("COMMIT");
			begun = false;
			return undefined;
		}
		const scopeBusy = db.prepare(`SELECT 1 FROM scheduled_runs r
JOIN scheduled_tasks t ON t.id = r.task_id
WHERE t.scope_kind = ? AND t.scope_key = ?
  AND r.status = 'claimed' AND r.lease_until IS NOT NULL AND r.lease_until > ?
  AND NOT (r.task_id = ? AND r.fire_at = ?)
LIMIT 1`).get(task.scopeKind, task.scopeKey, now, task.id, fireAt);
		if (scopeBusy) {
			db.exec("COMMIT");
			begun = false;
			return undefined;
		}
		db.prepare(`INSERT OR IGNORE INTO scheduled_runs (
  task_id, fire_at, status, retry_remaining, completion_status, created_at, updated_at
) VALUES (?, ?, 'pending', ?, 'unknown', ?, ?)`)
			.run(task.id, fireAt, DEFAULT_RETRY_REMAINING, now, now);

		const changes = db.prepare(`UPDATE scheduled_runs SET
  status = 'claimed', worker_id = ?, ownership_token = ?, started_at = ?, finished_at = NULL,
  lease_until = ?, retry_at = NULL, delivered_at = NULL, delivery_ref = NULL,
  completion_status = 'unknown', completion_at = NULL, completion_error = NULL,
  updated_at = ?, last_error = NULL
WHERE task_id = ? AND fire_at = ?
  AND (status = 'pending' OR status = 'delivery_error' OR (status = 'claimed' AND (lease_until IS NULL OR lease_until <= ?)))
  AND (retry_at IS NULL OR retry_at <= ?)
  AND retry_remaining > 0`)
			.run(workerId, ownershipToken, now, leaseUntil, now, task.id, fireAt, now, now).changes;
		db.exec("COMMIT");
		begun = false;
		return changes > 0 ? { task, fireAt, ownershipToken, manual } : undefined;
	} catch (err) {
		if (begun) db.exec("ROLLBACK");
		throw err;
	}
}

function renewClaimLease(db: DatabaseSync, claim: ScheduleRunClaim, now = Date.now()): boolean {
	return db.prepare(`UPDATE scheduled_runs SET lease_until = ?, updated_at = ?
WHERE task_id = ? AND fire_at = ? AND status = 'claimed' AND ownership_token = ?
  AND lease_until IS NOT NULL AND lease_until > ?`)
		.run(now + DEFAULT_LEASE_MS, now, claim.task.id, claim.fireAt, claim.ownershipToken, now).changes === 1;
}

function claimStillRunnable(db: DatabaseSync, claim: ScheduleRunClaim): boolean {
	const row = db.prepare("SELECT status, next_fire_at, manual_fire_at FROM scheduled_tasks WHERE id = ?").get(claim.task.id) as { status?: string; next_fire_at?: number | null; manual_fire_at?: number | null } | undefined;
	return claim.manual
		? row?.status !== "cancelled" && Number(row?.manual_fire_at) === claim.fireAt
		: row?.status === "active" && Number(row.next_fire_at) === claim.fireAt;
}

function skipClaim(db: DatabaseSync, claim: ScheduleRunClaim, reason: string, now: number): void {
	db.prepare(`UPDATE scheduled_runs SET
  status = 'skipped', worker_id = NULL, ownership_token = NULL, finished_at = ?, lease_until = NULL,
  retry_at = NULL, retry_remaining = 0, delivered_at = NULL, delivery_ref = NULL,
  completion_status = 'not_applicable', completion_at = NULL, completion_error = NULL,
  updated_at = ?, last_error = ?
WHERE task_id = ? AND fire_at = ? AND status = 'claimed' AND ownership_token = ?`)
		.run(now, now, reason, claim.task.id, claim.fireAt, claim.ownershipToken);
}

function releaseRunForIdle(db: DatabaseSync, claim: ScheduleRunClaim): void {
	const now = Date.now();
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		if (!claimStillRunnable(db, claim)) {
			skipClaim(db, claim, "schedule changed before idle delivery", now);
		} else {
			db.prepare(`UPDATE scheduled_runs SET
  status = 'pending', worker_id = NULL, ownership_token = NULL, lease_until = NULL,
  retry_at = ?, updated_at = ?, last_error = ?
WHERE task_id = ? AND fire_at = ? AND status = 'claimed' AND ownership_token = ?`)
				.run(now + IDLE_RETRY_MS, now, "thread_not_idle", claim.task.id, claim.fireAt, claim.ownershipToken);
		}
		db.exec("COMMIT");
		begun = false;
	} catch (error) {
		if (begun) db.exec("ROLLBACK");
		throw error;
	}
}

function markRunDelivered(db: DatabaseSync, claim: ScheduleRunClaim): boolean {
	const now = Date.now();
	const rows = db.prepare(`UPDATE scheduled_runs SET
  status = 'delivered', delivered_at = ?, delivery_ref = ?, finished_at = ?, lease_until = NULL,
  retry_at = NULL, completion_status = 'unknown', completion_at = NULL, completion_error = NULL,
  updated_at = ?, last_error = NULL
WHERE task_id = ? AND fire_at = ? AND status = 'claimed' AND ownership_token = ?`)
		.run(now, `${claim.task.id}:${claim.fireAt}`, now, now, claim.task.id, claim.fireAt, claim.ownershipToken).changes;
	return rows > 0;
}

function markRunDeliveryFailed(db: DatabaseSync, claim: ScheduleRunClaim, error: unknown): void {
	const now = Date.now();
	const message = error instanceof Error ? error.message : String(error);
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		if (!claimStillRunnable(db, claim)) {
			skipClaim(db, claim, `schedule changed after delivery failure: ${message}`, now);
			db.exec("COMMIT");
			begun = false;
			return;
		}
		const runChanged = db.prepare(`UPDATE scheduled_runs SET
  status = CASE WHEN retry_remaining <= 1 THEN 'delivery_failed' ELSE 'delivery_error' END,
  finished_at = ?, lease_until = NULL, retry_at = ?, retry_remaining = max(retry_remaining - 1, 0),
  completion_status = 'not_applicable', completion_at = NULL, completion_error = NULL,
  updated_at = ?, last_error = ?
WHERE task_id = ? AND fire_at = ? AND status = 'claimed' AND ownership_token = ?`)
			.run(now, now + DEFAULT_RETRY_DELAY_MS, now, message, claim.task.id, claim.fireAt, claim.ownershipToken).changes;
		if (runChanged !== 1) {
			db.exec("COMMIT");
			begun = false;
			return;
		}
		const row = db.prepare("SELECT status FROM scheduled_runs WHERE task_id = ? AND fire_at = ?").get(claim.task.id, claim.fireAt) as { status?: string } | undefined;
		if (row?.status === "delivery_failed") {
			updateTaskAfterTerminalDeliveryFailure(db, claim, message);
		} else {
			db.prepare("UPDATE scheduled_tasks SET last_status = 'delivery_error', last_error = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
				.run(message, now, claim.task.id);
		}
		db.exec("COMMIT");
		begun = false;
	} catch (err) {
		if (begun) db.exec("ROLLBACK");
		throw err;
	}
}

function markRunNonDelivery(
	db: DatabaseSync,
	task: ScheduleTask,
	fireAt: number,
	manual: boolean,
	status: "missed" | "skipped",
	reason: string,
): boolean {
	const now = Date.now();
	let begun = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		begun = true;
		const runChanged = db.prepare(`INSERT INTO scheduled_runs (
  task_id, fire_at, status, retry_remaining, completion_status, last_error, created_at, updated_at, finished_at
) VALUES (?, ?, ?, 0, 'not_applicable', ?, ?, ?, ?)
ON CONFLICT(task_id, fire_at) DO UPDATE SET
  status = excluded.status, worker_id = NULL, ownership_token = NULL,
  started_at = NULL, finished_at = excluded.finished_at, lease_until = NULL, retry_at = NULL,
  retry_remaining = 0, delivered_at = NULL, delivery_ref = NULL,
  completion_status = 'not_applicable', completion_at = NULL, completion_error = NULL,
  last_error = excluded.last_error, updated_at = excluded.updated_at
WHERE scheduled_runs.status IN ('pending', 'delivery_error')`)
			.run(task.id, fireAt, status, reason, now, now, now).changes === 1;
		if (!runChanged || !updateTaskAfterNonDelivery(db, task, fireAt, manual, status, reason)) {
			db.exec("ROLLBACK");
			begun = false;
			return false;
		}
		db.exec("COMMIT");
		begun = false;
		return true;
	} catch (error) {
		if (begun) db.exec("ROLLBACK");
		throw error;
	}
}

function markRunSkipped(db: DatabaseSync, task: ScheduleTask, fireAt: number, manual: boolean, reason: string): boolean {
	return markRunNonDelivery(db, task, fireAt, manual, "skipped", reason);
}

function markRunMissed(db: DatabaseSync, task: ScheduleTask, fireAt: number, manual: boolean, reason: string): boolean {
	return markRunNonDelivery(db, task, fireAt, manual, "missed", reason);
}

function isMisfired(task: ScheduleTask, fireAt: number, now: number): boolean {
	return now - fireAt > DEFAULT_MISFIRE_GRACE_MS && task.catchupPolicy !== "one";
}

function applyMisfirePolicy(db: DatabaseSync, task: ScheduleTask, fireAt: number, manual: boolean, now: number): { applied: boolean; reason: string } | undefined {
	if (manual) return undefined;
	if (!isMisfired(task, fireAt, now)) return undefined;
	const age = formatDuration(now - fireAt);
	const reason = task.trigger.kind === "once"
		? `missed one-shot fire time by ${age}; not run automatically`
		: `missed recurring fire time by ${age}; skipped to next future occurrence`;
	return { applied: markRunMissed(db, task, fireAt, manual, reason), reason };
}

function localTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}

function sessionScope(ctx: ExtensionContext): Scope {
	const id = ctx.sessionManager.getSessionId();
	return { kind: "thread", key: id, label: `thread ${id.slice(0, 8)}` };
}

function hasPersistentSession(ctx: ExtensionContext | ExtensionCommandContext): boolean {
	return Boolean(ctx.sessionManager.getSessionFile());
}

function workerId(ctx: ExtensionContext): string {
	return `${ctx.sessionManager.getSessionId()}:${process.pid}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonParse(text: string): unknown {
	try { return JSON.parse(text); } catch { return undefined; }
}

function extractJsonObject(text: string): unknown {
	const direct = safeJsonParse(text.trim());
	if (direct !== undefined) return direct;
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fenced) {
		const parsed = safeJsonParse(fenced[1]!.trim());
		if (parsed !== undefined) return parsed;
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) return safeJsonParse(text.slice(start, end + 1));
	return undefined;
}

function selectParserModel(ctx: ExtensionContext): Model<Api> | undefined {
	const configured = process.env.PI_SCHEDULE_MODEL;
	if (configured) {
		const splitAt = configured.indexOf("/");
		if (splitAt > 0) {
			const provider = configured.slice(0, splitAt);
			const id = configured.slice(splitAt + 1);
			const model = ctx.modelRegistry.find(provider, id);
			if (model) return model as Model<Api>;
		} else {
			const model = ctx.modelRegistry.getAll().find((candidate) => candidate.id === configured || candidate.name === configured);
			if (model) return model as Model<Api>;
		}
		throw new Error(`Configured schedule parser model not found: ${configured}`);
	}
	const available = ctx.modelRegistry.getAvailable() as Model<Api>[];
	const preferred = available.find((candidate) => candidate.provider === "openrouter" && candidate.id === "openai/gpt-4o-mini")
		?? available.find((candidate) => candidate.provider === "openrouter" && candidate.id.toLowerCase().includes("gpt-4o-mini"))
		?? available.find((candidate) => candidate.id.toLowerCase().includes("gpt-4o-mini") && candidate.provider !== "cloudflare-ai-gateway")
		?? available.find((candidate) => candidate.id.toLowerCase().includes("gpt-4o-mini"))
		?? available.find((candidate) => candidate.input?.includes("text") && candidate.reasoning === false)
		?? (ctx.model as Model<Api> | undefined)
		?? available[0];
	return preferred;
}

function parserResponseFormatEnabled(model: Model<Api>): boolean {
	const configured = process.env.PI_SCHEDULE_RESPONSE_FORMAT;
	if (configured !== undefined) return !["0", "false", "off", "no"].includes(configured.trim().toLowerCase());
	// gpt-5.5 through the Codex Responses compatibility path can return an empty
	// content array for tiny structured-output calls. Keep JSON-schema payload
	// injection available for providers that handle it well, but prefer the
	// prompt-only JSON contract on the Codex Responses path until Pi core exposes
	// a first-class structured-output helper.
	return String(model.api ?? "") !== "openai-codex-responses";
}

function withStructuredParserPayload(payload: unknown, model: Model<Api>): unknown | undefined {
	const api = String(model.api ?? "");
	if (api === "openai-completions" && isRecord(payload) && Array.isArray(payload.messages)) {
		return {
			...payload,
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "pi_schedule_parse",
					strict: true,
					schema: SCHEDULE_PARSE_JSON_SCHEMA,
				},
			},
		};
	}
	if (["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(api) && isRecord(payload) && Array.isArray(payload.input)) {
		const text = isRecord(payload.text) ? payload.text : {};
		return {
			...payload,
			text: {
				...text,
				format: {
					type: "json_schema",
					name: "pi_schedule_parse",
					strict: true,
					schema: SCHEDULE_PARSE_JSON_SCHEMA,
				},
			},
		};
	}
	return undefined;
}

async function parseWithAi(args: string, ctx: ExtensionContext): Promise<unknown> {
	const model = selectParserModel(ctx);
	if (!model) throw new Error("No model selected for schedule parsing");
	debugLog({ event: "parser_model", provider: model.provider, id: model.id, api: model.api, reasoning: model.reasoning });
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Schedule parser auth failed for ${model.provider}/${model.id}: ${auth.error}`);
	const now = new Date();
	const timezone = localTimezone();
	const systemPrompt = `You are Pi's schedule parser. Convert one /schedule request into strict JSON.\n\nRules:\n- Return JSON only. Do not create schedules and do not call tools.\n- Always include top-level fields: action, prompt, question, runImmediately, timezone, trigger. Use null inside fields that do not apply.\n- Always include trigger fields: kind, at, everyMs, expr, timezone. Use kind="none" for clarify.\n- Do not include a target field. The only supported target is the current main thread.\n- If the user asks to manage existing schedules (list schedules, cancel/pause/resume/run an id), return action="clarify"; deterministic command code handles management verbs. A slash command embedded as the future task is not schedule management.\n- When the future task asks Pi to type, run, execute, or invoke a slash command, set prompt to only that exact slash-command line. Example: wake up every 5 minutes then type \"/goal resume\" for me -> prompt="/goal resume", interval 300000ms.\n- For create, remove scheduling words from prompt and preserve the actual future task verbatim.\n- Use action="clarify" if no concrete time trigger is present, if the request is ambiguous, or if it asks for an agent/subagent target.\n- Use trigger.kind="once" for "in 5 minutes", "tomorrow at 9", "at 3pm". ` +
		`Use ISO 8601 with offset in trigger.at. Current time is ${now.toISOString()} (${timezone}).\n` +
		`- Use trigger.kind="interval" for simple repeated intervals like "every 30 seconds". The interval must be positive.\n` +
		`- Use trigger.kind="cron" only for calendar recurrences (weekdays at 9am, daily at 17:30). Cron is 5-field local time: minute hour day-of-month month day-of-week.\n` +
		`- Do not treat phrases like "check every PR" as a time interval.\n` +
		`- runImmediately is true only if the user explicitly says now, starting now, also run now, or immediately.\n` +
		`- Do not create subagent/agent-target schedules; return action="clarify" for those requests.`;
	const response = await complete(
		model,
		{
			systemPrompt,
			messages: [{ role: "user", content: [{ type: "text", text: args }], timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: 4000,
			reasoning: "minimal",
			temperature: 0,
			...(parserResponseFormatEnabled(model) ? { onPayload: (payload: unknown) => withStructuredParserPayload(payload, model) } : {}),
		},
	);
	debugLog({ event: "parser_response", contentTypes: response.content.map((content) => content.type), usage: response.usage });
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("Schedule parser returned no final text");
	const parsed = extractJsonObject(text);
	if (parsed === undefined) throw new Error("Schedule parser returned invalid JSON");
	return parsed;
}

function normalizeUnit(unit: string): number | undefined {
	const u = unit.toLowerCase();
	if (["s", "sec", "secs", "second", "seconds"].includes(u)) return 1000;
	if (["m", "min", "mins", "minute", "minutes"].includes(u)) return 60_000;
	if (["h", "hr", "hrs", "hour", "hours"].includes(u)) return 3_600_000;
	if (["d", "day", "days"].includes(u)) return 86_400_000;
	return undefined;
}

function durationMs(amount: string, unit: string): number | undefined {
	const n = Number.parseInt(amount, 10);
	const mul = normalizeUnit(unit);
	if (!Number.isFinite(n) || n <= 0 || mul === undefined) return undefined;
	return n * mul;
}

function parseClockTime(value: string): { hour: number; minute: number } | undefined {
	const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
	if (!match) return undefined;
	let hour = Number.parseInt(match[1]!, 10);
	const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
	const ampm = match[3];
	if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return undefined;
	if (ampm) {
		if (hour < 1 || hour > 12) return undefined;
		if (ampm === "am") hour = hour === 12 ? 0 : hour;
		if (ampm === "pm") hour = hour === 12 ? 12 : hour + 12;
	} else if (hour < 0 || hour > 23) {
		return undefined;
	}
	return { hour, minute };
}

function dateWithClock(dayOffset: number, clock: { hour: number; minute: number }): number {
	const date = new Date();
	date.setDate(date.getDate() + dayOffset);
	date.setHours(clock.hour, clock.minute, 0, 0);
	return date.getTime();
}

function nextAtClock(clock: { hour: number; minute: number }): number {
	let at = dateWithClock(0, clock);
	if (at <= Date.now()) at = dateWithClock(1, clock);
	return at;
}

function normalizePromptText(value: string): string {
	return value.replace(/^,\s*/, "").replace(/^then\s+/i, "").trim();
}

function requestsUnsupportedAgentTarget(value: string): boolean {
	const text = value.replace(/\bsub-agent\b/gi, "subagent");
	const namedAgent = /\b(?:use|using|with|via)\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9_-]*)\s+agent\b/i.exec(text);
	if (namedAgent) {
		const name = namedAgent[1]!.toLowerCase();
		if (!["user", "browser", "http", "https", "mobile", "desktop", "software", "customer", "support"].includes(name)) return true;
	}
	return /\b(?:use|using|with|via)\s+(?:the\s+|a\s+|an\s+)?subagent\b/i.test(text)
		|| /\b(?:use|using|with|via)\s+(?:the\s+|a\s+|an\s+)?agent\s+[A-Za-z][A-Za-z0-9_-]*\b/i.test(text)
		|| /\b(?:agent|subagent)\s+target\b/i.test(text);
}

function fallbackCreateResult(promptInput: string, trigger: Trigger): ParsedSchedule {
	const prompt = normalizePromptText(promptInput);
	return validateParsedSchedule({ action: "create", prompt, trigger, target: { kind: "main_thread" }, runImmediately: false, timezone: localTimezone() });
}


function fallbackParseCalendar(args: string): ParsedSchedule | undefined {
	const input = args.trim();
	const timeToken = "(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)";
	const tomorrowLeading = new RegExp(`^tomorrow(?:\\s+at)?\\s+${timeToken}[,\\s]+(.+)$`, "i").exec(input);
	if (tomorrowLeading) {
		const clock = parseClockTime(tomorrowLeading[1]!);
		const prompt = normalizePromptText(tomorrowLeading[2]!);
		if (clock && prompt) return fallbackCreateResult(prompt, { kind: "once", at: dateWithClock(1, clock) });
	}
	const tomorrowTrailing = new RegExp(`^(.+?)\\s+tomorrow(?:\\s+at)?\\s+${timeToken}$`, "i").exec(input);
	if (tomorrowTrailing) {
		const clock = parseClockTime(tomorrowTrailing[2]!);
		const prompt = normalizePromptText(tomorrowTrailing[1]!);
		if (clock && prompt) return fallbackCreateResult(prompt, { kind: "once", at: dateWithClock(1, clock) });
	}
	const atLeading = new RegExp(`^(?:today\\s+)?at\\s+${timeToken}[,\\s]+(.+)$`, "i").exec(input);
	if (atLeading) {
		const clock = parseClockTime(atLeading[1]!);
		const prompt = normalizePromptText(atLeading[2]!);
		if (clock && prompt) return fallbackCreateResult(prompt, { kind: "once", at: nextAtClock(clock) });
	}
	const atTrailing = new RegExp(`^(.+?)\\s+(?:today\\s+)?at\\s+${timeToken}$`, "i").exec(input);
	if (atTrailing) {
		const clock = parseClockTime(atTrailing[2]!);
		const prompt = normalizePromptText(atTrailing[1]!);
		if (clock && prompt) return fallbackCreateResult(prompt, { kind: "once", at: nextAtClock(clock) });
	}
	const recurringLeading = new RegExp(`^(daily|every day|every weekday|weekdays)(?:\\s+at)?\\s+${timeToken}[,\\s]+(.+)$`, "i").exec(input);
	if (recurringLeading) {
		const clock = parseClockTime(recurringLeading[2]!);
		const prompt = normalizePromptText(recurringLeading[3]!);
		if (clock && prompt) {
			const dow = /weekday/i.test(recurringLeading[1]!) ? "1-5" : "*";
			return fallbackCreateResult(prompt, { kind: "cron", expr: `${clock.minute} ${clock.hour} * * ${dow}`, timezone: localTimezone() });
		}
	}
	const recurringTrailing = new RegExp(`^(.+?)\\s+(daily|every day|every weekday|weekdays)(?:\\s+at)?\\s+${timeToken}$`, "i").exec(input);
	if (recurringTrailing) {
		const clock = parseClockTime(recurringTrailing[3]!);
		const prompt = normalizePromptText(recurringTrailing[1]!);
		if (clock && prompt) {
			const dow = /weekday/i.test(recurringTrailing[2]!) ? "1-5" : "*";
			return fallbackCreateResult(prompt, { kind: "cron", expr: `${clock.minute} ${clock.hour} * * ${dow}`, timezone: localTimezone() });
		}
	}
	return undefined;
}

function fallbackParseCreate(args: string): ParsedSchedule | undefined {
	const input = args.trim();
	const calendar = fallbackParseCalendar(input);
	if (calendar) return calendar;
	const everyLeading = /^every\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s+(.+)$/i.exec(input);
	if (everyLeading) {
		const everyMs = durationMs(everyLeading[1]!, everyLeading[2]!);
		if (everyMs !== undefined) {
			return fallbackCreateResult(everyLeading[3]!.trim(), { kind: "interval", everyMs });
		}
	}
	const everyTrailing = /^(.+?)\s+every\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i.exec(input);
	if (everyTrailing) {
		const everyMs = durationMs(everyTrailing[2]!, everyTrailing[3]!);
		if (everyMs !== undefined) {
			return fallbackCreateResult(everyTrailing[1]!.trim(), { kind: "interval", everyMs });
		}
	}
	const inLeading = /^in\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)[,\s]+(.+)$/i.exec(input);
	if (inLeading) {
		const ms = durationMs(inLeading[1]!, inLeading[2]!);
		if (ms !== undefined) {
			return fallbackCreateResult(inLeading[3]!.trim(), { kind: "once", at: Date.now() + ms });
		}
	}
	const inTrailing = /^(.+?)\s+(?:in|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i.exec(input)
		|| /^(.+?)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s+later$/i.exec(input);
	if (inTrailing) {
		const ms = durationMs(inTrailing[2]!, inTrailing[3]!);
		if (ms !== undefined) {
			return fallbackCreateResult(inTrailing[1]!.trim(), { kind: "once", at: Date.now() + ms });
		}
	}
	return undefined;
}

function normalizeParsed(raw: unknown): ParsedSchedule {
	if (!isRecord(raw)) return { action: "clarify", question: "I couldn't parse that schedule request. Try: /schedule check deploy in 5 minutes" };
	if (raw.action === "clarify") {
		return { action: "clarify", question: typeof raw.question === "string" && raw.question.trim() ? raw.question.trim() : "When should I run this?" };
	}
	if (raw.action !== "create") return { action: "clarify", question: "I couldn't find a schedule to create." };
	return validateParsedSchedule(raw);
}

function validateParsedSchedule(raw: Record<string, unknown>): ParsedSchedule {
	const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
	if (!prompt) return { action: "clarify", question: "What should I run when the schedule fires?" };
	if ([...prompt].length > MAX_PROMPT_CHARS) {
		return { action: "clarify", question: `Scheduled prompts are limited to ${MAX_PROMPT_CHARS.toLocaleString()} characters. Put longer instructions in a file and schedule a prompt that references it.` };
	}
	const timezone = typeof raw.timezone === "string" && raw.timezone.trim() ? raw.timezone.trim() : localTimezone();
	const triggerRaw = raw.trigger;
	if (!isRecord(triggerRaw) || typeof triggerRaw.kind !== "string") {
		return { action: "clarify", question: "When should I run this? Try: /schedule check deploy in 5 minutes" };
	}
	let trigger: Trigger | undefined;
	if (triggerRaw.kind === "once") {
		const atRaw = triggerRaw.at;
		const at = typeof atRaw === "number" ? atRaw : Date.parse(String(atRaw ?? ""));
		if (!Number.isFinite(at)) return { action: "clarify", question: "I couldn't understand the one-time date/time. Try: /schedule check deploy in 5 minutes" };
		trigger = { kind: "once", at };
	} else if (triggerRaw.kind === "interval") {
		const everyMs = Number(triggerRaw.everyMs);
		if (!Number.isFinite(everyMs) || everyMs <= 0) {
			return { action: "clarify", question: "Recurring schedules need a positive interval." };
		}
		trigger = { kind: "interval", everyMs: Math.max(1, Math.round(everyMs)) };
	} else if (triggerRaw.kind === "cron") {
		const expr = typeof triggerRaw.expr === "string" ? triggerRaw.expr.trim() : "";
		if (!parseCronExpression(expr)) return { action: "clarify", question: `Invalid cron expression "${expr}". Use 5 fields: minute hour day-of-month month day-of-week.` };
		if (nextCronRunMs(expr, Date.now()) === null) return { action: "clarify", question: `Cron expression "${expr}" has no run in the next year.` };
		const cronTimezone = typeof triggerRaw.timezone === "string" && triggerRaw.timezone.trim() ? triggerRaw.timezone.trim() : timezone;
		const machineTimezone = localTimezone();
		if (cronTimezone !== machineTimezone && cronTimezone !== "local") {
			return { action: "clarify", question: `Timezone "${cronTimezone}" is not supported for recurring schedules yet. This Pi instance can schedule cron recurrences in ${machineTimezone}.` };
		}
		trigger = { kind: "cron", expr, timezone: cronTimezone };
	} else {
		return { action: "clarify", question: "I couldn't identify whether this is one-shot, interval, or cron." };
	}
	const targetRaw = raw.target;
	if (isRecord(targetRaw) && targetRaw.kind === "subagent") {
		return { action: "clarify", question: "Scheduled subagents are not supported. Create this as a main-thread schedule instead." };
	}
	if (isRecord(targetRaw) && typeof targetRaw.kind === "string" && targetRaw.kind !== "main_thread") {
		return { action: "clarify", question: "The only supported schedule target is the main thread." };
	}
	const target: Target = { kind: "main_thread" };
	return {
		action: "create",
		prompt,
		trigger,
		target,
		runImmediately: raw.runImmediately === true,
		timezone,
	};
}

async function parseScheduleCreate(args: string, ctx: ExtensionContext): Promise<ParsedSchedule> {
	if (requestsUnsupportedAgentTarget(args)) {
		return { action: "clarify", question: "Scheduled subagents are not supported. Create this as a main-thread schedule instead, or omit the agent/subagent target." };
	}
	const deterministicFallback = fallbackParseCreate(args);
	if (deterministicFallback) return deterministicFallback;
	try {
		const parsed = normalizeParsed(await parseWithAi(args, ctx));
		return parsed;
	} catch (err) {
		return {
			action: "clarify",
			question: `${err instanceof Error ? err.message : String(err)}. Try: /schedule check deploy in 5 minutes`,
		};
	}
}

function computeNextFire(trigger: Trigger, fromMs: number): number | undefined {
	if (trigger.kind === "once") return trigger.at;
	if (trigger.kind === "interval") return fromMs + trigger.everyMs;
	return nextCronRunMs(trigger.expr, fromMs) ?? undefined;
}

function formatTrigger(trigger: Trigger): string {
	if (trigger.kind === "once") return `once at ${new Date(trigger.at).toLocaleString()}`;
	if (trigger.kind === "interval") return `every ${formatDuration(trigger.everyMs)}`;
	return `cron ${trigger.expr}`;
}

function formatTarget(_target: Target): string {
	return "main thread";
}

function formatDuration(ms: number): string {
	const units: Array<[number, string]> = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"], [1000, "s"]];
	for (const [unitMs, label] of units) {
		if (ms >= unitMs && ms % unitMs === 0) return `${ms / unitMs}${label}`;
	}
	return `${Math.round(ms / 1000)}s`;
}

function formatRelativeTime(at: number, now = Date.now()): string {
	const delta = at - now;
	const abs = Math.abs(delta);
	const suffix = delta >= 0 ? "" : " ago";
	if (abs < 60_000) return delta >= 0 ? "<1m" : "just now";
	if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m${suffix}`;
	if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h${suffix}`;
	return new Date(at).toLocaleString();
}

function shortPrompt(prompt: string, max = 48): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function createTaskId(db: DatabaseSync): string {
	for (let attempt = 0; attempt < 10; attempt++) {
		const id = randomUUID().replaceAll("-", "").slice(0, 12);
		if (!getTask(db, id)) return id;
	}
	throw new Error("Could not allocate a unique schedule id");
}

function createTaskFromParsed(db: DatabaseSync, parsed: ParsedScheduleCreate, rawRequest: string, scope: Scope): ScheduleTask {
	const now = Date.now();
	let nextFireAt = parsed.runImmediately ? now : computeNextFire(parsed.trigger, now);
	if (parsed.trigger.kind === "once" && parsed.trigger.at <= now && !parsed.runImmediately) {
		throw new Error("Scheduled time is in the past");
	}
	if (nextFireAt === undefined) throw new Error("Could not compute the next fire time");
	const task: ScheduleTask = {
		id: createTaskId(db),
		scopeKind: scope.kind,
		scopeKey: scope.key,
		rawRequest,
		prompt: parsed.prompt,
		trigger: parsed.trigger,
		target: parsed.target,
		timezone: parsed.timezone,
		status: "active",
		revision: 0,
		nextFireAt,
		runCount: 0,
		overlapPolicy: "skip",
		catchupPolicy: "none",
		createdAt: now,
		updatedAt: now,
		lastStatus: "idle",
	};
	insertTask(db, task);
	return task;
}

async function createScheduleFromRequest(pi: ExtensionAPI, request: string, ctx: ExtensionContext): Promise<ScheduleCreation> {
	const trimmed = request.trim();
	if (!trimmed) return { created: false, question: "What should I schedule?" };
	if (!hasPersistentSession(ctx)) {
		return { created: false, question: "Schedules require a persisted Pi session so the thread can be resumed after restart. Save or persist this session before creating a schedule." };
	}
	const parsed = await parseScheduleCreate(trimmed, ctx);
	if (parsed.action === "clarify") return { created: false, question: parsed.question };

	const db = openDb();
	const scope = sessionScope(ctx);
	let task: ScheduleTask;
	try {
		task = createTaskFromParsed(db, parsed, trimmed, scope);
		refreshScheduler(ctx, db);
	} finally {
		db.close();
	}
	pi.appendEntry(EVENT_TYPE, { event: "task_created", taskId: task.id, rawRequest: trimmed, prompt: task.prompt, trigger: task.trigger, target: task.target, scope, at: Date.now() });
	if (task.nextFireAt !== undefined && task.nextFireAt <= Date.now() + 1000) void pollDueTasks();
	return { created: true, task, scope };
}

function clearHandoffLeaseTimer(): void {
	if (handoffLeaseTimer) clearTimeout(handoffLeaseTimer);
	handoffLeaseTimer = undefined;
}

function clearPendingHandoff(handoff?: PendingHandoff): void {
	if (handoff && pendingHandoff !== handoff) return;
	clearHandoffLeaseTimer();
	pendingHandoff = undefined;
}

function armHandoffLeaseRenewal(handoff: PendingHandoff, delay = HANDOFF_LEASE_RENEWAL_MS): void {
	if (pendingHandoff !== handoff || handoff.bufferedReplayId === undefined) return;
	clearHandoffLeaseTimer();
	handoffLeaseTimer = setTimeout(() => renewPendingHandoffLease(handoff), delay);
	handoffLeaseTimer.unref?.();
}

function renewPendingHandoffLease(handoff = pendingHandoff): void {
	clearHandoffLeaseTimer();
	if (!handoff || pendingHandoff !== handoff || handoff.bufferedReplayId === undefined) return;
	try {
		const db = openDb();
		let renewed = false;
		try { renewed = renewClaimLease(db, handoff.claim); } finally { db.close(); }
		if (!renewed) return;
		armHandoffLeaseRenewal(handoff);
	} catch {
		if (pendingHandoff === handoff && handoff.bufferedReplayId !== undefined) {
			armHandoffLeaseRenewal(handoff, HANDOFF_LEASE_RETRY_MS);
		}
	}
}

function beginPendingHandoff(session: CurrentSession, claim: ScheduleRunClaim): PendingHandoff {
	clearPendingHandoff();
	const handoff = { session, claim, inputObserved: false };
	pendingHandoff = handoff;
	return handoff;
}

function executeClaim(session: CurrentSession, claim: ScheduleRunClaim): DeliveryResult {
	const task = claim.task;
	if (!session.ctx.isIdle() || session.ctx.hasPendingMessages()) return { state: "not_idle" };
	setAutonomousYield(session, false, "delivery");
	session.ctx.ui.notify(`Running scheduled task ${task.id}: ${shortPrompt(task.prompt, 80)}`, "info");
	session.pi.appendEntry(EVENT_TYPE, { event: "run_started", taskId: task.id, fireAt: claim.fireAt, prompt: task.prompt, target: task.target, at: Date.now() });
	const handoff = beginPendingHandoff(session, claim);
	try {
		session.pi.sendUserMessage(task.prompt);
	} catch (error) {
		clearPendingHandoff(handoff);
		throw error;
	}
	return { state: "delivered" };
}

function processTask(session: CurrentSession, db: DatabaseSync, task: ScheduleTask, now: number): ProcessTaskResult {
	const manual = task.manualFireAt !== undefined && task.manualFireAt <= now;
	const fireAt = manual ? task.manualFireAt! : (task.nextFireAt ?? now);
	const existingRun = getRunForOccurrence(db, task.id, fireAt);
	if (existingRun?.status === "claimed" && (existingRun.leaseUntil ?? 0) > now) return "handled";
	const misfire = !existingRun ? applyMisfirePolicy(db, task, fireAt, manual, now) : undefined;
	if (misfire) {
		if (!misfire.applied) return "handled";
		if (session.ctx.hasUI) session.ctx.ui.notify(`Missed scheduled task ${task.id}: ${misfire.reason}. Use /schedule run ${task.id} to run it now.`, "warning");
		session.pi.appendEntry(EVENT_TYPE, { event: "run_missed", taskId: task.id, fireAt, reason: misfire.reason, at: Date.now() });
		return "handled";
	}
	if (task.overlapPolicy === "skip" && hasActiveRun(db, task, now, fireAt)) {
		markRunSkipped(db, task, fireAt, manual, "previous occurrence still active");
		return "handled";
	}
	if (!session.ctx.isIdle() || session.ctx.hasPendingMessages()) {
		if (deferRunUntilIdle(db, task, fireAt, manual)) setAutonomousYield(session, true);
		return "handled";
	}
	const claim = claimRun(db, task, fireAt, session.workerId, manual);
	if (!claim) {
		if (deferRunUntilIdle(db, task, fireAt, manual)) setAutonomousYield(session, true);
		return "handled";
	}
	try {
		const result = executeClaim(session, claim);
		if (result.state === "not_idle") {
			releaseRunForIdle(db, claim);
			setAutonomousYield(session, true);
			return "handled";
		}
		return "handed_off";
	} catch (err) {
		markRunDeliveryFailed(db, claim, err);
		return "handled";
	}
}

function settlePendingHandoff(): void {
	const handoff = pendingHandoff;
	if (!handoff || !handoff.inputObserved) return;
	const db = openDb();
	let delivered = false;
	try {
		delivered = recordRunDeliveredAndAdvanceTask(db, handoff.claim);
	} finally {
		db.close();
	}
	clearPendingHandoff(handoff);
	if (delivered) {
		handoff.session.pi.appendEntry(EVENT_TYPE, {
			event: "run_delivered",
			taskId: handoff.claim.task.id,
			fireAt: handoff.claim.fireAt,
			completionStatus: "unknown",
			at: Date.now(),
		});
	}
}

function clearDueTimer(): void {
	if (dueTimer) clearTimeout(dueTimer);
	dueTimer = undefined;
}

function armScheduler(db: DatabaseSync): void {
	if (!currentSession) return;
	const wakeAt = nextSchedulerWakeAt(db, currentSession.scope, Date.now());
	clearDueTimer();
	if (wakeAt === undefined) return;
	const delay = Math.max(0, Math.min(wakeAt - Date.now(), MAX_TIMER_DELAY_MS));
	dueTimer = setTimeout(() => void pollDueTasks(), delay);
	dueTimer.unref?.();
}

function armSchedulerRetry(delay = POLL_ERROR_RETRY_MS): void {
	if (!currentSession) return;
	clearDueTimer();
	dueTimer = setTimeout(() => void pollDueTasks(), delay);
	dueTimer.unref?.();
}

function refreshScheduler(ctx: ExtensionContext, db: DatabaseSync, forceStatus = false): void {
	updateStatus(ctx, db, forceStatus);
	armScheduler(db);
}

function pollDueTasks(): void {
	if (!currentSession) return;
	if (polling) {
		pollAgainAfterCurrent = true;
		return;
	}
	clearDueTimer();
	polling = true;
	const session = currentSession;
	let failed = false;
	try {
		settlePendingHandoff();
		const db = openDb();
		try {
			const now = Date.now();
			for (const task of dueTasks(db, session.scope, now)) {
				if (processTask(session, db, task, now) === "handed_off") break;
			}
			if (dueTasks(db, session.scope, Date.now()).length === 0) setAutonomousYield(session, false, "withdrawn");
			if (currentSession === session) refreshScheduler(session.ctx, db);
		} finally {
			db.close();
		}
	} catch (err) {
		failed = true;
		if (currentSession === session && session.ctx.hasUI) {
			session.ctx.ui.setStatus(STATUS_KEY, `Schedule: error ${err instanceof Error ? err.message : String(err)}; retrying`);
		}
	} finally {
		polling = false;
		const rerun = pollAgainAfterCurrent;
		pollAgainAfterCurrent = false;
		if (!currentSession) return;
		if (currentSession !== session) {
			try {
				const db = openDb();
				try { armScheduler(db); } finally { db.close(); }
			} catch {
				armSchedulerRetry();
			}
		} else if (failed) {
			armSchedulerRetry();
		} else if (rerun) {
			try {
				const db = openDb();
				try { armScheduler(db); } finally { db.close(); }
			} catch {
				armSchedulerRetry();
			}
		}
	}
}

function startScheduler(pi: ExtensionAPI, ctx: ExtensionContext): void {
	stopScheduler();
	currentSession = { pi, ctx, workerId: workerId(ctx), scope: sessionScope(ctx) };
	autonomousYieldRequested = false;
	const db = openDb();
	try {
		pruneRunHistory(db);
		armRetentionTimer(db);
		refreshScheduler(ctx, db, true);
	} finally { db.close(); }
}

function stopScheduler(): void {
	if (currentSession) setAutonomousYield(currentSession, false, "shutdown");
	clearPendingHandoff();
	clearDueTimer();
	clearRetentionTimer();
	pollAgainAfterCurrent = false;
	if (statusTimer) clearTimeout(statusTimer);
	statusTimer = undefined;
	currentSession = undefined;
	lastStatusText = undefined;
}

function schedulerDebugState(): { dueTimerArmed: boolean; handoffLeaseTimerArmed: boolean; polling: boolean; hasCurrentSession: boolean } {
	return {
		dueTimerArmed: dueTimer !== undefined,
		handoffLeaseTimerArmed: handoffLeaseTimer !== undefined,
		polling,
		hasCurrentSession: currentSession !== undefined,
	};
}

function updateStatusSoon(ctx: ExtensionContext): void {
	if (statusTimer) clearTimeout(statusTimer);
	statusTimer = setTimeout(() => {
		statusTimer = undefined;
		try {
			const db = openDb();
			try { refreshScheduler(ctx, db); } finally { db.close(); }
		} catch (error) {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `Schedule: status error ${error instanceof Error ? error.message : String(error)}`);
			armSchedulerRetry();
		}
	}, 100);
	statusTimer.unref?.();
}

function setScheduleStatus(ctx: ExtensionContext, text: string | undefined, force = false): void {
	if (!force && text === lastStatusText) return;
	lastStatusText = text;
	ctx.ui.setStatus(STATUS_KEY, text);
}

function updateStatus(ctx: ExtensionContext, db: DatabaseSync, force = false): void {
	if (!ctx.hasUI) return;
	const scope = sessionScope(ctx);
	const tasks = listTasks(db, scope, false).filter((task) => task.status === "active" || task.manualFireAt !== undefined);
	if (tasks.length === 0) {
		setScheduleStatus(ctx, undefined, force);
		return;
	}
	const now = Date.now();
	const waiting = tasks.find((task) => (pendingFireAt(task) ?? Number.POSITIVE_INFINITY) <= now && task.target.kind === "main_thread");
	if (waiting && (!ctx.isIdle() || ctx.hasPendingMessages())) {
		setScheduleStatus(ctx, `Schedule: waiting idle · ${shortPrompt(waiting.prompt)}`, force);
		return;
	}
	const next = tasks.filter((task) => pendingFireAt(task) !== undefined).sort((a, b) => pendingFireAt(a)! - pendingFireAt(b)!)[0];
	const suffix = next ? ` · next ${formatRelativeTime(pendingFireAt(next)!, now)} ${shortPrompt(next.prompt, 32)}` : "";
	setScheduleStatus(ctx, `Schedule: ${tasks.length} active${suffix}`, force);
}

function pendingFireAt(task: ScheduleTask): number | undefined {
	const candidates = [task.manualFireAt, task.status === "active" ? task.nextFireAt : undefined]
		.filter((value): value is number => value !== undefined);
	return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

function formatTaskStatus(task: ScheduleTask): string {
	if (task.manualFireAt !== undefined) return "manual queued";
	if (task.status !== "active") return task.status;
	return task.lastStatus || task.status;
}

function formatTaskLine(task: ScheduleTask): string {
	const nextAt = pendingFireAt(task);
	const next = nextAt ? formatRelativeTime(nextAt) : "-";
	return `${task.id.padEnd(12)} ${task.status.padEnd(9)} ${formatTaskStatus(task).padEnd(16)} ${next.padEnd(12)} ${formatTrigger(task.trigger).padEnd(18)} ${formatTarget(task.target).padEnd(16)} ${shortPrompt(task.prompt, 70)}`;
}

function renderTaskList(tasks: ScheduleTask[]): string {
	if (tasks.length === 0) return "No scheduled tasks for this thread.";
	return [
		"ID           State     Last             Next         Schedule           Target           Prompt",
		"──           ─────     ────             ────         ────────           ──────           ──────",
		...tasks.map(formatTaskLine),
	].join("\n");
}

function formatRunLine(run: ScheduleRun): string {
	const fired = new Date(run.fireAt).toLocaleString();
	const completion = run.completionStatus === "unknown" ? "completion unknown" : `completion ${run.completionStatus}`;
	const ref = run.deliveryRef ? ` ref=${run.deliveryRef}` : "";
	const err = run.completionError || run.lastError;
	return `- ${fired}: delivery ${run.status}; ${completion}${ref}${err ? `; ${err}` : ""}`;
}

function renderTaskDetails(task: ScheduleTask, runs: ScheduleRun[] = []): string {
	return [
		`ID: ${task.id}`,
		`Status: ${task.status} (${formatTaskStatus(task)})`,
		`Revision: ${task.revision}`,
		`Prompt: ${task.prompt}`,
		`Schedule: ${formatTrigger(task.trigger)}`,
		`Target: ${formatTarget(task.target)}`,
		`Scope: ${task.scopeKind}:${task.scopeKey}`,
		`Next: ${pendingFireAt(task) ? `${new Date(pendingFireAt(task)!).toLocaleString()} (${formatRelativeTime(pendingFireAt(task)!)})` : "-"}`,
		...(task.manualFireAt !== undefined ? [`Manual run queued: ${new Date(task.manualFireAt).toLocaleString()}`] : []),
		`Deliveries: ${task.runCount}`,
		`Misfire grace: ${formatDuration(DEFAULT_MISFIRE_GRACE_MS)}; catch-up: ${task.catchupPolicy}`,
		...(task.lastError ? [`Last error: ${task.lastError}`] : []),
		...(runs.length ? ["Recent runs:", ...runs.map(formatRunLine)] : []),
	].join("\n");
}

function renderCreateConfirmation(task: ScheduleTask, scope: Scope): string {
	return [
		`Created schedule ${task.id}`,
		`Prompt: ${task.prompt}`,
		`When: ${formatTrigger(task.trigger)}`,
		`Next: ${task.nextFireAt ? `${new Date(task.nextFireAt).toLocaleString()} (${formatRelativeTime(task.nextFireAt)})` : "-"}`,
		`Target: ${formatTarget(task.target)}`,
		`Scope: ${scope.label}`,
		`Misfire policy: grace ${formatDuration(DEFAULT_MISFIRE_GRACE_MS)}, catch-up ${task.catchupPolicy}`,
		`Cancel: /schedule cancel ${task.id}`,
		"Note: this fires while this Pi session is active; stale one-shot fires are marked missed instead of auto-running late.",
	].join("\n");
}

async function handleManagementCommand(args: string, ctx: ExtensionCommandContext): Promise<boolean> {
	const [verbRaw, ...rest] = args.trim().split(/\s+/);
	const verb = (verbRaw || "").toLowerCase();
	const db = openDb();
	try {
		const scope = sessionScope(ctx);
		if (!verb || (verb === "help" && rest.length === 0)) {
			ctx.ui.notify(scheduleUsage(), "info");
			return true;
		}
		if (verb === "list" && rest.length === 0) {
			ctx.ui.notify(renderTaskList(listTasks(db, scope, true)), "info");
			return true;
		}
		if (verb === "show") {
			const id = rest[0];
			if (!looksLikeTaskId(id) || rest.length !== 1) {
				ctx.ui.notify("Usage: /schedule show <id>", "warning");
				return true;
			}
			const task = getTask(db, id, scope);
			ctx.ui.notify(task ? renderTaskDetails(task, listRunsForTask(db, id)) : `No scheduled task ${id}`, task ? "info" : "warning");
			return true;
		}
		if (verb === "cancel" && rest.length === 1 && rest[0]?.toLowerCase() === "all") {
			if (!ctx.hasUI) {
				ctx.ui.notify("/schedule cancel all requires interactive confirmation.", "warning");
				return true;
			}
			const confirmed = await ctx.ui.confirm("Cancel all schedules?", "This permanently cancels every active or paused schedule in the current thread.");
			if (!confirmed) return true;
			const result = cancelAllSchedules(db, scope);
			const warning = result.inFlightRuns > 0 ? ` ${result.inFlightRuns} claimed run(s) may already be crossing the delivery boundary.` : "";
			ctx.ui.notify(`Cancelled ${result.cancelled} schedule(s).${warning}`, result.inFlightRuns > 0 ? "warning" : "info");
			refreshScheduler(ctx, db);
			return true;
		}
		if (verb === "cancel") {
			const id = rest[0];
			if (!looksLikeTaskId(id) || rest.length !== 1) {
				ctx.ui.notify("Usage: /schedule cancel <id>|all", "warning");
				return true;
			}
			const result = updateScheduleTask(db, id, scope, "cancel");
			const warning = result.inFlightRuns > 0 ? ` ${result.inFlightRuns} claimed run(s) may already be crossing the delivery boundary.` : "";
			ctx.ui.notify(`${result.changed ? "Cancelled" : "Already cancelled"} scheduled task ${id}.${warning}`, result.inFlightRuns > 0 ? "warning" : "info");
			refreshScheduler(ctx, db);
			return true;
		}
		if (verb === "pause" || verb === "resume") {
			const id = rest[0];
			if (!looksLikeTaskId(id) || rest.length !== 1) {
				ctx.ui.notify(`Usage: /schedule ${verb} <id>`, "warning");
				return true;
			}
			const result = updateScheduleTask(db, id, scope, verb);
			const label = verb === "pause" ? (result.changed ? "Paused" : "Already paused") : (result.changed ? "Resumed" : "Already active");
			const warning = result.inFlightRuns > 0 && verb === "pause" ? ` ${result.inFlightRuns} claimed run(s) may already be crossing the delivery boundary.` : "";
			ctx.ui.notify(`${label} scheduled task ${id}.${warning}`, warning ? "warning" : "info");
			refreshScheduler(ctx, db);
			return true;
		}
		if (verb === "run") {
			const id = rest[0];
			if (!looksLikeTaskId(id) || rest.length !== 1) {
				ctx.ui.notify("Usage: /schedule run <id>", "warning");
				return true;
			}
			const task = getTask(db, id, scope);
			if (!task) {
				ctx.ui.notify(`No scheduled task ${id}.`, "warning");
				return true;
			}
			if (task.status === "cancelled") {
				ctx.ui.notify(`Cannot run ${id}: it is cancelled.`, "warning");
				return true;
			}
			if (task.manualFireAt !== undefined) {
				ctx.ui.notify(`Scheduled task ${id} already has a manual run queued.`, "warning");
				return true;
			}
			queueManualRun(db, id, scope);
			ctx.ui.notify(`Queued scheduled task ${id} to run when idle.`, "info");
			refreshScheduler(ctx, db);
			void pollDueTasks();
			return true;
		}
		if (verb === "clear" && rest.length === 1 && rest[0]?.toLowerCase() === "completed") {
			const cleared = clearTerminalSchedules(db, scope);
			ctx.ui.notify(`Cleared ${cleared} terminal schedule(s).`, "info");
			refreshScheduler(ctx, db);
			return true;
		}
		if (verb === "clear") {
			ctx.ui.notify("Usage: /schedule clear completed", "warning");
			return true;
		}
		return false;
	} finally {
		db.close();
	}
}

function looksLikeTaskId(value: string | undefined): value is string {
	return Boolean(value && /^[a-f0-9]{8,32}$/i.test(value));
}

function scheduleUsage(): string {
	return [
		"Usage:",
		"  /schedule check deploy in 5 minutes",
		"  /schedule check deploy every 5 minutes",
		"  /schedule tomorrow 9am remind me to email Sam",
		"  /schedule every weekday at 10am summarize PRs",
		"  /schedule list",
		"  /schedule show <id>",
		"  /schedule cancel <id>|all",
		"  /schedule pause <id>",
		"  /schedule resume <id>",
		"  /schedule run <id>",
		"  /schedule clear completed",
		"",
		`Notes: schedules fire while this Pi session is active. One-shot tasks missed by more than ${formatDuration(DEFAULT_MISFIRE_GRACE_MS)} are marked missed; use /schedule run <id> to execute one manually.`,
	].join("\n");
}

// ---- Minimal 5-field cron parsing, copied in spirit from Claude Code but kept local. ----

type FieldRange = { min: number; max: number };
const FIELD_RANGES: FieldRange[] = [
	{ min: 0, max: 59 },
	{ min: 0, max: 23 },
	{ min: 1, max: 31 },
	{ min: 1, max: 12 },
	{ min: 0, max: 6 },
];

function expandCronField(field: string, range: FieldRange): number[] | null {
	const { min, max } = range;
	const out = new Set<number>();
	for (const part of field.split(",")) {
		const stepMatch = part.match(/^\*(?:\/(\d+))?$/);
		if (stepMatch) {
			const step = stepMatch[1] ? Number.parseInt(stepMatch[1], 10) : 1;
			if (step < 1) return null;
			for (let i = min; i <= max; i += step) out.add(i);
			continue;
		}
		const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
		if (rangeMatch) {
			const lo = Number.parseInt(rangeMatch[1]!, 10);
			const hi = Number.parseInt(rangeMatch[2]!, 10);
			const step = rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : 1;
			const isDow = min === 0 && max === 6;
			const effectiveMax = isDow ? 7 : max;
			if (lo > hi || step < 1 || lo < min || hi > effectiveMax) return null;
			for (let i = lo; i <= hi; i += step) out.add(isDow && i === 7 ? 0 : i);
			continue;
		}
		if (/^\d+$/.test(part)) {
			let n = Number.parseInt(part, 10);
			if (min === 0 && max === 6 && n === 7) n = 0;
			if (n < min || n > max) return null;
			out.add(n);
			continue;
		}
		return null;
	}
	return out.size === 0 ? null : Array.from(out).sort((a, b) => a - b);
}

export function parseCronExpression(expr: string): CronFields | null {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const expanded: number[][] = [];
	for (let i = 0; i < 5; i++) {
		const result = expandCronField(parts[i]!, FIELD_RANGES[i]!);
		if (!result) return null;
		expanded.push(result);
	}
	return { minute: expanded[0]!, hour: expanded[1]!, dayOfMonth: expanded[2]!, month: expanded[3]!, dayOfWeek: expanded[4]! };
}

export function nextCronRunMs(expr: string, fromMs: number): number | null {
	const fields = parseCronExpression(expr);
	if (!fields) return null;
	const minuteSet = new Set(fields.minute);
	const hourSet = new Set(fields.hour);
	const domSet = new Set(fields.dayOfMonth);
	const monthSet = new Set(fields.month);
	const dowSet = new Set(fields.dayOfWeek);
	const domWild = fields.dayOfMonth.length === 31;
	const dowWild = fields.dayOfWeek.length === 7;
	const t = new Date(fromMs);
	t.setSeconds(0, 0);
	t.setMinutes(t.getMinutes() + 1);
	for (let i = 0; i < 366 * 24 * 60; i++) {
		const month = t.getMonth() + 1;
		if (!monthSet.has(month)) {
			t.setMonth(t.getMonth() + 1, 1);
			t.setHours(0, 0, 0, 0);
			continue;
		}
		const dom = t.getDate();
		const dow = t.getDay();
		const dayMatches = domWild && dowWild ? true : domWild ? dowSet.has(dow) : dowWild ? domSet.has(dom) : domSet.has(dom) || dowSet.has(dow);
		if (!dayMatches) {
			t.setDate(t.getDate() + 1);
			t.setHours(0, 0, 0, 0);
			continue;
		}
		if (!hourSet.has(t.getHours())) {
			t.setHours(t.getHours() + 1, 0, 0, 0);
			continue;
		}
		if (!minuteSet.has(t.getMinutes())) {
			t.setMinutes(t.getMinutes() + 1);
			continue;
		}
		return t.getTime();
	}
	return null;
}

function scheduleTaskResponse(task: ScheduleTask): Record<string, unknown> {
	return {
		id: task.id,
		status: task.status,
		revision: task.revision,
		prompt: task.prompt,
		trigger: task.trigger,
		target: task.target,
		next_fire_at: task.nextFireAt,
		last_fire_at: task.lastFireAt,
		manual_fire_at: task.manualFireAt,
		run_count: task.runCount,
		last_delivery_status: task.lastStatus,
		last_error: task.lastError,
	};
}

export default function (pi: ExtensionAPI) {
	const stopAutonomousQueryListener = pi.events.on(AUTONOMOUS_QUERY_CHANNEL, (data) => {
		if (typeof data !== "object" || data === null || Array.isArray(data) || !currentSession) return;
		const query = data as { sessionId?: unknown; yield?: unknown };
		if (query.sessionId !== currentSession.scope.key || typeof query.yield !== "boolean") return;
		pollDueTasks();
		query.yield = autonomousYieldRequested;
	});
	const stopBufferedInputListener = pi.events.on(BUFFERED_INPUT_EVENT_CHANNEL, (data) => {
		if (
			!isRecord(data)
			|| data.pending !== true
			|| data.source !== "extension"
			|| typeof data.replayId !== "string"
			|| !pendingHandoff
			|| pendingHandoff.bufferedReplayId !== undefined
			|| data.sessionId !== pendingHandoff.session.scope.key
		) return;
		pendingHandoff.inputObserved = false;
		pendingHandoff.bufferedReplayId = data.replayId;
		armHandoffLeaseRenewal(pendingHandoff);
	});

	pi.registerTool({
		name: "create_schedule",
		label: "Create Schedule",
		description: "Create a one-shot or recurring schedule in the current persisted thread from a natural-language request. Use only when the user explicitly asks to schedule future work.",
		promptSnippet: "Create a one-shot or recurring schedule from natural language",
		promptGuidelines: [
			"Use create_schedule only when the user explicitly asks to schedule future work.",
			"Use get_schedules and update_schedule for existing schedules; never infer destructive intent.",
		],
		parameters: SCHEDULE_TOOL_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const creation = await createScheduleFromRequest(pi, params.request, ctx);
			if (!creation.created) throw new Error(creation.question);
			const details = scheduleTaskResponse(creation.task);
			return {
				content: [{ type: "text", text: renderCreateConfirmation(creation.task, creation.scope) }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "get_schedules",
		label: "Get Schedules",
		description: "List schedules in the current persisted thread or inspect one by id. Terminal schedules are omitted unless requested or addressed directly.",
		promptSnippet: "List or inspect schedules in the current thread",
		parameters: GET_SCHEDULES_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!hasPersistentSession(ctx)) throw new Error("Schedules require a persisted Pi session.");
			const scope = sessionScope(ctx);
			const db = openDb();
			try {
				let tasks: ScheduleTask[];
				if (params.id !== undefined) {
					if (!looksLikeTaskId(params.id)) throw new Error(`Invalid schedule id: ${params.id}`);
					const task = getTask(db, params.id, scope);
					tasks = task ? [task] : [];
				} else {
					tasks = listTasks(db, scope, params.include_terminal === true);
				}
				const details = { schedules: tasks.map(scheduleTaskResponse) };
				return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
			} finally {
				db.close();
			}
		},
	});

	pi.registerTool({
		name: "update_schedule",
		label: "Update Schedule",
		description: "Pause, resume, or cancel one schedule by id. Use only when the user explicitly requests that lifecycle change. Cancellation is permanent; ambiguous words such as stop require clarification between pause and cancel.",
		promptSnippet: "Pause, resume, or cancel one existing schedule after explicit user instruction",
		promptGuidelines: [
			"Use update_schedule only after an explicit user request to pause, resume, or cancel a specific schedule.",
			"If the intended schedule or whether stop means pause versus cancel is ambiguous, call get_schedules and ask the user.",
			"Never use update_schedule for bulk cleanup or autonomous schedule management.",
		],
		parameters: UPDATE_SCHEDULE_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!hasPersistentSession(ctx)) throw new Error("Schedules require a persisted Pi session.");
			if (!looksLikeTaskId(params.id)) throw new Error(`Invalid schedule id: ${params.id}`);
			const scope = sessionScope(ctx);
			const db = openDb();
			try {
				const result = updateScheduleTask(db, params.id, scope, params.action);
				refreshScheduler(ctx, db);
				const details = { ...scheduleTaskResponse(result.task), changed: result.changed, in_flight_runs: result.inFlightRuns };
				return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
			} finally {
				db.close();
			}
		},
	});

	pi.registerCommand("schedule", {
		description: "Schedule a prompt with natural language (one-shot or recurring)",
		getArgumentCompletions(argumentPrefix) {
			const prefix = argumentPrefix.trim().toLowerCase();
			const items = ["list", "show ", "cancel ", "cancel all", "pause ", "resume ", "run ", "clear completed", "check deploy in 5 minutes", "check deploy every 5 minutes"];
			return items.filter((item) => item.startsWith(prefix)).map((label) => ({ value: label, label }));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			try {
				if (!trimmed) {
					ctx.ui.notify(scheduleUsage(), "info");
					return;
				}
				if (await handleManagementCommand(trimmed, ctx)) return;
				const creation = await createScheduleFromRequest(pi, trimmed, ctx);
				if (!creation.created) {
					ctx.ui.notify(creation.question, "warning");
					return;
				}
				ctx.ui.notify(renderCreateConfirmation(creation.task, creation.scope), "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		startScheduler(pi, ctx);
	});

	pi.on("session_shutdown", async () => {
		stopAutonomousQueryListener();
		stopBufferedInputListener();
		stopScheduler();
	});

	pi.on("input", (event) => {
		if (pendingHandoff && event.source === "extension") pendingHandoff.inputObserved = true;
		return { action: "continue" };
	});

	pi.on("message_start", (event, ctx) => {
		const handoff = pendingHandoff;
		const message = event.message as { role?: unknown; customType?: unknown; details?: unknown };
		if (
			!handoff
			|| handoff.bufferedReplayId === undefined
			|| ctx.sessionManager.getSessionId() !== handoff.session.scope.key
			|| message.role !== "custom"
			|| message.customType !== BUFFERED_INPUT_MESSAGE_TYPE
			|| !isRecord(message.details)
			|| message.details.replayId !== handoff.bufferedReplayId
		) return;
		handoff.inputObserved = true;
		pollDueTasks();
	});

	pi.on("agent_start", async () => {
		pollDueTasks();
	});

	pi.on("agent_end", async (_event, ctx) => {
		updateStatusSoon(ctx);
		pollDueTasks();
	});

	pi.on("agent_settled", async () => {
		pollDueTasks();
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatusSoon(ctx);
	});
}

export const __scheduleTest = {
	IDLE_RETRY_MS,
	POLL_ERROR_RETRY_MS,
	DEFAULT_LEASE_MS,
	DEFAULT_MISFIRE_GRACE_MS,
	enableScheduleWal,
	isSqliteBusy,
	openDb,
	initDb,
	sessionScope,
	fallbackParseCreate,
	parseWithAi,
	requestsUnsupportedAgentTarget,
	validateParsedSchedule,
	computeNextFire,
	createTaskFromParsed,
	createScheduleFromRequest,
	dueTasks,
	nextSchedulerWakeAt,
	processTask,
	claimRun,
	renewClaimLease,
	renewPendingHandoffLease,
	recordRunDeliveredAndAdvanceTask,
	releaseRunForIdle,
	markRunDeliveryFailed,
	pollDueTasks,
	startScheduler,
	stopScheduler,
	schedulerDebugState,
	queueManualRun,
	pruneRunHistory,
	listRunsForTask,
	getTask,
	updateScheduleTask,
	cancelAllSchedules,
	clearTerminalSchedules,
	hasPersistentSession,
	formatTrigger,
	formatDuration,
	formatRelativeTime,
	renderCreateConfirmation,
};
