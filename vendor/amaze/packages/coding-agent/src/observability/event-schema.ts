export type TokenUsage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
};

export type SessionEvent =
	| { type: "session.start"; sessionId: string; ts: number; cwd: string; agent: string }
	| { type: "turn.start"; sessionId: string; ts: number; turn: number }
	| { type: "turn.end"; sessionId: string; ts: number; turn: number; usage: TokenUsage }
	| { type: "tool.call"; sessionId: string; ts: number; tool: string; argsHash: string }
	| {
			type: "tool.result";
			sessionId: string;
			ts: number;
			tool: string;
			ok: boolean;
			durationMs: number;
			bytesIn?: number;
			bytesOut?: number;
	  }
	| { type: "goal.start"; sessionId: string; ts: number; goalId: string; title: string; criteriaCount: number }
	| {
			type: "goal.complete";
			sessionId: string;
			ts: number;
			goalId: string;
			verdict: "pass" | "fail" | "force";
			failedCount: number;
			uncertainCount: number;
	  }
	| {
			type: "subagent.start";
			sessionId: string;
			ts: number;
			taskId: string;
			role: string;
			isolated: boolean;
			hasContract: boolean;
			contractRevision?: number;
	  }
	| {
			type: "subagent.end";
			sessionId: string;
			ts: number;
			taskId: string;
			verdict: "pass" | "fail" | "uncertain";
			changedFiles: number;
			revisions: number;
	  }
	| { type: "memory.recall"; sessionId: string; ts: number; query: string; hits: number; usedHits: number }
	| { type: "memory.write"; sessionId: string; ts: number; memoryType: string; status: string }
	| { type: "skill.promote"; sessionId: string; ts: number; name: string; status: string }
	| {
			type: "verifier.criterion";
			sessionId: string;
			ts: number;
			goalId: string;
			criterionId: string;
			status: "pass" | "fail" | "uncertain";
			durationMs: number;
	  }
	| {
			type: "prompt.cache";
			sessionId: string;
			ts: number;
			readTokens: number;
			writeTokens: number;
			missReason?: string;
	  };
