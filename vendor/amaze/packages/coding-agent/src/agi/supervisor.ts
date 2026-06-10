import * as fs from "node:fs/promises";
import * as path from "node:path";
import { procmgr } from "@amaze/utils";
import {
	type AgiControlState,
	type AgiGatewayAction,
	type AgiGatewayEvent,
	type AgiGatewayStore,
	type AgiMonitoredSession,
	type AgiStructuredResult,
	buildAgiCompletionState,
	buildAgiControlState,
} from "./store";

export interface AgiSupervisorOptions {
	store: AgiGatewayStore;
	tickMs?: number;
	targetScore?: number;
	driver?: AgiActionDriver;
	now?: () => number;
}

export interface AgiSupervisorHandle {
	stop(): void;
	readonly running: boolean;
	done: Promise<void>;
}

export interface AgiActionDriver {
	run(action: AgiGatewayAction, session: AgiMonitoredSession): Promise<AgiActionDriverResult>;
}

export interface AgiActionDriverResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface AgiTickResult {
	score: number;
	observed: number;
	actionsCreated: number;
	actionsCompleted: number;
}

const DEFAULT_TICK_MS = 3000;
const DEFAULT_TARGET_SCORE = 100;
const MAX_SUMMARY_CHARS = 600;
const MAX_ACTION_RETRIES = 3;
const BASE_RETRY_MS = 5000;
const WAIT_IDLE_TICKS = 2;
const BLOCK_IDLE_TICKS = 6;
const FOLLOW_UP_PROMPT =
	"AGI Gateway requires continued progress toward full `amaze agi` control. Continue the next smallest safe implementation step, keep context bounded, and do not stop until the initial AGI build goal is genuinely complete.";

export class AgiSupervisor {
	readonly #store: AgiGatewayStore;
	readonly #tickMs: number;
	readonly #targetScore: number;
	readonly #driver: AgiActionDriver;
	readonly #now: () => number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running = false;
	#stopping = false;
	#doneResolve!: () => void;
	#doneReject!: (error: unknown) => void;
	readonly #done: Promise<void>;

	constructor(options: AgiSupervisorOptions) {
		this.#store = options.store;
		this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
		this.#targetScore = options.targetScore ?? DEFAULT_TARGET_SCORE;
		this.#driver = options.driver ?? new CliAgiActionDriver();
		this.#now = options.now ?? Date.now;
		this.#done = new Promise((resolve, reject) => {
			this.#doneResolve = resolve;
			this.#doneReject = reject;
		});
	}

	get running(): boolean {
		return this.#running;
	}

	get done(): Promise<void> {
		return this.#done;
	}

	start(): AgiSupervisorHandle {
		if (!this.#running) {
			this.#running = true;
			void this.#loop();
		}
		const supervisor = this;
		return {
			stop: () => supervisor.stop(),
			get running() {
				return supervisor.running;
			},
			done: supervisor.#done,
		};
	}

	stop(): void {
		this.#stopping = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (!this.#running) this.#doneResolve();
	}

	async tick(): Promise<AgiTickResult> {
		const observed = await observeSessions(this.#store, this.#targetScore, this.#now);
		const actionsCreated = planActions(this.#store, this.#targetScore, this.#now);
		const actionsCompleted = await runPendingActions(this.#store, this.#driver, this.#targetScore, this.#now);
		const score = this.#store.overallScore();
		return { score, observed, actionsCreated, actionsCompleted };
	}

	async #loop(): Promise<void> {
		try {
			while (!this.#stopping) {
				const result = await this.tick();
				if (result.score >= this.#targetScore) break;
				await new Promise<void>(resolve => {
					this.#timer = setTimeout(resolve, this.#tickMs);
				});
				this.#timer = undefined;
			}
			this.#running = false;
			this.#doneResolve();
		} catch (error) {
			this.#running = false;
			this.#doneReject(error);
		}
	}
}

export async function observeSessions(
	store: AgiGatewayStore,
	targetScore = DEFAULT_TARGET_SCORE,
	now: () => number = Date.now,
): Promise<number> {
	let observed = 0;
	for (const session of store.listSessions()) {
		if (session.state === "paused" || session.state === "completed" || session.state === "blocked") continue;
		let stat: { size: number };
		try {
			stat = await fs.stat(session.sessionPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			store.updateSession(session.sessionId, {
				state: "blocked",
				controlState: nextControlState(session.controlState, {
					failureCount: session.controlState.failureCount + 1,
					blockedReason: `Session file unavailable: ${message}`,
				}),
				completionState: session.completionState,
				score: session.score,
				lastError: message,
			});
			store.recordEvent(
				session.sessionId,
				"session.blocked",
				{ message },
				{ id: eventId(session, "blocked", now()) },
			);
			observed += 1;
			continue;
		}

		if (stat.size <= session.observedBytes) {
			const idleTicks = session.controlState.consecutiveIdleTicks + 1;
			const pendingAction = store.listPendingActions().find(action => action.sessionId === session.sessionId);
			const waiting = session.score < targetScore && idleTicks >= WAIT_IDLE_TICKS;
			const blocked = idleTicks >= BLOCK_IDLE_TICKS && !pendingAction;
			store.updateSession(session.sessionId, {
				state: blocked ? "blocked" : waiting ? "waiting" : session.state,
				controlState: nextControlState(session.controlState, {
					consecutiveIdleTicks: idleTicks,
					waitReason: waiting ? "Waiting for additional session progress." : undefined,
					blockedReason: blocked ? "No session progress observed for repeated AGI control ticks." : undefined,
				}),
				completionState: session.completionState,
				score: session.score,
			});
			continue;
		}

		const delta = await readSessionDelta(session.sessionPath, session.observedBytes);
		const analysis = analyzeSessionDelta(delta, session.goalSpec.markerPrefix, stat.size);
		const completionState = withCompletionUpdate(session, {
			assistantTurnCompleted: analysis.hasAssistantEnd,
			structuredResult: analysis.structuredResult,
			summary: analysis.summary,
		});
		const controlState = nextControlState(session.controlState, {
			consecutiveIdleTicks: 0,
			waitReason: undefined,
			blockedReason: undefined,
			lastProgressAt: now(),
		});
		const state =
			completionState.complete && completionState.score >= targetScore
				? "completed"
				: analysis.hasAssistantEnd
					? "watching"
					: "waiting";
		store.updateSession(session.sessionId, {
			state,
			score: completionState.score,
			observedBytes: stat.size,
			completionState,
			controlState,
			lastSummary: completionState.summary ?? analysis.summary,
			lastError: null,
			lastEventAt: now(),
		});
		store.recordEvent(
			session.sessionId,
			analysis.eventType,
			{
				score: completionState.score,
				summary: completionState.summary ?? analysis.summary,
				structuredResultSeen: completionState.structuredResultSeen,
				complete: completionState.complete,
				missingCriteria: completionState.missingCriteria,
			},
			{ id: eventId(session, analysis.eventType, stat.size), createdAt: now() },
		);
		observed += 1;
	}
	return observed;
}

export function planActions(
	store: AgiGatewayStore,
	targetScore = DEFAULT_TARGET_SCORE,
	now: () => number = Date.now,
): number {
	let created = 0;
	for (const event of store.listUnprocessedEvents()) {
		const session = store.getSession(event.sessionId);
		if (!session || session.state === "paused" || session.state === "completed" || session.state === "blocked") {
			store.markEventProcessed(event.id);
			continue;
		}
		if (session.completionState.complete && session.score >= targetScore) {
			store.updateSession(session.sessionId, {
				state: "completed",
				score: 100,
				completionState: session.completionState,
				controlState: nextControlState(session.controlState, {
					waitReason: undefined,
					blockedReason: undefined,
				}),
			});
			store.markEventProcessed(event.id);
			continue;
		}
		if (event.type === "session.turn_completed" && !store.getActionForEvent(event.id)) {
			if (session.controlState.nextRetryAt && session.controlState.nextRetryAt > now()) {
				store.updateSession(session.sessionId, {
					state: "waiting",
					completionState: session.completionState,
					controlState: nextControlState(session.controlState, {
						waitReason: `Retry scheduled for ${new Date(session.controlState.nextRetryAt).toISOString()}.`,
					}),
					score: session.score,
				});
				store.markEventProcessed(event.id);
				continue;
			}
			const action = store.createAction({
				sessionId: session.sessionId,
				eventId: event.id,
				actionType: "follow_up_turn",
				instruction: buildFollowUpInstruction(session, event),
			});
			store.updateSession(session.sessionId, {
				state: "waiting",
				completionState: session.completionState,
				controlState: nextControlState(session.controlState, {
					activeActionId: action.id,
					waitReason: "Queued AGI follow-up action.",
				}),
				score: session.score,
			});
			created += 1;
		}
		store.markEventProcessed(event.id);
	}
	return created;
}

export async function runPendingActions(
	store: AgiGatewayStore,
	driver: AgiActionDriver,
	targetScore = DEFAULT_TARGET_SCORE,
	now: () => number = Date.now,
): Promise<number> {
	let completed = 0;
	for (const action of store.listPendingActions()) {
		const session = store.getSession(action.sessionId);
		if (!session) {
			store.markActionFailed(action.id, `AGI session not found: ${action.sessionId}`);
			continue;
		}
		store.markActionRunning(action.id);
		store.updateSession(action.sessionId, {
			state: "waiting",
			completionState: session.completionState,
			controlState: nextControlState(session.controlState, {
				activeActionId: action.id,
				waitReason: "Running AGI follow-up action.",
				lastActionAt: now(),
			}),
			score: session.score,
		});
		try {
			const result = await driver.run(action, session);
			if (result.exitCode === 0) {
				const refreshed = store.getSession(action.sessionId) ?? session;
				const completionState = withCompletionUpdate(refreshed, {
					actionExecuted: true,
					summary: refreshed.lastSummary ?? refreshed.completionState.summary,
				});
				store.markActionCompleted(action.id, {
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				});
				store.updateSession(action.sessionId, {
					state: completionState.complete && completionState.score >= targetScore ? "completed" : "watching",
					score: completionState.score,
					completionState,
					controlState: nextControlState(refreshed.controlState, {
						retryCount: 0,
						activeActionId: undefined,
						waitReason: undefined,
						blockedReason: undefined,
						lastActionAt: now(),
					}),
					lastError: null,
				});
				store.recordEvent(action.sessionId, "action.completed", {
					actionId: action.id,
					score: completionState.score,
				});
				completed += 1;
			} else {
				handleActionFailure(
					store,
					session,
					action,
					result.stderr || result.stdout || `exit ${result.exitCode}`,
					now,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			handleActionFailure(store, session, action, message, now);
		}
	}
	return completed;
}

export class CliAgiActionDriver implements AgiActionDriver {
	async run(action: AgiGatewayAction, session: AgiMonitoredSession): Promise<AgiActionDriverResult> {
		const proc = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "cli.ts"),
				"launch",
				"--resume",
				session.sessionPath,
				...(session.preferredModel ? ["--model", session.preferredModel] : []),
				"--print",
				action.instruction,
			],
			{
				cwd: session.cwd || process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
				env: procmgr.scrubProcessEnv(process.env),
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			Bun.readableStreamToText(proc.stdout as ReadableStream<Uint8Array>),
			Bun.readableStreamToText(proc.stderr as ReadableStream<Uint8Array>),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}
}

async function readSessionDelta(sessionPath: string, fromByte: number): Promise<string> {
	const file = Bun.file(sessionPath);
	const buffer = await file.arrayBuffer();
	const slice = buffer.slice(Math.max(0, fromByte));
	return new TextDecoder().decode(slice);
}

interface DeltaAnalysis {
	eventType: string;
	summary: string;
	hasAssistantEnd: boolean;
	structuredResult?: AgiStructuredResult;
}

function analyzeSessionDelta(delta: string, markerPrefix: string, totalBytes: number): DeltaAnalysis {
	const entries = delta
		.split(/\r?\n/)
		.filter(Boolean)
		.map(line => safeParseJson(line))
		.filter((entry): entry is Record<string, unknown> => entry !== undefined);
	const assistantTexts: string[] = [];
	let hasAssistantEnd = false;
	let hasError = false;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") continue;
		hasAssistantEnd = true;
		const stopReason = record.stopReason;
		if (stopReason === "error" || stopReason === "aborted") hasError = true;
		assistantTexts.push(extractText(record.content));
	}
	const structuredResult = extractStructuredResult(assistantTexts, markerPrefix);
	const summaryText = assistantTexts.map(text => stripStructuredLines(text, markerPrefix)).join("\n");
	const compact = compactSummary(summaryText);
	const summary =
		structuredResult?.summary ?? (compact || `${entries.length} new session entries, ${totalBytes} bytes observed`);
	return {
		eventType: hasError ? "session.error" : hasAssistantEnd ? "session.turn_completed" : "session.changed",
		summary,
		hasAssistantEnd,
		...(structuredResult ? { structuredResult } : {}),
	};
}

function extractStructuredResult(texts: string[], markerPrefix: string): AgiStructuredResult | undefined {
	for (let i = texts.length - 1; i >= 0; i -= 1) {
		const lines = texts[i]?.split(/\r?\n/) ?? [];
		for (let j = lines.length - 1; j >= 0; j -= 1) {
			const line = lines[j]?.trim();
			if (!line?.startsWith(markerPrefix)) continue;
			const payloadText = line.slice(markerPrefix.length).trim();
			if (!payloadText.startsWith("{")) continue;
			try {
				const payload = JSON.parse(payloadText) as Partial<AgiStructuredResult>;
				if (!Array.isArray(payload.satisfiedCriteria) || typeof payload.complete !== "boolean") continue;
				return {
					score: clampScore(typeof payload.score === "number" ? payload.score : 0),
					complete: payload.complete,
					satisfiedCriteria: payload.satisfiedCriteria.filter(
						(value): value is string => typeof value === "string",
					),
					...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
				};
			} catch {}
		}
	}
	return undefined;
}

function stripStructuredLines(text: string, markerPrefix: string): string {
	return text
		.split(/\r?\n/)
		.filter(line => !line.trim().startsWith(markerPrefix))
		.join("\n");
}

function safeParseJson(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function compactSummary(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > MAX_SUMMARY_CHARS ? `${normalized.slice(0, MAX_SUMMARY_CHARS - 1)}…` : normalized;
}

function buildFollowUpInstruction(session: AgiMonitoredSession, event: AgiGatewayEvent): string {
	const summary = typeof event.payload.summary === "string" ? event.payload.summary : session.lastSummary;
	const agentCriteria = session.goalSpec.criteria.filter(criterion => criterion.source === "agent");
	const criterionLines = agentCriteria.map(criterion => `- ${criterion.id}: ${criterion.description}`).join("\n");
	const markerExample = `${session.goalSpec.markerPrefix} {"score":80,"complete":false,"satisfiedCriteria":["${agentCriteria[0]?.id ?? "context_boundaries_preserved"}"],"summary":"short status"}`;
	return [
		FOLLOW_UP_PROMPT,
		`Current AGI Gateway score: ${session.score}/100.`,
		summary ? `Last observed summary: ${summary}` : undefined,
		"At the end of your response, emit exactly one single-line structured completion marker.",
		`Marker format: ${markerExample}`,
		"Only report agent-owned criteria that are truly satisfied:",
		criterionLines,
		"Do not claim complete=true unless every required AGI build criterion is actually satisfied.",
	]
		.filter(Boolean)
		.join("\n\n");
}

function withCompletionUpdate(
	session: AgiMonitoredSession,
	update: {
		assistantTurnCompleted?: boolean;
		actionExecuted?: boolean;
		structuredResult?: AgiStructuredResult;
		summary?: string;
	},
) {
	const supervisorCriteria = new Set(session.completionState.supervisorSatisfiedCriteria);
	const agentCriteria = new Set(session.completionState.agentSatisfiedCriteria);
	if (update.assistantTurnCompleted) supervisorCriteria.add("completion_alarm_detected");
	if (update.actionExecuted) supervisorCriteria.add("follow_up_turn_executed");
	if (update.structuredResult) {
		const allowedAgentCriteria = new Set(
			session.goalSpec.criteria.filter(criterion => criterion.source === "agent").map(criterion => criterion.id),
		);
		for (const criterionId of update.structuredResult.satisfiedCriteria) {
			if (allowedAgentCriteria.has(criterionId)) agentCriteria.add(criterionId);
		}
	}
	const allCriterionIds = session.goalSpec.criteria.map(criterion => criterion.id);
	const satisfied = new Set([...supervisorCriteria, ...agentCriteria]);
	const allCriteriaSatisfied = allCriterionIds.every(id => satisfied.has(id));
	const completeSignal = update.structuredResult?.complete ?? session.completionState.complete;
	const scoreFromCriteria = Math.floor((satisfied.size * 100) / allCriterionIds.length);
	const score = allCriteriaSatisfied ? (completeSignal ? 100 : 95) : scoreFromCriteria;
	return buildAgiCompletionState(session.goalSpec, {
		score,
		complete: allCriteriaSatisfied && completeSignal,
		structuredResultSeen: session.completionState.structuredResultSeen || update.structuredResult !== undefined,
		reportedScore: update.structuredResult?.score ?? session.completionState.reportedScore,
		summary: update.structuredResult?.summary ?? update.summary ?? session.completionState.summary,
		agentSatisfiedCriteria: [...agentCriteria],
		supervisorSatisfiedCriteria: [...supervisorCriteria],
		lastStructuredResult: update.structuredResult ?? session.completionState.lastStructuredResult,
	});
}

function nextControlState(current: AgiControlState, patch: Partial<AgiControlState>): AgiControlState {
	return buildAgiControlState({
		retryCount: patch.retryCount ?? current.retryCount,
		failureCount: patch.failureCount ?? current.failureCount,
		consecutiveIdleTicks: patch.consecutiveIdleTicks ?? current.consecutiveIdleTicks,
		waitReason: patch.waitReason,
		blockedReason: patch.blockedReason,
		activeActionId: patch.activeActionId,
		lastActionAt: patch.lastActionAt ?? current.lastActionAt,
		lastProgressAt: patch.lastProgressAt ?? current.lastProgressAt,
		nextRetryAt: patch.nextRetryAt,
	});
}

function handleActionFailure(
	store: AgiGatewayStore,
	session: AgiMonitoredSession,
	action: AgiGatewayAction,
	error: string,
	now: () => number,
): void {
	const retryCount = session.controlState.retryCount + 1;
	const blocked = retryCount >= MAX_ACTION_RETRIES;
	const nextRetryAt = blocked ? undefined : now() + getRetryDelayMs(retryCount);
	store.markActionFailed(action.id, error);
	store.updateSession(action.sessionId, {
		state: blocked ? "blocked" : "waiting",
		score: session.score,
		completionState: session.completionState,
		controlState: nextControlState(session.controlState, {
			retryCount,
			failureCount: session.controlState.failureCount + 1,
			activeActionId: undefined,
			waitReason: blocked ? undefined : `Retry ${retryCount} scheduled after action failure.`,
			blockedReason: blocked ? `AGI action failed ${retryCount} times: ${error}` : undefined,
			nextRetryAt,
			lastActionAt: now(),
		}),
		lastError: error,
	});
	store.recordEvent(action.sessionId, blocked ? "session.blocked" : "action.failed", {
		actionId: action.id,
		error,
		retryCount,
		...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
	});
}

function getRetryDelayMs(attempt: number): number {
	return BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1);
}

function eventId(session: AgiMonitoredSession, type: string, discriminator: number): string {
	return `${session.sessionId}:${type}:${discriminator}`;
}

function clampScore(score: number): number {
	if (!Number.isFinite(score)) return 0;
	return Math.max(0, Math.min(100, Math.trunc(score)));
}
