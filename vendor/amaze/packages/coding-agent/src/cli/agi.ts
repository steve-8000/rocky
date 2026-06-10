import { AgiGatewayStore, buildAgiControlState } from "../agi/store";
import { AgiSupervisor } from "../agi/supervisor";
import { renderAgiStatusText, runAgiTui } from "../agi/tui";
import { SessionManager } from "../session/session-manager";

export interface AgiCommandArgs {
	action?: string;
	session?: string;
	db?: string;
	cwd?: string;
	tickMs?: number;
	once?: boolean;
}

export async function runAgiCommand(args: AgiCommandArgs = {}): Promise<void> {
	const action = args.action ?? "tui";
	if (action === "tui") {
		await runAgiTui({ dbPath: args.db, cwd: args.cwd, tickMs: args.tickMs });
		return;
	}

	const store = new AgiGatewayStore(args.db);
	try {
		if (action === "status") {
			process.stdout.write(renderAgiStatusText(store.listSessions(), store.overallScore()));
			return;
		}
		if (action === "events") {
			const sessionId = args.session ? resolveMonitoredSession(store, args.session).sessionId : undefined;
			for (const event of store.listEvents(sessionId)) {
				process.stdout.write(
					`${event.sessionId}\t${event.type}\t${event.createdAt}\t${JSON.stringify(event.payload)}\n`,
				);
			}
			return;
		}
		if (action === "actions") {
			const sessionId = args.session ? resolveMonitoredSession(store, args.session).sessionId : undefined;
			for (const item of store.listActions(sessionId)) {
				process.stdout.write(
					`${item.sessionId}\t${item.status}\t${item.actionType}\t${item.createdAt}\t${JSON.stringify(item.result ?? {})}\n`,
				);
			}
			return;
		}
		if (action === "add") {
			if (!args.session) throw new Error("agi add requires --session <id-or-path>");
			const session = await resolveSession(args.session, args.cwd ?? process.cwd());
			const attached = store.addSession({
				sessionId: session.id,
				sessionPath: session.path,
				cwd: session.cwd,
				title: session.title,
			});
			process.stdout.write(
				`${attached.sessionId}\t${attached.state}\t${attached.score}/100\t${attached.sessionPath}\n`,
			);
			return;
		}
		if (action === "run") {
			const supervisor = new AgiSupervisor({ store, tickMs: args.tickMs });
			if (args.once) {
				const result = await supervisor.tick();
				process.stdout.write(`AGI Gateway score: ${result.score}/100\n`);
				return;
			}
			const handle = supervisor.start();
			await handle.done;
			process.stdout.write(`AGI Gateway score: ${store.overallScore()}/100\n`);
			return;
		}

		if (!args.session) throw new Error(`agi ${action} requires --session <id-or-path>`);
		const monitored = resolveMonitoredSession(store, args.session);
		if (action === "pause") {
			const updated = store.updateSession(monitored.sessionId, {
				state: "paused",
				score: monitored.score,
				completionState: monitored.completionState,
				controlState: buildAgiControlState({
					...monitored.controlState,
					waitReason: "Paused by operator.",
					blockedReason: undefined,
					activeActionId: undefined,
				}),
			});
			process.stdout.write(`${updated.sessionId}\t${updated.state}\n`);
			return;
		}
		if (action === "resume") {
			const updated = store.updateSession(monitored.sessionId, {
				state: "watching",
				score: monitored.score,
				completionState: monitored.completionState,
				controlState: buildAgiControlState({
					...monitored.controlState,
					waitReason: undefined,
					blockedReason: undefined,
					activeActionId: undefined,
					nextRetryAt: undefined,
				}),
			});
			process.stdout.write(`${updated.sessionId}\t${updated.state}\n`);
			return;
		}
		if (action === "unblock") {
			const updated = store.updateSession(monitored.sessionId, {
				state: "watching",
				score: monitored.score,
				completionState: monitored.completionState,
				controlState: buildAgiControlState({
					...monitored.controlState,
					retryCount: 0,
					failureCount: monitored.controlState.failureCount,
					waitReason: undefined,
					blockedReason: undefined,
					activeActionId: undefined,
					nextRetryAt: undefined,
				}),
				lastError: null,
			});
			process.stdout.write(`${updated.sessionId}\t${updated.state}\n`);
			return;
		}
		if (action === "remove") {
			const removed = store.removeSession(monitored.sessionId);
			process.stdout.write(`${monitored.sessionId}\t${removed ? "removed" : "missing"}\n`);
			return;
		}

		throw new Error(`Unknown agi action: ${action}`);
	} finally {
		store.close();
	}
}

function resolveMonitoredSession(store: AgiGatewayStore, sessionArg: string) {
	const normalized = sessionArg.toLowerCase();
	const session = store
		.listSessions()
		.find(
			candidate => candidate.sessionId.toLowerCase().startsWith(normalized) || candidate.sessionPath === sessionArg,
		);
	if (!session) throw new Error(`Monitored AGI session not found: ${sessionArg}`);
	return session;
}

async function resolveSession(sessionArg: string, cwd: string) {
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		const manager = await SessionManager.open(sessionArg);
		const header = manager.getHeader();
		const sessionPath = manager.getSessionFile() ?? sessionArg;
		return {
			id: manager.getSessionId(),
			path: sessionPath,
			cwd: manager.getCwd(),
			title: header?.title,
		};
	}

	const sessions = await SessionManager.listAll();
	const localFirst = sessions.sort((a, b) => {
		const aLocal = a.cwd === cwd ? 0 : 1;
		const bLocal = b.cwd === cwd ? 0 : 1;
		if (aLocal !== bLocal) return aLocal - bLocal;
		return b.modified.getTime() - a.modified.getTime();
	});
	const normalized = sessionArg.toLowerCase();
	const match = localFirst.find(session => session.id.toLowerCase().startsWith(normalized));
	if (!match) throw new Error(`Session "${sessionArg}" not found.`);
	return match;
}
