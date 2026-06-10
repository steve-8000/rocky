import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir } from "@amaze/utils";

export type AgiSessionState = "watching" | "waiting" | "blocked" | "paused" | "completed" | "error";
export type AgiActionStatus = "pending" | "running" | "completed" | "failed";
export type AgiGoalCriterionSource = "supervisor" | "agent";

export interface AgiGoalCriterion {
	id: string;
	description: string;
	source: AgiGoalCriterionSource;
}

export interface AgiGoalSpec {
	version: 1;
	markerPrefix: string;
	criteria: AgiGoalCriterion[];
}

export interface AgiStructuredResult {
	score: number;
	complete: boolean;
	satisfiedCriteria: string[];
	summary?: string;
}

export interface AgiCompletionState {
	score: number;
	complete: boolean;
	structuredResultSeen: boolean;
	reportedScore?: number;
	summary?: string;
	agentSatisfiedCriteria: string[];
	supervisorSatisfiedCriteria: string[];
	missingCriteria: string[];
	lastStructuredResult?: AgiStructuredResult;
}

export interface AgiControlState {
	retryCount: number;
	failureCount: number;
	consecutiveIdleTicks: number;
	waitReason?: string;
	blockedReason?: string;
	activeActionId?: string;
	lastActionAt?: number;
	lastProgressAt?: number;
	nextRetryAt?: number;
}

export interface AgiMonitoredSession {
	sessionId: string;
	sessionPath: string;
	cwd: string;
	title?: string;
	preferredModel?: string;
	state: AgiSessionState;
	score: number;
	observedBytes: number;
	goalSpec: AgiGoalSpec;
	completionState: AgiCompletionState;
	controlState: AgiControlState;
	lastSummary?: string;
	lastError?: string;
	createdAt: number;
	updatedAt: number;
	lastEventAt?: number;
}

export interface AddAgiSessionInput {
	sessionId: string;
	sessionPath: string;
	cwd: string;
	title?: string;
	preferredModel?: string;
	state?: AgiSessionState;
	goalSpec?: AgiGoalSpec;
}

export interface UpdateAgiSessionInput {
	state?: AgiSessionState;
	preferredModel?: string | null;
	score?: number;
	observedBytes?: number;
	goalSpec?: AgiGoalSpec;
	completionState?: AgiCompletionState;
	controlState?: AgiControlState;
	lastSummary?: string | null;
	lastError?: string | null;
	lastEventAt?: number | null;
}

export interface AgiGatewayEvent {
	id: string;
	sessionId: string;
	type: string;
	payload: Record<string, unknown>;
	createdAt: number;
	processedAt?: number;
}

export interface AgiGatewayAction {
	id: string;
	sessionId: string;
	eventId?: string;
	actionType: string;
	instruction: string;
	status: AgiActionStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	result?: Record<string, unknown>;
	lastError?: string;
}

type AgiSessionRow = {
	session_id: string;
	session_path: string;
	cwd: string;
	title: string | null;
	preferred_model: string | null;
	state: AgiSessionState;
	score: number;
	observed_bytes: number;
	goal_spec_json: string | null;
	completion_state_json: string | null;
	control_state_json: string | null;
	last_summary: string | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
	last_event_at: number | null;
};

type AgiEventRow = {
	id: string;
	session_id: string;
	type: string;
	payload_json: string;
	created_at: number;
	processed_at: number | null;
};

type AgiActionRow = {
	id: string;
	session_id: string;
	event_id: string | null;
	action_type: string;
	instruction: string;
	status: AgiActionStatus;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
	result_json: string | null;
	last_error: string | null;
};

const DEFAULT_DB_PATH = path.join(getConfigRootDir(), "agi", "gateway.db");
const DEFAULT_GOAL_MARKER = "AGI_GATEWAY_RESULT";

export function createDefaultAgiGoalSpec(): AgiGoalSpec {
	return {
		version: 1,
		markerPrefix: DEFAULT_GOAL_MARKER,
		criteria: [
			{
				id: "monitored_by_gateway",
				description: "The session is attached to the AGI Gateway and tracked durably.",
				source: "supervisor",
			},
			{
				id: "completion_alarm_detected",
				description: "The gateway observed a completed assistant turn for this session.",
				source: "supervisor",
			},
			{
				id: "follow_up_turn_executed",
				description: "The supervisor executed at least one follow-up control turn for this session.",
				source: "supervisor",
			},
			{
				id: "context_boundaries_preserved",
				description: "The session confirms that bounded context rules are preserved.",
				source: "agent",
			},
			{
				id: "initial_build_goal_complete",
				description: "The session confirms the initial AGI control goal is complete.",
				source: "agent",
			},
		],
	};
}

export function createInitialAgiCompletionState(
	goalSpec: AgiGoalSpec = createDefaultAgiGoalSpec(),
): AgiCompletionState {
	return buildAgiCompletionState(goalSpec, {
		score: 20,
		complete: false,
		structuredResultSeen: false,
		agentSatisfiedCriteria: [],
		supervisorSatisfiedCriteria: ["monitored_by_gateway"],
		summary: "Session attached to AGI Gateway.",
	});
}

export function buildAgiCompletionState(
	goalSpec: AgiGoalSpec,
	input: {
		score: number;
		complete: boolean;
		structuredResultSeen: boolean;
		reportedScore?: number;
		summary?: string;
		agentSatisfiedCriteria: string[];
		supervisorSatisfiedCriteria: string[];
		lastStructuredResult?: AgiStructuredResult;
	},
): AgiCompletionState {
	const allCriterionIds = goalSpec.criteria.map(criterion => criterion.id);
	const satisfied = new Set([...input.agentSatisfiedCriteria, ...input.supervisorSatisfiedCriteria]);
	return {
		score: clampScore(input.score),
		complete: input.complete,
		structuredResultSeen: input.structuredResultSeen,
		...(input.reportedScore !== undefined ? { reportedScore: clampScore(input.reportedScore) } : {}),
		...(input.summary ? { summary: input.summary } : {}),
		agentSatisfiedCriteria: [...new Set(input.agentSatisfiedCriteria)].sort(),
		supervisorSatisfiedCriteria: [...new Set(input.supervisorSatisfiedCriteria)].sort(),
		missingCriteria: allCriterionIds.filter(id => !satisfied.has(id)),
		...(input.lastStructuredResult ? { lastStructuredResult: input.lastStructuredResult } : {}),
	};
}

export function createInitialAgiControlState(): AgiControlState {
	return {
		retryCount: 0,
		failureCount: 0,
		consecutiveIdleTicks: 0,
	};
}

export function buildAgiControlState(input: Partial<AgiControlState> = {}): AgiControlState {
	return {
		retryCount: Math.max(0, Math.trunc(input.retryCount ?? 0)),
		failureCount: Math.max(0, Math.trunc(input.failureCount ?? 0)),
		consecutiveIdleTicks: Math.max(0, Math.trunc(input.consecutiveIdleTicks ?? 0)),
		...(input.waitReason ? { waitReason: input.waitReason } : {}),
		...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
		...(input.activeActionId ? { activeActionId: input.activeActionId } : {}),
		...(input.lastActionAt !== undefined ? { lastActionAt: input.lastActionAt } : {}),
		...(input.lastProgressAt !== undefined ? { lastProgressAt: input.lastProgressAt } : {}),
		...(input.nextRetryAt !== undefined ? { nextRetryAt: input.nextRetryAt } : {}),
	};
}

export function getDefaultAgiGatewayDbPath(): string {
	return process.env.AMAZE_AGI_DB || DEFAULT_DB_PATH;
}

export class AgiGatewayStore {
	readonly dbPath: string;
	readonly #db: Database;

	constructor(dbPath = getDefaultAgiGatewayDbPath()) {
		this.dbPath = dbPath;
		if (dbPath !== ":memory:") {
			fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		}
		this.#db = new Database(dbPath, { create: true, strict: true });
		this.#db.run("PRAGMA busy_timeout = 3000");
		this.#db.run("PRAGMA foreign_keys = ON");
		this.#init();
	}

	close(): void {
		this.#db.close();
	}

	addSession(input: AddAgiSessionInput): AgiMonitoredSession {
		const now = Date.now();
		const goalSpec = input.goalSpec ?? createDefaultAgiGoalSpec();
		const completionState = createInitialAgiCompletionState(goalSpec);
		const controlState = createInitialAgiControlState();
		this.#db
			.query(
				`INSERT INTO agi_sessions
					(session_id, session_path, cwd, title, preferred_model, state, score, observed_bytes, goal_spec_json, completion_state_json, control_state_json, last_summary, last_error, created_at, updated_at, last_event_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, NULL)
				ON CONFLICT(session_id) DO UPDATE SET
					session_path = excluded.session_path,
					cwd = excluded.cwd,
					title = excluded.title,
					preferred_model = COALESCE(excluded.preferred_model, agi_sessions.preferred_model),
					updated_at = excluded.updated_at`,
			)
			.run(
				input.sessionId,
				input.sessionPath,
				input.cwd,
				input.title ?? null,
				input.preferredModel ?? null,
				input.state ?? "watching",
				completionState.score,
				JSON.stringify(goalSpec),
				JSON.stringify(completionState),
				JSON.stringify(controlState),
				completionState.summary ?? null,
				now,
				now,
			);
		const session = this.getSession(input.sessionId);
		if (!session) throw new Error(`AGI session disappeared after add: ${input.sessionId}`);
		return session;
	}

	getSession(sessionId: string): AgiMonitoredSession | undefined {
		const row = this.#db
			.query("SELECT * FROM agi_sessions WHERE session_id = ?")
			.get(sessionId) as AgiSessionRow | null;
		return row ? rowToSession(row) : undefined;
	}

	listSessions(): AgiMonitoredSession[] {
		const rows = this.#db
			.query("SELECT * FROM agi_sessions ORDER BY updated_at DESC, created_at DESC, session_id ASC")
			.all() as AgiSessionRow[];
		return rows.map(rowToSession);
	}

	updateSession(sessionId: string, input: UpdateAgiSessionInput): AgiMonitoredSession {
		const current = this.getSession(sessionId);
		if (!current) throw new Error(`AGI session not found: ${sessionId}`);
		const now = Date.now();
		const goalSpec = input.goalSpec ?? current.goalSpec;
		const completionState =
			input.completionState ??
			(input.score === undefined
				? current.completionState
				: buildAgiCompletionState(goalSpec, {
						score: input.score,
						complete: current.completionState.complete,
						structuredResultSeen: current.completionState.structuredResultSeen,
						reportedScore: current.completionState.reportedScore,
						summary: current.completionState.summary,
						agentSatisfiedCriteria: current.completionState.agentSatisfiedCriteria,
						supervisorSatisfiedCriteria: current.completionState.supervisorSatisfiedCriteria,
						lastStructuredResult: current.completionState.lastStructuredResult,
					}));
		const controlState = input.controlState ?? current.controlState;
		this.#db
			.query(
				`UPDATE agi_sessions SET
					state = ?,
					preferred_model = ?,
					score = ?,
					observed_bytes = ?,
					goal_spec_json = ?,
					completion_state_json = ?,
					control_state_json = ?,
					last_summary = ?,
					last_error = ?,
					last_event_at = ?,
					updated_at = ?
				WHERE session_id = ?`,
			)
			.run(
				input.state ?? current.state,
				input.preferredModel === undefined ? (current.preferredModel ?? null) : input.preferredModel,
				input.score ?? completionState.score,
				input.observedBytes ?? current.observedBytes,
				JSON.stringify(goalSpec),
				JSON.stringify(completionState),
				JSON.stringify(controlState),
				input.lastSummary === undefined ? (current.lastSummary ?? null) : input.lastSummary,
				input.lastError === undefined ? (current.lastError ?? null) : input.lastError,
				input.lastEventAt === undefined ? (current.lastEventAt ?? null) : input.lastEventAt,
				now,
				sessionId,
			);
		const updated = this.getSession(sessionId);
		if (!updated) throw new Error(`AGI session disappeared after update: ${sessionId}`);
		return updated;
	}

	removeSession(sessionId: string): boolean {
		const result = this.#db.query("DELETE FROM agi_sessions WHERE session_id = ?").run(sessionId);
		return result.changes > 0;
	}

	recordEvent(
		sessionId: string,
		type: string,
		payload: Record<string, unknown> = {},
		options: { id?: string; createdAt?: number } = {},
	): AgiGatewayEvent {
		if (!this.getSession(sessionId)) {
			throw new Error(`AGI session not found: ${sessionId}`);
		}
		const event: AgiGatewayEvent = {
			id: options.id ?? crypto.randomUUID(),
			sessionId,
			type,
			payload,
			createdAt: options.createdAt ?? Date.now(),
		};
		this.#db
			.query(
				"INSERT OR IGNORE INTO agi_events (id, session_id, type, payload_json, created_at, processed_at) VALUES (?, ?, ?, ?, ?, NULL)",
			)
			.run(event.id, event.sessionId, event.type, JSON.stringify(event.payload), event.createdAt);
		this.#db
			.query("UPDATE agi_sessions SET last_event_at = ?, updated_at = ? WHERE session_id = ?")
			.run(event.createdAt, event.createdAt, event.sessionId);
		return this.getEvent(event.id) ?? event;
	}

	getEvent(eventId: string): AgiGatewayEvent | undefined {
		const row = this.#db.query("SELECT * FROM agi_events WHERE id = ?").get(eventId) as AgiEventRow | null;
		return row ? rowToEvent(row) : undefined;
	}

	listEvents(sessionId?: string): AgiGatewayEvent[] {
		const rows = sessionId
			? (this.#db
					.query("SELECT * FROM agi_events WHERE session_id = ? ORDER BY created_at ASC, id ASC")
					.all(sessionId) as AgiEventRow[])
			: (this.#db.query("SELECT * FROM agi_events ORDER BY created_at ASC, id ASC").all() as AgiEventRow[]);
		return rows.map(rowToEvent);
	}

	listUnprocessedEvents(): AgiGatewayEvent[] {
		const rows = this.#db
			.query("SELECT * FROM agi_events WHERE processed_at IS NULL ORDER BY created_at ASC, id ASC")
			.all() as AgiEventRow[];
		return rows.map(rowToEvent);
	}

	markEventProcessed(eventId: string, processedAt = Date.now()): void {
		this.#db.query("UPDATE agi_events SET processed_at = ? WHERE id = ?").run(processedAt, eventId);
	}

	createAction(input: {
		sessionId: string;
		eventId?: string;
		actionType: string;
		instruction: string;
	}): AgiGatewayAction {
		if (!this.getSession(input.sessionId)) {
			throw new Error(`AGI session not found: ${input.sessionId}`);
		}
		const action: AgiGatewayAction = {
			id: crypto.randomUUID(),
			sessionId: input.sessionId,
			...(input.eventId ? { eventId: input.eventId } : {}),
			actionType: input.actionType,
			instruction: input.instruction,
			status: "pending",
			createdAt: Date.now(),
		};
		this.#db
			.query(
				`INSERT INTO agi_actions
					(id, session_id, event_id, action_type, instruction, status, created_at, started_at, finished_at, result_json, last_error)
				VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
			)
			.run(
				action.id,
				action.sessionId,
				action.eventId ?? null,
				action.actionType,
				action.instruction,
				action.status,
				action.createdAt,
			);
		return action;
	}

	getAction(actionId: string): AgiGatewayAction | undefined {
		const row = this.#db.query("SELECT * FROM agi_actions WHERE id = ?").get(actionId) as AgiActionRow | null;
		return row ? rowToAction(row) : undefined;
	}

	getActionForEvent(eventId: string): AgiGatewayAction | undefined {
		const row = this.#db
			.query("SELECT * FROM agi_actions WHERE event_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
			.get(eventId) as AgiActionRow | null;
		return row ? rowToAction(row) : undefined;
	}

	listActions(sessionId?: string): AgiGatewayAction[] {
		const rows = sessionId
			? (this.#db
					.query("SELECT * FROM agi_actions WHERE session_id = ? ORDER BY created_at ASC, id ASC")
					.all(sessionId) as AgiActionRow[])
			: (this.#db.query("SELECT * FROM agi_actions ORDER BY created_at ASC, id ASC").all() as AgiActionRow[]);
		return rows.map(rowToAction);
	}

	listPendingActions(): AgiGatewayAction[] {
		const rows = this.#db
			.query("SELECT * FROM agi_actions WHERE status = 'pending' ORDER BY created_at ASC, id ASC")
			.all() as AgiActionRow[];
		return rows.map(rowToAction);
	}

	markActionRunning(actionId: string, startedAt = Date.now()): void {
		this.#db
			.query("UPDATE agi_actions SET status = 'running', started_at = ?, last_error = NULL WHERE id = ?")
			.run(startedAt, actionId);
	}

	markActionCompleted(actionId: string, result: Record<string, unknown> = {}, finishedAt = Date.now()): void {
		this.#db
			.query(
				"UPDATE agi_actions SET status = 'completed', finished_at = ?, result_json = ?, last_error = NULL WHERE id = ?",
			)
			.run(finishedAt, JSON.stringify(result), actionId);
	}

	markActionFailed(actionId: string, error: string, finishedAt = Date.now()): void {
		this.#db
			.query("UPDATE agi_actions SET status = 'failed', finished_at = ?, last_error = ? WHERE id = ?")
			.run(finishedAt, error, actionId);
	}

	overallScore(): number {
		const sessions = this.listSessions().filter(session => session.state !== "paused");
		if (sessions.length === 0) return 0;
		return Math.min(...sessions.map(session => session.score));
	}

	#init(): void {
		const defaultGoalSpecJson = JSON.stringify(createDefaultAgiGoalSpec());
		const defaultCompletionJson = JSON.stringify(createInitialAgiCompletionState());
		const defaultControlJson = JSON.stringify(createInitialAgiControlState());
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS agi_sessions (
				session_id TEXT PRIMARY KEY,
				session_path TEXT NOT NULL,
				cwd TEXT NOT NULL,
				title TEXT,
				preferred_model TEXT,
				state TEXT NOT NULL,
				score INTEGER NOT NULL DEFAULT 20,
				observed_bytes INTEGER NOT NULL DEFAULT 0,
				goal_spec_json TEXT NOT NULL CHECK (json_valid(goal_spec_json)),
				completion_state_json TEXT NOT NULL CHECK (json_valid(completion_state_json)),
				control_state_json TEXT NOT NULL CHECK (json_valid(control_state_json)),
				last_summary TEXT,
				last_error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_event_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS agi_sessions_state_idx ON agi_sessions(state);
			CREATE INDEX IF NOT EXISTS agi_sessions_updated_idx ON agi_sessions(updated_at);

			CREATE TABLE IF NOT EXISTS agi_events (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				type TEXT NOT NULL,
				payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
				created_at INTEGER NOT NULL,
				processed_at INTEGER,
				FOREIGN KEY (session_id) REFERENCES agi_sessions(session_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS agi_events_session_idx ON agi_events(session_id, created_at);
			CREATE INDEX IF NOT EXISTS agi_events_processed_idx ON agi_events(processed_at, created_at);

			CREATE TABLE IF NOT EXISTS agi_actions (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				event_id TEXT,
				action_type TEXT NOT NULL,
				instruction TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
				last_error TEXT,
				FOREIGN KEY (session_id) REFERENCES agi_sessions(session_id) ON DELETE CASCADE,
				FOREIGN KEY (event_id) REFERENCES agi_events(id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS agi_actions_session_idx ON agi_actions(session_id, created_at);
			CREATE INDEX IF NOT EXISTS agi_actions_event_idx ON agi_actions(event_id);
			CREATE INDEX IF NOT EXISTS agi_actions_status_idx ON agi_actions(status, created_at);
		`);
		ensureColumn(this.#db, "agi_sessions", "preferred_model", "TEXT");
		ensureColumn(this.#db, "agi_sessions", "score", "INTEGER DEFAULT 20");
		ensureColumn(this.#db, "agi_sessions", "observed_bytes", "INTEGER DEFAULT 0");
		ensureColumn(this.#db, "agi_sessions", "goal_spec_json", "TEXT");
		ensureColumn(this.#db, "agi_sessions", "completion_state_json", "TEXT");
		ensureColumn(this.#db, "agi_sessions", "control_state_json", "TEXT");
		ensureColumn(this.#db, "agi_sessions", "last_summary", "TEXT");
		ensureColumn(this.#db, "agi_sessions", "last_error", "TEXT");
		this.#db
			.query("UPDATE agi_sessions SET goal_spec_json = ? WHERE goal_spec_json IS NULL OR goal_spec_json = ''")
			.run(defaultGoalSpecJson);
		this.#db
			.query(
				"UPDATE agi_sessions SET completion_state_json = ?, score = COALESCE(score, 20) WHERE completion_state_json IS NULL OR completion_state_json = ''",
			)
			.run(defaultCompletionJson);
		this.#db
			.query(
				"UPDATE agi_sessions SET control_state_json = ? WHERE control_state_json IS NULL OR control_state_json = ''",
			)
			.run(defaultControlJson);
	}
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
	const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (rows.some(row => row.name === column)) return;
	db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function clampScore(score: number): number {
	if (!Number.isFinite(score)) return 0;
	return Math.max(0, Math.min(100, Math.trunc(score)));
}

function parseGoalSpec(value: string | null): AgiGoalSpec {
	if (!value) return createDefaultAgiGoalSpec();
	try {
		const parsed = JSON.parse(value) as AgiGoalSpec;
		if (parsed && typeof parsed === "object" && Array.isArray(parsed.criteria)) return parsed;
	} catch {}
	return createDefaultAgiGoalSpec();
}

function parseCompletionState(value: string | null, goalSpec: AgiGoalSpec): AgiCompletionState {
	if (!value) return createInitialAgiCompletionState(goalSpec);
	try {
		const parsed = JSON.parse(value) as AgiCompletionState;
		if (parsed && typeof parsed === "object") {
			return buildAgiCompletionState(goalSpec, {
				score: parsed.score,
				complete: parsed.complete,
				structuredResultSeen: parsed.structuredResultSeen,
				reportedScore: parsed.reportedScore,
				summary: parsed.summary,
				agentSatisfiedCriteria: parsed.agentSatisfiedCriteria ?? [],
				supervisorSatisfiedCriteria: parsed.supervisorSatisfiedCriteria ?? [],
				lastStructuredResult: parsed.lastStructuredResult,
			});
		}
	} catch {}
	return createInitialAgiCompletionState(goalSpec);
}

function parseControlState(value: string | null): AgiControlState {
	if (!value) return createInitialAgiControlState();
	try {
		const parsed = JSON.parse(value) as Partial<AgiControlState>;
		if (parsed && typeof parsed === "object") return buildAgiControlState(parsed);
	} catch {}
	return createInitialAgiControlState();
}

function rowToSession(row: AgiSessionRow): AgiMonitoredSession {
	const goalSpec = parseGoalSpec(row.goal_spec_json);
	const completionState = parseCompletionState(row.completion_state_json, goalSpec);
	return {
		sessionId: row.session_id,
		sessionPath: row.session_path,
		cwd: row.cwd,
		...(row.title !== null ? { title: row.title } : {}),
		...(row.preferred_model !== null ? { preferredModel: row.preferred_model } : {}),
		state: row.state,
		score: row.score,
		observedBytes: row.observed_bytes,
		goalSpec,
		completionState,
		controlState: parseControlState(row.control_state_json),
		...(row.last_summary !== null ? { lastSummary: row.last_summary } : {}),
		...(row.last_error !== null ? { lastError: row.last_error } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.last_event_at !== null ? { lastEventAt: row.last_event_at } : {}),
	};
}

function rowToEvent(row: AgiEventRow): AgiGatewayEvent {
	return {
		id: row.id,
		sessionId: row.session_id,
		type: row.type,
		payload: JSON.parse(row.payload_json) as Record<string, unknown>,
		createdAt: row.created_at,
		...(row.processed_at !== null ? { processedAt: row.processed_at } : {}),
	};
}

function rowToAction(row: AgiActionRow): AgiGatewayAction {
	return {
		id: row.id,
		sessionId: row.session_id,
		...(row.event_id !== null ? { eventId: row.event_id } : {}),
		actionType: row.action_type,
		instruction: row.instruction,
		status: row.status,
		createdAt: row.created_at,
		...(row.started_at !== null ? { startedAt: row.started_at } : {}),
		...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
		...(row.result_json !== null ? { result: JSON.parse(row.result_json) as Record<string, unknown> } : {}),
		...(row.last_error !== null ? { lastError: row.last_error } : {}),
	};
}
