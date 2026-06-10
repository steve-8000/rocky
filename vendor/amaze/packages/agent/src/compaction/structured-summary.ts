const SECTION_HEADINGS = [
	["1", "## 1. User Requests (Verbatim)"],
	["2", "## 2. Final Goal"],
	["3", "## 3. Constraints & Preferences (Verbatim Only)"],
	["4", "## 4. Work Completed"],
	["5", "## 5. Active Working Context"],
	["6", "## 6. Remaining Tasks"],
	["7", "## 7. Exact Next Steps"],
] as const;

type SectionId = (typeof SECTION_HEADINGS)[number][0];

type StructuredSummarySections = Map<SectionId, string[]>;

const SECTION_IDS = new Set<SectionId>(SECTION_HEADINGS.map(([id]) => id));
const TURN_PREFIX_SECTION_IDS = new Set<SectionId>(["1", "2", "3", "5"]);

function sanitizeTaggedContent(content: string, tagName: string): string {
	return content.split(`</${tagName}>`).join(`[/${tagName}]`);
}

function normalizeSummaryText(summary: string | undefined): string {
	return summary?.trim() ?? "";
}

function normalizeSectionLines(lines: string[] | undefined): string[] {
	if (!lines) return ["None."];
	const filtered = lines.map(line => line.trimEnd()).filter(line => line.trim().length > 0);
	return filtered.length > 0 ? filtered : ["None."];
}

function isNoneSection(lines: string[] | undefined): boolean {
	return normalizeSectionLines(lines).every(line => line.trim() === "None.");
}

function parseStructuredSummary(summary: string | undefined): StructuredSummarySections {
	const extracted = extractSummaryBlock(summary);
	if (!extracted) return new Map();

	const sections: StructuredSummarySections = new Map();
	const lines = extracted.split(/\r?\n/);
	let currentSection: SectionId | undefined;
	let buffer: string[] = [];

	const flush = () => {
		if (!currentSection) return;
		sections.set(currentSection, normalizeSectionLines(buffer));
		buffer = [];
	};

	for (const line of lines) {
		const match = /^##\s+(\d+)\./.exec(line.trim());
		if (match && SECTION_IDS.has(match[1] as SectionId)) {
			flush();
			currentSection = match[1] as SectionId;
			continue;
		}
		if (currentSection) {
			buffer.push(line);
		}
	}
	flush();
	return sections;
}

function mergeSectionLines(baseLines: string[] | undefined, incomingLines: string[] | undefined): string[] {
	if (!incomingLines || incomingLines.length === 0) return normalizeSectionLines(baseLines);
	if (!baseLines || baseLines.length === 0 || isNoneSection(baseLines)) return normalizeSectionLines(incomingLines);
	if (isNoneSection(incomingLines)) return normalizeSectionLines(baseLines);

	const merged = [...normalizeSectionLines(baseLines)];
	const seen = new Set(merged.map(line => line.trim()));
	for (const line of normalizeSectionLines(incomingLines)) {
		const key = line.trim();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(line);
	}
	return merged;
}

function buildStructuredSummary(sections: StructuredSummarySections): string {
	const lines: string[] = [];
	for (const [id, heading] of SECTION_HEADINGS) {
		lines.push(heading);
		lines.push(...normalizeSectionLines(sections.get(id)));
		lines.push("");
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

export function extractSummaryBlock(summary: string | undefined): string {
	const normalized = normalizeSummaryText(summary);
	if (!normalized) return "";
	const match = /<summary>\s*([\s\S]*?)\s*<\/summary>/iu.exec(normalized);
	return match ? match[1].trim() : normalized;
}

export function isSectionAwareCompactionSummary(summary: string | undefined): boolean {
	const sections = parseStructuredSummary(summary);
	return sections.has("1") && sections.has("2") && sections.has("3");
}

export function formatLegacySummaryBlock(summary: string | undefined): string {
	const extracted = extractSummaryBlock(summary);
	if (!extracted || isSectionAwareCompactionSummary(summary)) return "";
	return `<legacy-summary>\n${sanitizeTaggedContent(extracted, "legacy-summary")}\n</legacy-summary>\n\n`;
}

export function formatCustomInstructionsBlock(customInstructions: string | undefined): string {
	const normalized = normalizeSummaryText(customInstructions);
	if (!normalized) return "";
	return `\n\n<custom-instructions>\n${sanitizeTaggedContent(normalized, "custom-instructions")}\n</custom-instructions>`;
}

export function sanitizePreviousSummaryBlock(previousSummary: string | undefined): string {
	const extracted = extractSummaryBlock(previousSummary);
	if (!extracted) return "None.";
	return sanitizeTaggedContent(extracted, "previous-summary");
}

export function mergeSplitTurnSummaries(
	historySummary: string | undefined,
	turnPrefixSummary: string | undefined,
): string {
	const normalizedHistory = extractSummaryBlock(historySummary);
	const normalizedTurnPrefix = extractSummaryBlock(turnPrefixSummary);
	const historySections = parseStructuredSummary(normalizedHistory);
	const turnPrefixSections = parseStructuredSummary(normalizedTurnPrefix);
	if (historySections.size === 0) {
		if (normalizedHistory) {
			if (!normalizedTurnPrefix) return normalizedHistory;
			return `${normalizedHistory}\n\n---\n\n**Turn Context (split turn):**\n\n${normalizedTurnPrefix}`;
		}
		if (turnPrefixSections.size === 0) return normalizedTurnPrefix;
		const synthesized: StructuredSummarySections = new Map();
		for (const [id] of SECTION_HEADINGS) {
			if (TURN_PREFIX_SECTION_IDS.has(id)) {
				synthesized.set(id, normalizeSectionLines(turnPrefixSections.get(id)));
				continue;
			}
			synthesized.set(id, ["None."]);
		}
		return buildStructuredSummary(synthesized);
	}
	if (turnPrefixSections.size === 0) {
		if (!normalizedTurnPrefix) return normalizedHistory;
		return `${normalizedHistory}\n\n---\n\n**Turn Context (split turn):**\n\n${normalizedTurnPrefix}`;
	}

	const merged: StructuredSummarySections = new Map();
	for (const [id] of SECTION_HEADINGS) {
		if (TURN_PREFIX_SECTION_IDS.has(id)) {
			merged.set(id, mergeSectionLines(historySections.get(id), turnPrefixSections.get(id)));
			continue;
		}
		merged.set(id, normalizeSectionLines(historySections.get(id)));
	}
	return buildStructuredSummary(merged);
}
