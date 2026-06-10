import type { CompactionSettings } from "@amaze/agent-core/compaction";
import { effectiveReserveTokens, estimateTokens, resolveThresholdTokens } from "@amaze/agent-core/compaction";
import type { Model } from "@amaze/ai";
import { countTokens } from "@amaze/natives";
import { formatNumber } from "@amaze/utils";
import type { AgentSession } from "../../session/agent-session";
import type { Tool } from "../../tools";
import type { theme as Theme } from "../theme/theme";

const GRID_COLS = 20;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const GRID_GUTTER = "   ";

const CELL_FILLED = "⛁";
const CELL_FILLED_MESSAGES = "⛃";
const CELL_FREE = "⛶";
const CELL_BUFFER = "⛝";

type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "skills" | "messages";

interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
	color: "accent" | "warning" | "success" | "userMessageText" | "customMessageLabel";
	glyph: string;
}

export interface ContextBreakdown {
	model: Model | undefined;
	contextWindow: number;
	categories: CategoryInfo[];
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
}

function extractRenderedSkillsSection(systemPrompt: string): string {
	const marker = "# Skills\n";
	const start = systemPrompt.indexOf(marker);
	if (start < 0) return "";
	const bodyStart = start + marker.length;
	const rest = systemPrompt.slice(bodyStart);
	const nextHeading = rest.search(/\n# [^\n]+\n/);
	const body = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
	return body.trim();
}

function estimateRenderedSkillsTokens(systemPrompt: string): number {
	const renderedSkills = extractRenderedSkillsSection(systemPrompt);
	return renderedSkills ? countTokens(renderedSkills) : 0;
}

function estimateToolSchemaTokens(tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>): number {
	const fragments: string[] = [];
	for (const tool of tools) {
		fragments.push(tool.name, tool.description);
		try {
			fragments.push(JSON.stringify(tool.parameters ?? {}));
		} catch {
			// Schema may contain functions or cycles; ignore.
		}
	}
	return countTokens(fragments);
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
export function computeContextBreakdown(session: AgentSession): ContextBreakdown {
	const model = session.model;
	const contextWindow = model?.contextWindow ?? 0;

	const systemPromptParts = session.systemPrompt;
	const renderedPromptHead = systemPromptParts?.[0] ?? "";
	const skillsTokens = estimateRenderedSkillsTokens(renderedPromptHead);
	const toolsTokens = estimateToolSchemaTokens(session.agent?.state?.tools ?? []);

	let messagesTokens = 0;
	const convo = session.messages;
	if (convo) {
		for (const message of convo) {
			messagesTokens += estimateTokens(message);
		}
	}

	// The rendered system prompt may omit skills entirely in compact mode, and
	// skills with `hide: true` remain reachable through skill:// without being
	// listed. Count only the actual rendered # Skills section so /context reports
	// wire cost, not every loaded skill in the registry.
	const systemPromptTokens = Math.max(0, countTokens(renderedPromptHead) - skillsTokens);
	const systemContextTokens = countTokens(systemPromptParts?.slice(1) ?? []);

	const categories: CategoryInfo[] = [
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens, color: "accent", glyph: CELL_FILLED },
		{ id: "systemTools", label: "System tools", tokens: toolsTokens, color: "warning", glyph: CELL_FILLED },
		{
			id: "systemContext",
			label: "System context",
			tokens: systemContextTokens,
			color: "customMessageLabel",
			glyph: CELL_FILLED,
		},
		{ id: "skills", label: "Skills", tokens: skillsTokens, color: "success", glyph: CELL_FILLED },
		{
			id: "messages",
			label: "Messages",
			tokens: messagesTokens,
			color: "userMessageText",
			glyph: CELL_FILLED_MESSAGES,
		},
	];

	const usedTokens = categories.reduce((sum, c) => sum + c.tokens, 0);

	let autoCompactBufferTokens = 0;
	if (contextWindow > 0) {
		const compactionSettings = session.settings.getGroup("compaction") as CompactionSettings;
		if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
			const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
			autoCompactBufferTokens = Math.max(0, contextWindow - threshold);
		} else {
			autoCompactBufferTokens = 0;
		}
		// Even when fully disabled, fall back to a sensible reserve floor for display.
		if (autoCompactBufferTokens === 0 && compactionSettings.enabled) {
			autoCompactBufferTokens = effectiveReserveTokens(contextWindow, compactionSettings);
		}
	}
	autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - usedTokens));

	const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

	return {
		model,
		contextWindow,
		categories,
		usedTokens,
		autoCompactBufferTokens,
		freeTokens,
	};
}

interface CellSpec {
	glyph: string;
	color: "accent" | "warning" | "success" | "userMessageText" | "customMessageLabel" | "muted" | "dim";
}

function planCells(breakdown: ContextBreakdown): CellSpec[] {
	const cells: CellSpec[] = [];
	const window = breakdown.contextWindow;

	if (window <= 0) {
		for (let i = 0; i < GRID_CELLS; i++) {
			cells.push({ glyph: CELL_FREE, color: "dim" });
		}
		return cells;
	}

	const tokensPerCell = window / GRID_CELLS;

	const ratioCells = (tokens: number): number => {
		if (tokens <= 0) return 0;
		return Math.max(1, Math.round(tokens / tokensPerCell));
	};

	const categoryCounts = breakdown.categories.map(category => ({
		category,
		count: ratioCells(category.tokens),
	}));

	let bufferCount = ratioCells(breakdown.autoCompactBufferTokens);

	let usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);

	// Prevent the visualization from over-running the grid.
	const maxUsable = GRID_CELLS - bufferCount;
	if (usedCount > maxUsable) {
		// Scale categories proportionally down to fit.
		let overflow = usedCount - maxUsable;
		// Trim from the largest categories first to preserve visibility for small ones.
		const order = [...categoryCounts].sort((a, b) => b.count - a.count);
		for (const entry of order) {
			while (overflow > 0 && entry.count > 1) {
				entry.count -= 1;
				overflow -= 1;
			}
		}
		usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);
		if (usedCount + bufferCount > GRID_CELLS) {
			bufferCount = Math.max(0, GRID_CELLS - usedCount);
		}
	}

	for (const { category, count } of categoryCounts) {
		for (let i = 0; i < count; i++) {
			cells.push({ glyph: category.glyph, color: category.color });
		}
	}

	const freeCount = Math.max(0, GRID_CELLS - cells.length - bufferCount);
	for (let i = 0; i < freeCount; i++) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	for (let i = 0; i < bufferCount; i++) {
		cells.push({ glyph: CELL_BUFFER, color: "warning" });
	}

	// Pad to exactly GRID_CELLS in case rounding undershot.
	while (cells.length < GRID_CELLS) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	return cells.slice(0, GRID_CELLS);
}

function percentString(part: number, whole: number, fractionDigits = 1): string {
	if (whole <= 0) return "0%";
	const pct = (part / whole) * 100;
	if (pct > 0 && pct < 0.05) return "<0.1%";
	return `${pct.toFixed(fractionDigits)}%`;
}

function buildLegendLines(breakdown: ContextBreakdown, theme: typeof Theme): string[] {
	const lines: string[] = [];
	const { model, contextWindow, categories, usedTokens, autoCompactBufferTokens, freeTokens } = breakdown;

	const modelName = model?.name ?? model?.id ?? "no model";
	const modelId = model?.id ?? "unknown";
	const windowLabel = formatNumber(contextWindow).toLowerCase();

	lines.push(theme.bold(`${modelName}`) + theme.fg("dim", ` (${windowLabel} context)`));
	lines.push(theme.fg("muted", `${modelId}[${windowLabel}]`));
	lines.push(
		`${theme.bold(formatNumber(usedTokens))}${theme.fg("dim", `/${windowLabel} tokens`)}` +
			theme.fg("muted", ` (${percentString(usedTokens, contextWindow)})`),
	);
	lines.push("");
	lines.push(theme.fg("muted", "Estimated usage by category"));

	for (const category of categories) {
		const dot = theme.fg(category.color, category.glyph);
		const label = category.label;
		const tokens = formatNumber(category.tokens);
		const pct = percentString(category.tokens, contextWindow);
		lines.push(`${dot} ${label}: ${theme.bold(tokens)} ${theme.fg("dim", `tokens (${pct})`)}`);
	}

	const freeDot = theme.fg("dim", CELL_FREE);
	lines.push(
		`${freeDot} Free space: ${theme.bold(formatNumber(freeTokens))} ${theme.fg("dim", `(${percentString(freeTokens, contextWindow)})`)}`,
	);

	if (autoCompactBufferTokens > 0) {
		const bufferDot = theme.fg("warning", CELL_BUFFER);
		lines.push(
			`${bufferDot} Autocompact buffer: ${theme.bold(formatNumber(autoCompactBufferTokens))} ${theme.fg(
				"dim",
				`tokens (${percentString(autoCompactBufferTokens, contextWindow)})`,
			)}`,
		);
	}

	return lines;
}

/**
 * Render a colorful context-usage panel as ANSI text. Output is a series of
 * lines pairing the grid (left) with the legend (right).
 */
export function renderContextUsage(breakdown: ContextBreakdown, theme: typeof Theme): string {
	if (breakdown.contextWindow <= 0) {
		return theme.fg("muted", "Context usage is unavailable: no model is selected for this session.");
	}

	const cells = planCells(breakdown);
	const legend = buildLegendLines(breakdown, theme);

	const totalLines = Math.max(GRID_ROWS, legend.length);
	const lines: string[] = [];

	for (let row = 0; row < totalLines; row++) {
		let gridSegment = "";
		if (row < GRID_ROWS) {
			const rowCells: string[] = [];
			for (let col = 0; col < GRID_COLS; col++) {
				const cell = cells[row * GRID_COLS + col];
				rowCells.push(theme.fg(cell.color, cell.glyph));
			}
			gridSegment = rowCells.join(" ");
		} else {
			// Pad with blanks the same visible width as a grid row so legend lines
			// past the grid stay aligned with their column.
			const blank = " ".repeat(GRID_COLS * 2 - 1);
			gridSegment = blank;
		}

		const legendSegment = legend[row] ?? "";
		const line = legendSegment.length > 0 ? `${gridSegment}${GRID_GUTTER}${legendSegment}` : gridSegment;
		lines.push(line);
	}

	return lines.join("\n");
}
