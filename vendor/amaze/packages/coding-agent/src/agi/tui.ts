import { type Component, Container, ProcessTerminal, TUI, truncateToWidth } from "@amaze/tui";
import { Input } from "@amaze/tui/components/input";
import { initTheme, theme } from "../modes/theme/theme";
import { type SessionInfo, SessionManager } from "../session/session-manager";
import { AgiGatewayStore, type AgiMonitoredSession, buildAgiControlState } from "./store";
import { AgiSupervisor } from "./supervisor";

export interface AgiTuiOptions {
	dbPath?: string;
	cwd?: string;
	tickMs?: number;
	targetScore?: number;
}

export async function runAgiTui(options: AgiTuiOptions = {}): Promise<void> {
	await initTheme();
	const store = new AgiGatewayStore(options.dbPath);
	try {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			process.stdout.write(renderAgiStatusText(store.listSessions(), store.overallScore()));
			return;
		}

		const supervisor = new AgiSupervisor({
			store,
			tickMs: options.tickMs,
			targetScore: options.targetScore,
		});
		const app = new AgiApp(store, supervisor, options.cwd ?? process.cwd());
		const ui = new TUI(new ProcessTerminal());
		ui.addChild(app);
		app.bindUi(ui);
		ui.start();
		await app.done;
		ui.stop();
		supervisor.stop();
	} finally {
		store.close();
	}
}

export function renderAgiStatusText(sessions: readonly AgiMonitoredSession[], score = 0): string {
	const lines = [`AGI Gateway score: ${score}/100`];
	if (sessions.length === 0) {
		lines.push("No monitored sessions. Run `amaze agi add --session <id>` or open `amaze agi` in a TTY.");
	} else {
		for (const session of sessions) {
			lines.push(
				`${session.sessionId}\t${session.state}\t${session.score}/100\t${session.title ?? "(untitled)"}\t${session.cwd}\t${session.sessionPath}`,
			);
			if (session.preferredModel) lines.push(`\tmodel\t${session.preferredModel}`);
			if (session.controlState.blockedReason) lines.push(`\tblocked\t${session.controlState.blockedReason}`);
			if (session.controlState.waitReason) lines.push(`\twaiting\t${session.controlState.waitReason}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

class AgiApp extends Container {
	#ui: TUI | undefined;
	#screen: AgiDashboardComponent;
	#refreshTimer: ReturnType<typeof setInterval> | undefined;
	#resolveDone!: () => void;
	readonly done: Promise<void>;

	constructor(
		private readonly store: AgiGatewayStore,
		private readonly supervisor: AgiSupervisor,
		private readonly cwd: string,
	) {
		super();
		this.done = new Promise(resolve => {
			this.#resolveDone = resolve;
		});
		this.#screen = new AgiDashboardComponent(store.listSessions(), store.overallScore(), {
			onAdd: () => void this.#openAddSession(),
			onPause: sessionId => this.#updateSession(sessionId, "paused"),
			onResume: sessionId => this.#resumeSession(sessionId),
			onUnblock: sessionId => this.#unblockSession(sessionId),
			onRemove: sessionId => this.#removeSession(sessionId),
			onCommand: sessionId => this.#openCommandConsole(sessionId),
			onQuit: () => this.#quit(),
		});
		this.addChild(this.#screen);
	}

	bindUi(ui: TUI): void {
		this.#ui = ui;
		ui.setFocus(this.#screen);
		this.supervisor.start();
		this.#refreshTimer = setInterval(() => this.#refresh(), 500);
		void this.supervisor.done.then(() => this.#refresh());
	}

	#refresh(): void {
		this.#screen.setStatus(this.store.listSessions(), this.store.overallScore());
		this.#ui?.requestRender();
	}

	#quit(): void {
		if (this.#refreshTimer) clearInterval(this.#refreshTimer);
		this.supervisor.stop();
		this.#resolveDone();
	}

	#updateSession(sessionId: string, state: AgiMonitoredSession["state"]): void {
		const session = this.store.getSession(sessionId);
		if (!session) return;
		this.store.updateSession(sessionId, {
			state,
			preferredModel: session.preferredModel ?? null,
			score: session.score,
			completionState: session.completionState,
			controlState: buildAgiControlState({
				...session.controlState,
				waitReason: state === "paused" ? "Paused by operator." : undefined,
				blockedReason: undefined,
				activeActionId: undefined,
				nextRetryAt: undefined,
			}),
			lastError: state === "paused" ? (session.lastError ?? null) : null,
		});
		this.#refresh();
	}

	#resumeSession(sessionId: string): void {
		this.#updateSession(sessionId, "watching");
	}

	#unblockSession(sessionId: string): void {
		const session = this.store.getSession(sessionId);
		if (!session) return;
		this.store.updateSession(sessionId, {
			state: "watching",
			preferredModel: session.preferredModel ?? null,
			score: session.score,
			completionState: session.completionState,
			controlState: buildAgiControlState({
				...session.controlState,
				retryCount: 0,
				waitReason: undefined,
				blockedReason: undefined,
				activeActionId: undefined,
				nextRetryAt: undefined,
			}),
			lastError: null,
		});
		this.#refresh();
	}

	#removeSession(sessionId: string): void {
		this.store.removeSession(sessionId);
		this.#refresh();
	}

	#queueInstruction(sessionId: string, instruction: string): void {
		const session = this.store.getSession(sessionId);
		if (!session) return;
		const action = this.store.createAction({
			sessionId,
			actionType: "manual_command",
			instruction,
		});
		this.store.updateSession(sessionId, {
			state: "waiting",
			preferredModel: session.preferredModel ?? null,
			score: session.score,
			completionState: session.completionState,
			controlState: buildAgiControlState({
				...session.controlState,
				activeActionId: action.id,
				waitReason: "Queued manual AGI command.",
			}),
		});
		this.store.recordEvent(sessionId, "session.command", { instruction });
		this.#refresh();
	}

	#setSessionModel(sessionId: string, model: string): void {
		const session = this.store.getSession(sessionId);
		if (!session) return;
		this.store.updateSession(sessionId, {
			state: session.state,
			preferredModel: model,
			score: session.score,
			completionState: session.completionState,
			controlState: session.controlState,
		});
		this.store.recordEvent(sessionId, "session.model_selected", { model });
		this.#refresh();
	}

	#openCommandConsole(sessionId: string): void {
		const ui = this.#ui;
		if (!ui) return;
		const session = this.store.getSession(sessionId);
		if (!session) return;
		let handle: ReturnType<TUI["showOverlay"]> | undefined;
		const overlay = new AgiCommandOverlay(session, {
			onSubmit: command => {
				handle?.hide();
				this.#executeConsoleCommand(sessionId, command);
				ui.requestRender();
			},
			onCancel: () => {
				handle?.hide();
				ui.requestRender();
			},
		});
		handle = ui.showOverlay(overlay, { width: "90%", maxHeight: "45%", anchor: "bottom-center" });
	}

	#executeConsoleCommand(sessionId: string, rawCommand: string): void {
		const command = rawCommand.trim();
		if (!command) return;
		const [verb, ...rest] = command.split(/\s+/);
		const body = rest.join(" ").trim();
		if (verb === "pause") {
			this.#updateSession(sessionId, "paused");
			return;
		}
		if (verb === "resume") {
			this.#resumeSession(sessionId);
			return;
		}
		if (verb === "unblock") {
			this.#unblockSession(sessionId);
			return;
		}
		if (verb === "remove") {
			this.#removeSession(sessionId);
			return;
		}
		if (verb === "model" && body.length > 0) {
			this.#setSessionModel(sessionId, body);
			return;
		}
		if ((verb === "run" || verb === "ask") && body.length > 0) {
			this.#queueInstruction(sessionId, body);
			return;
		}
		if (verb === "add") {
			void this.#openAddSession();
			return;
		}
	}

	async #openAddSession(): Promise<void> {
		const ui = this.#ui;
		if (!ui) return;
		const candidates = await listAttachableSessions(this.cwd, this.store.listSessions());
		let handle: ReturnType<TUI["showOverlay"]> | undefined;
		const overlay = new AgiAddSessionOverlay(candidates, {
			onSelect: session => {
				this.store.addSession({
					sessionId: session.id,
					sessionPath: session.path,
					cwd: session.cwd,
					title: session.title,
				});
				this.#refresh();
				handle?.hide();
				ui.requestRender();
			},
			onCancel: () => {
				handle?.hide();
				ui.requestRender();
			},
		});
		handle = ui.showOverlay(overlay, { width: "90%", maxHeight: "80%", anchor: "center" });
	}
}

interface AgiDashboardCallbacks {
	onAdd: () => void;
	onPause: (sessionId: string) => void;
	onResume: (sessionId: string) => void;
	onUnblock: (sessionId: string) => void;
	onRemove: (sessionId: string) => void;
	onCommand: (sessionId: string) => void;
	onQuit: () => void;
}

export class AgiDashboardComponent implements Component {
	#sessions: AgiMonitoredSession[];
	#score: number;
	#selectedIndex = 0;

	constructor(
		sessions: readonly AgiMonitoredSession[],
		score: number,
		private readonly callbacks: AgiDashboardCallbacks,
	) {
		this.#sessions = [...sessions];
		this.#score = score;
	}

	setStatus(sessions: readonly AgiMonitoredSession[], score: number): void {
		this.#sessions = [...sessions];
		this.#score = score;
		this.#selectedIndex = clampIndex(this.#selectedIndex, this.#sessions.length);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(20, width);
		const lines = [
			theme.bold(theme.fg("accent", "Amaze AGI Gateway")),
			theme.fg("muted", "Gateway watches session completion alarms and drives follow-up work until score 100."),
			`${theme.fg("accent", "score")} ${this.#score}/100`,
			"",
			`${theme.fg("accent", "a")} add  ${theme.fg("accent", ":")} command  ${theme.fg("accent", "p")} pause  ${theme.fg("accent", "r")} resume  ${theme.fg("accent", "u")} unblock  ${theme.fg("accent", "x")} remove  ${theme.fg("accent", "q")} quit`,
			"",
		];

		if (this.#sessions.length === 0) {
			lines.push(theme.fg("muted", "No sessions are attached yet. Press `a` to add a local Amaze session."));
			return lines.map(line => truncateToWidth(line, contentWidth));
		}

		lines.push(theme.bold("Monitored sessions"));
		for (const [index, session] of this.#sessions.entries()) {
			const title = session.title ?? "(untitled)";
			const state = formatState(session.state);
			const prefix = index === this.#selectedIndex ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const model = session.preferredModel ? ` [${session.preferredModel}]` : "";
			const headline = `${prefix}${state} ${session.score}/100 ${title}${model}`;
			lines.push(
				index === this.#selectedIndex
					? theme.fg("accent", truncateToWidth(headline, contentWidth))
					: truncateToWidth(headline, contentWidth),
			);
			lines.push(theme.fg("muted", truncateToWidth(`  ${session.sessionId}  ${session.cwd}`, contentWidth)));
			if (session.lastSummary) {
				lines.push(theme.fg("dim", truncateToWidth(`  ${session.lastSummary}`, contentWidth)));
			}
			if (session.controlState.waitReason) {
				lines.push(theme.fg("muted", truncateToWidth(`  ${session.controlState.waitReason}`, contentWidth)));
			}
			if (session.controlState.blockedReason) {
				lines.push(theme.fg("warning", truncateToWidth(`  ${session.controlState.blockedReason}`, contentWidth)));
			}
			if (session.lastError) {
				lines.push(theme.fg("error", truncateToWidth(`  ${session.lastError}`, contentWidth)));
			}
		}
		return lines;
	}

	handleInput(data: string): void {
		if (data === "a" || data === "A") {
			this.callbacks.onAdd();
			return;
		}
		if (data === ":" || data === "/") {
			const selected = this.#sessions[this.#selectedIndex];
			if (selected) this.callbacks.onCommand(selected.sessionId);
			return;
		}
		if (data === "\u001b[A") {
			this.#selectedIndex =
				this.#selectedIndex === 0 ? Math.max(0, this.#sessions.length - 1) : this.#selectedIndex - 1;
			return;
		}
		if (data === "\u001b[B") {
			this.#selectedIndex = this.#sessions.length === 0 ? 0 : (this.#selectedIndex + 1) % this.#sessions.length;
			return;
		}
		const selected = this.#sessions[this.#selectedIndex];
		if (!selected) {
			if (data === "q" || data === "Q" || data === "\u0003") this.callbacks.onQuit();
			return;
		}
		if (data === "p" || data === "P") {
			this.callbacks.onPause(selected.sessionId);
			return;
		}
		if (data === "r" || data === "R") {
			this.callbacks.onResume(selected.sessionId);
			return;
		}
		if (data === "u" || data === "U") {
			this.callbacks.onUnblock(selected.sessionId);
			return;
		}
		if (data === "x" || data === "X") {
			this.callbacks.onRemove(selected.sessionId);
			return;
		}
		if (data === "q" || data === "Q" || data === "\u0003") {
			this.callbacks.onQuit();
		}
	}
}

interface AgiAddSessionCallbacks {
	onSelect: (session: SessionInfo) => void;
	onCancel: () => void;
}

class AgiAddSessionOverlay implements Component {
	#selectedIndex = 0;
	#filterInput = new Input();

	constructor(
		private readonly sessions: readonly SessionInfo[],
		private readonly callbacks: AgiAddSessionCallbacks,
	) {
		this.#filterInput.onEscape = () => this.callbacks.onCancel();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(20, width - 4);
		const filterLines = this.#filterInput.render(contentWidth);
		const filtered = this.#filteredSessions();
		const lines = [
			theme.bold(theme.fg("accent", "Add AGI monitored session")),
			theme.fg("muted", "Type to filter all local sessions. Enter selects, Esc cancels."),
			...filterLines,
			"",
		];
		if (filtered.length === 0) {
			lines.push(theme.fg("muted", "No matching local Amaze sessions were found."));
			return box(lines, width);
		}
		this.#selectedIndex = clampIndex(this.#selectedIndex, filtered.length);
		const maxRows = 12;
		const start = Math.max(0, Math.min(this.#selectedIndex - Math.floor(maxRows / 2), filtered.length - maxRows));
		const end = Math.min(filtered.length, start + maxRows);
		for (let i = start; i < end; i += 1) {
			const session = filtered[i];
			const selected = i === this.#selectedIndex;
			const cursor = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const title = session.title ?? session.firstMessage;
			const firstLine = truncateToWidth(`${cursor}${title}`, contentWidth);
			lines.push(selected ? theme.fg("accent", firstLine) : firstLine);
			lines.push(theme.fg("muted", truncateToWidth(`    ${session.id}  ${session.cwd}`, contentWidth)));
		}
		if (filtered.length > maxRows) {
			lines.push(theme.fg("muted", `(${this.#selectedIndex + 1}/${filtered.length})`));
		}
		return box(lines, width);
	}

	handleInput(data: string): void {
		if (data === "\u001b") {
			this.callbacks.onCancel();
			return;
		}
		if (data === "\r" || data === "\n") {
			const session = this.#filteredSessions()[this.#selectedIndex];
			if (session) this.callbacks.onSelect(session);
			return;
		}
		if (data === "\u001b[A") {
			this.#selectedIndex =
				this.#selectedIndex === 0 ? Math.max(0, this.#filteredSessions().length - 1) : this.#selectedIndex - 1;
			return;
		}
		if (data === "\u001b[B") {
			const filtered = this.#filteredSessions();
			this.#selectedIndex = filtered.length === 0 ? 0 : (this.#selectedIndex + 1) % filtered.length;
			return;
		}
		this.#filterInput.handleInput(data);
		this.#selectedIndex = 0;
	}

	#filteredSessions(): SessionInfo[] {
		const query = this.#filterInput.getValue().trim().toLowerCase();
		if (!query) return [...this.sessions];
		return this.sessions.filter(session => {
			const haystack = `${session.id} ${session.cwd} ${session.title ?? ""} ${session.firstMessage}`.toLowerCase();
			return haystack.includes(query);
		});
	}
}

interface AgiCommandOverlayCallbacks {
	onSubmit: (command: string) => void;
	onCancel: () => void;
}

class AgiCommandOverlay implements Component {
	#input = new Input();

	constructor(
		private readonly session: AgiMonitoredSession,
		private readonly callbacks: AgiCommandOverlayCallbacks,
	) {
		this.#input.onSubmit = value => this.callbacks.onSubmit(value);
		this.#input.onEscape = () => this.callbacks.onCancel();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(20, width - 4);
		const lines = [
			theme.bold(theme.fg("accent", `Command console — ${this.session.title ?? this.session.sessionId}`)),
			theme.fg(
				"muted",
				"Commands: model <provider/id> | ask <text> | run <text> | pause | resume | unblock | remove | add",
			),
			...this.#input.render(contentWidth),
		];
		return box(lines, width);
	}

	handleInput(data: string): void {
		this.#input.handleInput(data);
	}
}

async function listAttachableSessions(cwd: string, attached: readonly AgiMonitoredSession[]): Promise<SessionInfo[]> {
	const attachedIds = new Set(attached.map(session => session.sessionId));
	const sessions = await SessionManager.listAll();
	return sessions
		.filter(session => !attachedIds.has(session.id) && session.cwd.length > 0)
		.sort((a, b) => {
			const aLocal = a.cwd === cwd ? 0 : 1;
			const bLocal = b.cwd === cwd ? 0 : 1;
			if (aLocal !== bLocal) return aLocal - bLocal;
			return b.modified.getTime() - a.modified.getTime();
		});
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

function formatState(state: AgiMonitoredSession["state"]): string {
	if (state === "watching") return theme.fg("success", "watching");
	if (state === "waiting") return theme.fg("muted", "waiting");
	if (state === "blocked") return theme.fg("warning", "blocked");
	if (state === "paused") return theme.fg("warning", "paused");
	if (state === "completed") return theme.fg("accent", "completed");
	return theme.fg("error", "error");
}

function box(lines: string[], width: number): string[] {
	const innerWidth = Math.max(20, width - 4);
	const horizontal = "─".repeat(innerWidth + 2);
	const output = [`╭${horizontal}╮`];
	for (const line of lines) {
		output.push(`│ ${truncateToWidth(line, innerWidth, undefined, true)} │`);
	}
	output.push(`╰${horizontal}╯`);
	return output;
}
