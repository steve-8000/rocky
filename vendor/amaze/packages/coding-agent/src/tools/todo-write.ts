import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@amaze/agent-core";
import type { Component } from "@amaze/tui";
import { Text } from "@amaze/tui";
import { prompt } from "@amaze/utils";
import chalk from "chalk";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { projectMissionToTodoPhases } from "../mission/core/mission-todo-projection";
import type { Theme } from "../modes/theme/theme";
import todoReadDescription from "../prompts/tools/todo-read.md" with { type: "text" };
import todoWriteDescription from "../prompts/tools/todo-write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-manager";
import { renderStatusLine } from "../tui";

// =============================================================================
// Types
// =============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/**
	 * Append-only list of freeform notes attached by `op: "note"`.
	 * Each element is one note and may itself be multi-line.
	 * Rendered as text only when the task is in_progress; otherwise shown as a
	 * dim marker indicating the task has notes.
	 */
	notes?: string[];
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export interface TodoWriteToolDetails {
	phases: TodoPhase[];
	storage: "session" | "memory";
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = z
	.enum(["init", "start", "done", "rm", "drop", "append", "note"] as const)
	.describe("operation to apply");

const InitListEntry = z.object({
	phase: z.string().describe("phase name"),
	items: z.array(z.string().describe("task content")).min(1).describe("tasks for this phase"),
});

const TodoOpEntry = z.object({
	op: TodoOp,
	list: z.array(InitListEntry).optional().describe("phased task list (init)"),
	task: z.string().optional().describe("task content"),
	phase: z.string().optional().describe("phase name"),
	items: z.array(z.string().describe("task content")).min(1).optional().describe("tasks to append"),
	text: z.string().optional().describe("note text"),
});

const todoWriteSchema = z
	.object({
		ops: z.array(TodoOpEntry).min(1).describe("ordered todo operations"),
	})
	.describe("apply ordered todo operations");
const todoReadSchema = z.object({}).describe("read the current todo phases");

type TodoReadParams = z.infer<typeof todoReadSchema>;

type TodoWriteParams = z.infer<typeof todoWriteSchema>;
type TodoOpEntryValue = TodoWriteParams["ops"][number];

// =============================================================================
// State helpers
// =============================================================================

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
	const out: TodoItem = { content: task.content, status: task.status };
	if (task.notes && task.notes.length > 0) out.notes = [...task.notes];
	return out;
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(task => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			const data = entry.data as { phases?: unknown } | undefined;
			if (data && Array.isArray(data.phases)) {
				return clonePhases(data.phases as TodoPhase[]);
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;

		return clonePhases(details.phases as TodoPhase[]);
	}

	return [];
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.list) {
		errors.push("Missing list for init operation");
		return [];
	}
	return entry.list.map(listEntry => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>(content => ({ content, status: "pending" })),
	}));
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		if (findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			return phases;
		}
		phase.tasks.push({ content, status: "pending" });
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) {
						candidate.status = "pending";
					}
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, entry, errors);
		case "note": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			const text = (entry.text ?? "").replace(/\s+$/u, "");
			if (!text) {
				errors.push("Missing text for note operation");
				return phases;
			}
			hit.task.notes = hit.task.notes ? [...hit.task.notes, text] : [text];
			return phases;
		}
		case "append":
			return appendItems(phases, entry, errors);
	}
}

function applyParams(phases: TodoPhase[], params: TodoWriteParams): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = phases;
	for (const entry of params.ops) {
		next = applyEntry(next, entry, errors);
	}
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

function applyParamsToMission(
	mission: NonNullable<ReturnType<NonNullable<ToolSession["getActiveMission"]>>>,
	params: TodoWriteParams,
): { phases: TodoPhase[]; errors: string[]; notices: string[] } {
	const errors: string[] = [];
	const notices: string[] = [];
	const previousPhases = projectMissionToTodoPhases(mission);

	// Mission-projection phases other than `Execution` (Frame, Decision, Regression,
	// Verification) are synthesized from mission state. Their tasks ("Decision record",
	// "Verification verdict", etc.) advance only when the model calls the corresponding
	// mission runtime tool — not via `todo_write`. Silently skipping such ops (as the
	// previous implementation did via a hidden lookup miss) surfaced as confusing
	// `Task "X" not found` errors and aborted whole batches. We pre-filter and emit a
	// notice instead, so the agent learns the right surface without erroring out.
	const syntheticPhaseNames = new Set<string>();
	const syntheticTaskContents = new Set<string>();
	for (const phase of previousPhases) {
		if (phase.name === "Execution") continue;
		syntheticPhaseNames.add(phase.name);
		for (const task of phase.tasks) syntheticTaskContents.add(task.content);
	}
	const projectionAdvice =
		"Mission-projection items advance through mission runtime tools (e.g. `/mission decision record`, `/mission verify`, `/mission complete`), not `todo_write`.";

	let executionPhase = previousPhases.find(phase => phase.name === "Execution");
	if (!executionPhase) {
		executionPhase = { name: "Execution", tasks: [] };
	}
	for (const entry of params.ops) {
		if (entry.task && syntheticTaskContents.has(entry.task)) {
			const supplemental = describeRecordedSyntheticState(mission, entry.task);
			const base = `Skipped op "${entry.op}" on "${entry.task}" — projection-only. ${projectionAdvice}`;
			notices.push(supplemental ? `${base} ${supplemental}` : base);
			continue;
		}
		if (entry.phase && syntheticPhaseNames.has(entry.phase)) {
			notices.push(`Skipped op "${entry.op}" on phase "${entry.phase}" — projection-only. ${projectionAdvice}`);
			continue;
		}
		const before = executionPhase.tasks.length;
		const nextPhases = applyEntry([executionPhase], entry, errors);
		executionPhase = nextPhases[0] ?? { name: "Execution", tasks: [] };
		if (entry.op === "init") {
			mission.tasks = executionPhase.tasks.map((task, index) => ({
				id: `${mission.id}-todo-${index + 1}`,
				title: task.content,
				status: mapTodoStatusToMissionTaskStatus(task.status),
				...(task.notes && task.notes.length > 0 ? { notes: [...task.notes] } : {}),
			}));
			continue;
		}
		if (entry.op === "append" && executionPhase.tasks.length > before) {
			for (const task of executionPhase.tasks.slice(before)) {
				mission.tasks.push({
					id: `${mission.id}-todo-${mission.tasks.length + 1}`,
					title: task.content,
					status: mapTodoStatusToMissionTaskStatus(task.status),
					...(task.notes && task.notes.length > 0 ? { notes: [...task.notes] } : {}),
				});
			}
			continue;
		}
		syncMissionTasksFromExecutionPhase(mission, executionPhase);
		if (entry.op === "rm") {
			const remainingTitles = new Set(executionPhase.tasks.map(task => task.content));
			mission.tasks = mission.tasks.filter(task => remainingTitles.has(task.title));
		}
	}
	normalizeInProgressTask(executionPhase.tasks.length > 0 ? [executionPhase] : []);
	syncMissionTasksFromExecutionPhase(mission, executionPhase);
	mission.updatedAt = Date.now();
	return { phases: projectMissionToTodoPhases(mission), errors, notices };
}

function describeRecordedSyntheticState(
	mission: NonNullable<ReturnType<NonNullable<ToolSession["getActiveMission"]>>>,
	taskName: string | undefined,
): string | undefined {
	if (!taskName) return undefined;
	if (taskName === "Decision record" && mission.decisionId) {
		return `Decision is already recorded (decisionId=${mission.decisionId}); this row will project as completed on next session reload.`;
	}
	if (taskName === "Regression contract" && mission.regressionContractId) {
		return `Regression contract is already recorded (regressionContractId=${mission.regressionContractId}); this row will project as completed on next session reload.`;
	}
	if (taskName === "Verification verdict" && mission.verification?.verdict) {
		return `Verification is already recorded (verdict=${mission.verification.verdict}); this row will project as ${
			mission.verification.verdict === "pass" ? "completed" : "abandoned"
		} on next session reload.`;
	}
	return undefined;
}

function syncMissionTasksFromExecutionPhase(
	mission: NonNullable<ReturnType<NonNullable<ToolSession["getActiveMission"]>>>,
	executionPhase: TodoPhase,
): void {
	for (const projectedTask of executionPhase.tasks) {
		const missionTask = mission.tasks.find(task => task.title === projectedTask.content);
		if (!missionTask) continue;
		missionTask.status = mapTodoStatusToMissionTaskStatus(projectedTask.status);
		if (projectedTask.notes && projectedTask.notes.length > 0) {
			(missionTask as typeof missionTask & { notes?: string[] }).notes = [...projectedTask.notes];
		}
	}
}

function mapTodoStatusToMissionTaskStatus(status: TodoStatus) {
	switch (status) {
		case "completed":
			return "completed";
		case "in_progress":
			return "running";
		case "abandoned":
			return "cancelled";
		case "pending":
			return "pending";
	}
}

/** Apply an array of `todo_write`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoWriteParams["ops"],
): { phases: TodoPhase[]; errors: string[] } {
	return applyParams(clonePhases(currentPhases), { ops });
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
};

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}`);
		for (const task of phases[i].tasks) {
			out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}`);
			if (task.notes && task.notes.length > 0) {
				for (let j = 0; j < task.notes.length; j++) {
					if (j > 0) out.push("  >");
					for (const noteLine of task.notes[j].split("\n")) {
						out.push(noteLine === "" ? "  >" : `  > ${noteLine}`);
					}
				}
			}
		}
	}
	return `${out.join("\n")}\n`;
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
};

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;
	let currentTask: TodoItem | undefined;
	let noteBuf: string[] = [];

	const flushNote = () => {
		if (!currentTask || noteBuf.length === 0) {
			noteBuf = [];
			return;
		}
		while (noteBuf.length > 0 && noteBuf[noteBuf.length - 1] === "") noteBuf.pop();
		if (noteBuf.length === 0) return;
		const joined = noteBuf.join("\n");
		currentTask.notes = currentTask.notes ? [...currentTask.notes, joined] : [joined];
		noteBuf = [];
	};

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum];

		// Blockquote line attached to the current task: `  > text` or `  >`
		const noteMatch = /^\s*>\s?(.*)$/.exec(raw);
		if (noteMatch && currentTask) {
			const noteLine = noteMatch[1];
			if (noteLine === "") {
				// Blank `>` separates two distinct notes
				flushNote();
			} else {
				noteBuf.push(noteLine);
			}
			continue;
		}

		const trimmed = raw.trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			flushNote();
			currentTask = undefined;
			currentPhase = { name: headingMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		const taskMatch = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			flushNote();
			if (!currentPhase) {
				currentPhase = { name: "Todos", tasks: [] };
				phases.push(currentPhase);
			}
			const marker = taskMatch[1];
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-])`);
				currentTask = undefined;
				continue;
			}
			currentTask = { content: taskMatch[2].trim(), status };
			currentPhase.tasks.push(currentTask);
			continue;
		}

		flushNote();
		currentTask = undefined;
		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}
	flushNote();

	normalizeInProgressTask(phases);
	return { phases, errors };
}

function formatSummary(phases: TodoPhase[], errors: string[]): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	let currentIdx = phases.findIndex(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
		}
	}
	lines.push(
		`Phase ${currentIdx + 1}/${phases.length} "${current.name}" — ${done}/${current.tasks.length} tasks complete`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const sym =
				task.status === "completed"
					? "✓"
					: task.status === "in_progress"
						? "→"
						: task.status === "abandoned"
							? "✗"
							: "○";
			const noteCount = task.notes?.length ?? 0;
			const notesSuffix = noteCount > 0 ? ` (+${noteCount} note${noteCount === 1 ? "" : "s"})` : "";
			lines.push(`    ${sym} ${task.content}${notesSuffix}`);
			if (task.status === "in_progress" && task.notes && task.notes.length > 0) {
				for (let j = 0; j < task.notes.length; j++) {
					if (j > 0) lines.push("        ---");
					for (const noteLine of task.notes[j].split("\n")) {
						lines.push(`        ${noteLine}`);
					}
				}
			}
		}
	}
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoWriteTool implements AgentTool<typeof todoWriteSchema, TodoWriteToolDetails> {
	readonly name = "todo_write";
	readonly label = "Todo Write";
	readonly summary = "Write a structured todo list to track progress within a session";
	readonly description: string;
	readonly parameters = todoWriteSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoWriteDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoWriteParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoWriteToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoWriteToolDetails>> {
		const activeMission = this.session.getActiveMission?.();
		const result = activeMission
			? applyParamsToMission(activeMission, params)
			: { ...applyParams(clonePhases(this.session.getTodoPhases?.() ?? []), params), notices: [] as string[] };
		const { phases: updated, errors, notices } = result;
		// P6: when a mission is active, mission tasks are the single source of truth for the todo
		// projection. The legacy `setTodoPhases` cache caused the "stuck stored phases" bug where
		// stale synthetic projection rows were preserved across sessions. Only persist the cache
		// when no mission is bound; otherwise rely on the next projection read for hydration.
		if (!activeMission) {
			this.session.setTodoPhases?.(updated);
		}
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const summary = formatSummary(updated, errors);
		const text = notices.length > 0 ? `${notices.join("\n")}\n${summary}` : summary;

		return {
			content: [{ type: "text", text }],
			details: { phases: updated, storage },
			isError: errors.length > 0 ? true : undefined,
		};
	}
}

export class TodoReadTool implements AgentTool<typeof todoReadSchema, TodoWriteToolDetails> {
	readonly name = "todo_read";
	readonly label = "Todo Read";
	readonly summary = "Read the current structured todo list for this session";
	readonly description: string;
	readonly parameters = todoReadSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoReadDescription);
	}

	async execute(
		_toolCallId: string,
		_params: TodoReadParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoWriteToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoWriteToolDetails>> {
		const phases = clonePhases(this.session.getTodoPhases?.() ?? []);
		const storage = this.session.getSessionFile() ? "session" : "memory";

		return {
			content: [{ type: "text", text: formatSummary(phases, []) }],
			details: { phases, storage },
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

type TodoWriteRenderArgs = {
	ops?: Array<{
		op?: string;
		task?: string;
		phase?: string;
		items?: string[];
	}>;
};
// =============================================================================
// Phase numbering (display-only)
// =============================================================================

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** One-based ASCII roman numeral for display (I, II, III, IV, …). */
export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/** Display-only phase header: `I. Foundation`. State and prompts never see this. */
export function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${name}`;
}
function renderNoteAttachments(phases: TodoPhase[], uiTheme: Theme): string[] {
	const lines: string[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "in_progress" || !task.notes || task.notes.length === 0) continue;
			const bar = uiTheme.fg("dim", uiTheme.tree.vertical);
			const title = uiTheme.fg("dim", chalk.italic(`§ notes — ${task.content}`));
			lines.push("");
			lines.push(`  ${title}`);
			for (let j = 0; j < task.notes.length; j++) {
				if (j > 0) lines.push(`  ${bar}`);
				for (const noteLine of task.notes[j].split("\n")) {
					lines.push(`  ${bar} ${uiTheme.fg("dim", noteLine)}`);
				}
			}
		}
	}
	return lines;
}

function renderTodoResult(
	title: string,
	result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
	_options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
	const allTasks = phases.flatMap(phase => phase.tasks);
	if (allTasks.length === 0) {
		const header = renderStatusLine({ icon: "success", title, meta: ["empty"] }, uiTheme);
		const fallback = result.content?.find(content => content.type === "text")?.text ?? "No todos";
		return new Text(`${header}\n${uiTheme.fg("dim", fallback)}`, 0, 0);
	}
	const doneCount = allTasks.filter(task => task.status === "completed").length;
	const meta = [`${allTasks.length} task${allTasks.length === 1 ? "" : "s"}`, `${doneCount} done`];
	const header = renderStatusLine({ icon: "success", title, meta }, uiTheme);
	const noteLines = renderNoteAttachments(phases, uiTheme);
	if (noteLines.length === 0) {
		return new Text(header, 0, 0);
	}
	return new Text([header, ...noteLines].join("\n"), 0, 0);
}

export const todoReadToolRenderer = {
	renderCall(_args: unknown, _options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Todo Read" }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		return renderTodoResult("Todo Read", result, options, uiTheme);
	},
	mergeCallAndResult: true,
};

export const todoWriteToolRenderer = {
	renderCall(args: TodoWriteRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const ops = args?.ops?.map(entry => {
			const parts = [entry.op ?? "update"];
			if (entry.task) parts.push(entry.task);
			if (entry.phase) parts.push(entry.phase);
			if (entry.items?.length) parts.push(`${entry.items.length} item${entry.items.length === 1 ? "" : "s"}`);
			return parts.join(" ");
		}) ?? ["update"];
		const text = renderStatusLine({ icon: "pending", title: "Todo Write", meta: ops }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoWriteRenderArgs,
	): Component {
		return renderTodoResult("Todo Write", result, options, uiTheme);
	},
	mergeCallAndResult: true,
};
