import * as path from "node:path";
import type { SessionEvent } from "../../observability";

export type ReplayGoalVerdict = "pass" | "fail" | "force" | null;

export interface ReplayReport {
	sessionId: string;
	eventsReplayed: number;
	decisions: {
		goalCompleteVerdict: ReplayGoalVerdict;
		subagentVerdicts: Array<{ taskId: string; verdict: "pass" | "fail" | "uncertain" }>;
	};
	networkCalls: 0;
	metadata?: {
		memoryPatch?: { adds?: string[]; removes?: string[] };
	};
}

export async function replaySession(
	sessionId: string,
	opts: { baseDir: string; events?: SessionEvent[]; memoryPatch?: { adds?: string[]; removes?: string[] } },
): Promise<ReplayReport> {
	const events = opts.events ?? (await readSessionEvents(path.join(opts.baseDir, `${sessionId}.jsonl`)));
	let goalCompleteVerdict: ReplayGoalVerdict = null;
	const subagentVerdicts: Array<{ taskId: string; verdict: "pass" | "fail" | "uncertain" }> = [];

	for (const event of events) {
		if (event.type === "goal.complete") goalCompleteVerdict = event.verdict;
		if (event.type === "subagent.end") {
			subagentVerdicts.push({ taskId: event.taskId, verdict: event.verdict });
		}
	}

	return {
		sessionId,
		eventsReplayed: events.length,
		decisions: { goalCompleteVerdict, subagentVerdicts },
		networkCalls: 0,
		...(opts.memoryPatch ? { metadata: { memoryPatch: opts.memoryPatch } } : {}),
	};
}

async function readSessionEvents(filePath: string): Promise<SessionEvent[]> {
	const file = Bun.file(filePath);
	const text = await file.text();
	const events: SessionEvent[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		events.push(JSON.parse(line) as SessionEvent);
	}
	return events;
}
