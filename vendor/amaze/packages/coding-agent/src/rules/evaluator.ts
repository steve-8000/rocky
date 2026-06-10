import type { SessionEvent } from "../observability";
import { compileExpr, evaluate } from "./expr";
import type { Rule, RuleScan, RuleSeverity } from "./types";

type AggregateSpec =
	| { kind: "count" | "ratio" }
	| { kind: "distinct" }
	| { kind: "ratioExpr"; numerator: ReturnType<typeof compileExpr>; denominator: ReturnType<typeof compileExpr> };

const RATIO_EXPR_PATTERN = /^ratio\s+(?<num>.+?)\s*\/\s*(?<den>.+)$/;

export interface RuleFinding {
	ruleId: string;
	severity: RuleSeverity;
	count: number;
	windowSize: number;
	sampleEvents: SessionEvent[];
	message: string;
}

interface WindowSpec {
	last?: number;
	type?: string;
	since?: number;
}

interface SeverityBranch {
	condition?: string;
	severity: RuleSeverity;
}

interface RuleBucket {
	key: Record<string, unknown>;
	events: SessionEvent[];
}
const VALID_SCANS = new Set<RuleScan>(["events", "session", "request", "workspace"]);

const VALID_SEVERITIES = new Set<RuleSeverity>(["info", "warning", "high", "critical"]);

export function evaluateRule(rule: Rule, events: SessionEvent[]): RuleFinding | RuleFinding[] | null {
	if (!VALID_SCANS.has(rule.detect.scan)) {
		throw new Error(`Unsupported rule scan: ${rule.detect.scan}`);
	}

	const aggregate = parseAggregate(rule);
	if (aggregate instanceof Error) {
		return aggregateErrorFinding(rule, aggregate.message);
	}

	const findings = evaluateRuleGroups(rule, events, aggregate);
	if (rule.detect.scan === "events") {
		return findings[0] ?? null;
	}
	return findings;
}

function evaluateRuleGroups(rule: Rule, events: SessionEvent[], aggregate: AggregateSpec): RuleFinding[] {
	const windowEvents = selectWindow(events, rule.detect.window);
	const matchExpr = compileExpr(rule.detect.match);
	const checkExpr = compileExpr(normalizeCheckExpr(rule.detect.check));
	const findings: RuleFinding[] = [];
	for (const bucket of groupEvents(windowEvents, rule.detect.scan)) {
		if (bucket.events.length === 0) {
			continue;
		}
		const matchedEvents = bucket.events.filter(event => Boolean(evaluate(matchExpr, { $: event })));
		const count = aggregateValue(aggregate, matchedEvents, bucket.events.length);
		const windowSize = bucket.events.length;
		const ctx = {
			$: bucket.key,
			count,
			windowSize,
			thresholds: rule.detect.thresholds,
		};

		if (!evaluate(checkExpr, ctx)) {
			continue;
		}

		const severity = evaluateSeverity(rule, ctx);
		findings.push({
			ruleId: rule.id,
			severity,
			count,
			windowSize,
			sampleEvents: matchedEvents.slice(0, 3),
			message: `${rule.name}: ${count} matching event${count === 1 ? "" : "s"} in ${windowSize} event window`,
		});
	}
	return findings;
}

function groupEvents(events: SessionEvent[], scan: RuleScan): RuleBucket[] {
	if (scan === "events" || scan === "workspace") {
		return [{ key: {}, events }];
	}
	if (scan === "session") {
		return groupBy(events, event => ({ id: event.sessionId, key: { sessionId: event.sessionId } }));
	}
	return groupRequests(events);
}

function groupRequests(events: SessionEvent[]): RuleBucket[] {
	const buckets = new Map<string, RuleBucket>();
	const activeTurns = new Map<string, number>();
	for (const event of events) {
		if (event.type === "turn.start") {
			const turn = typeof event.turn === "number" ? event.turn : undefined;
			if (turn === undefined) {
				activeTurns.delete(event.sessionId);
				continue;
			}
			activeTurns.set(event.sessionId, turn);
		}

		const turn = activeTurns.get(event.sessionId);
		if (turn !== undefined) {
			const id = `${event.sessionId}\u0000${turn}`;
			let bucket = buckets.get(id);
			if (!bucket) {
				bucket = { key: { sessionId: event.sessionId, turn }, events: [] };
				buckets.set(id, bucket);
			}
			bucket.events.push(event);
		}

		if (event.type === "turn.end") {
			activeTurns.delete(event.sessionId);
		}
	}
	return [...buckets.values()];
}

function groupBy(
	events: SessionEvent[],
	keyFor: (event: SessionEvent) => { id: string; key: Record<string, unknown> },
): RuleBucket[] {
	const buckets = new Map<string, RuleBucket>();
	for (const event of events) {
		const { id, key } = keyFor(event);
		let bucket = buckets.get(id);
		if (!bucket) {
			bucket = { key, events: [] };
			buckets.set(id, bucket);
		}
		bucket.events.push(event);
	}
	return [...buckets.values()];
}

function selectWindow(events: SessionEvent[], rawWindow: unknown): SessionEvent[] {
	const window = normalizeWindow(rawWindow);
	let selected = events;
	if (window.type !== undefined) {
		selected = selected.filter(event => event.type === window.type);
	}
	if (window.since !== undefined) {
		const since = window.since;
		selected = selected.filter(event => event.ts >= since);
	}
	if (window.last !== undefined) {
		selected = selected.slice(-window.last);
	}
	return selected;
}

function normalizeWindow(rawWindow: unknown): WindowSpec {
	if (rawWindow === undefined || rawWindow === null) {
		return {};
	}
	if (typeof rawWindow !== "object" || Array.isArray(rawWindow)) {
		throw new Error("Rule window must be an object");
	}
	const record = rawWindow as Record<string, unknown>;
	const window: WindowSpec = {};
	if (record.last !== undefined) {
		if (!Number.isInteger(record.last) || (record.last as number) < 0) {
			throw new Error("Rule window.last must be a non-negative integer");
		}
		window.last = record.last as number;
	}
	if (record.type !== undefined) {
		if (typeof record.type !== "string") {
			throw new Error("Rule window.type must be a string");
		}
		window.type = record.type;
	}
	if (record.since !== undefined) {
		if (typeof record.since !== "number" || !Number.isFinite(record.since)) {
			throw new Error("Rule window.since must be a finite number");
		}
		window.since = record.since;
	}
	return window;
}

function parseAggregate(rule: Rule): AggregateSpec | Error {
	const aggregate = rule.detect.aggregate;
	if (aggregate === "count" || aggregate === "ratio") {
		return { kind: aggregate };
	}
	if (aggregate === "distinct") {
		return { kind: "distinct" };
	}

	const match = aggregate.match(RATIO_EXPR_PATTERN);
	if (!match?.groups) {
		return new Error(`Unsupported rule aggregate: ${aggregate}`);
	}

	try {
		return {
			kind: "ratioExpr",
			numerator: compileExpr(match.groups.num),
			denominator: compileExpr(match.groups.den),
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return new Error(`Unsupported rule aggregate: ${aggregate} (${detail})`);
	}
}

function aggregateValue(aggregate: AggregateSpec, matchedEvents: SessionEvent[], windowSize: number): number {
	if (aggregate.kind === "distinct") {
		return new Set(matchedEvents.map(event => event.sessionId)).size;
	}
	if (aggregate.kind === "ratio") {
		return windowSize === 0 ? 0 : matchedEvents.length / windowSize;
	}
	if (aggregate.kind === "ratioExpr") {
		let numerator = 0;
		let denominator = 0;
		for (const event of matchedEvents) {
			numerator += toFiniteNumber(evaluate(aggregate.numerator, { $: event }));
			denominator += toFiniteNumber(evaluate(aggregate.denominator, { $: event }));
		}
		return denominator === 0 ? 0 : numerator / denominator;
	}
	return matchedEvents.length;
}

function toFiniteNumber(value: unknown): number {
	const number = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(number) ? number : 0;
}

function normalizeCheckExpr(check: string): string {
	return check.replaceAll("$ratio", "$count");
}

function aggregateErrorFinding(rule: Rule, message: string): RuleFinding {
	return {
		ruleId: rule.id,
		severity: "critical",
		count: 0,
		windowSize: 0,
		sampleEvents: [],
		message,
	};
}

function evaluateSeverity(
	rule: Rule,
	ctx: { $: unknown; count: number; windowSize: number; thresholds?: Record<string, unknown> },
): RuleSeverity {
	const branches = parseSeverityBranches(rule.detect.severity);
	for (const branch of branches) {
		if (branch.condition === undefined || evaluate(compileExpr(branch.condition), ctx)) {
			return branch.severity;
		}
	}
	return rule.severity;
}

function parseSeverityBranches(rawSeverity: unknown): SeverityBranch[] {
	if (rawSeverity === undefined || rawSeverity === null) {
		return [];
	}
	if (typeof rawSeverity !== "object" || Array.isArray(rawSeverity)) {
		throw new Error("Rule detect.severity must be an object");
	}
	const record = rawSeverity as Record<string, unknown>;
	const branches: SeverityBranch[] = [];
	for (const key of ["if", "else if", "else"] as const) {
		if (record[key] === undefined) {
			continue;
		}
		if (typeof record[key] !== "string") {
			throw new Error(`Rule detect.severity.${key} must be a string`);
		}
		branches.push(parseSeverityBranch(key, record[key]));
	}
	return branches;
}

function parseSeverityBranch(key: "if" | "else if" | "else", source: string): SeverityBranch {
	if (key === "else") {
		const match = source.match(/^\s*"(info|warning|high|critical)"\s*$/);
		if (!match) {
			throw new Error("Rule detect.severity.else must be a quoted severity");
		}
		return { severity: match[1] as RuleSeverity };
	}

	const match = source.match(/^\s*(.*?)\s+then\s+"(info|warning|high|critical)"\s*$/);
	if (!match) {
		throw new Error(`Rule detect.severity.${key} must be '<expr> then "<severity>"'`);
	}
	const severity = match[2] as RuleSeverity;
	if (!VALID_SEVERITIES.has(severity)) {
		throw new Error(`Unsupported rule severity: ${severity}`);
	}
	return { condition: match[1], severity };
}
