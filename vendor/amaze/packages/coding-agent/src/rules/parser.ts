import { YAML } from "bun";
import type { Rule, RuleDetect, RuleScan, RuleSeverity, RuleTrust } from "./types";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const DETECT_RE = /```detect\r?\n([\s\S]*?)\r?\n```/;
const VALID_SEVERITIES = new Set<RuleSeverity>(["info", "warning", "high", "critical"]);
const VALID_TRUST = new Set<RuleTrust>(["built-in", "personal", "project"]);
const VALID_SCANS = new Set<RuleScan>(["events", "session", "request", "workspace"]);

export function parseRuleMarkdown(text: string): Rule {
	const frontmatterMatch = text.match(FRONTMATTER_RE);
	if (!frontmatterMatch) throw new Error("Rule markdown requires YAML frontmatter");

	const detectMatch = text.match(DETECT_RE);
	if (!detectMatch) throw new Error("Rule markdown requires a detect block");

	const metadata = parseYamlRecord(frontmatterMatch[1], "frontmatter");
	const detect = parseDetect(parseYamlRecord(detectMatch[1], "detect block"));
	const body = text
		.slice((frontmatterMatch[0] ?? "").length)
		.replace(DETECT_RE, "")
		.trim();

	return {
		id: requireString(metadata.id, "id"),
		name: requireString(metadata.name, "name"),
		group: requireString(metadata.group, "group"),
		severity: parseSeverity(metadata.severity),
		trust: parseTrust(metadata.trust),
		fileTypes: optionalStringArray(metadata.fileTypes, "fileTypes"),
		inherits: optionalStringArray(metadata.inherits, "inherits"),
		detect,
		description: section(body, "Description"),
		examples: section(body, "Examples"),
		howToImprove: section(body, "How to Improve"),
	};
}

function parseDetect(value: Record<string, unknown>): RuleDetect {
	return {
		scan: parseScan(value.scan),
		match: requireString(value.match, "detect.match"),
		aggregate: requireString(value.aggregate, "detect.aggregate"),
		window: value.window,
		check: requireString(value.check, "detect.check"),
		thresholds: optionalRecord(value.thresholds, "detect.thresholds"),
		severity: value.severity,
	};
}

function parseYamlRecord(source: string, label: string): Record<string, unknown> {
	const parsed = YAML.parse(source) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid ${label}`);
	return parsed as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Rule ${field} must be a non-empty string`);
	return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new Error(`Rule ${field} must be a string array`);
	}
	return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Rule ${field} must be an object`);
	return value as Record<string, unknown>;
}

function parseScan(value: unknown): RuleScan {
	const scan = requireString(value, "detect.scan");
	if (!VALID_SCANS.has(scan as RuleScan)) throw new Error(`Invalid rule scan: ${scan}`);
	return scan as RuleScan;
}

function parseSeverity(value: unknown): RuleSeverity {
	const severity = requireString(value, "severity");
	if (!VALID_SEVERITIES.has(severity as RuleSeverity)) throw new Error(`Invalid rule severity: ${severity}`);
	return severity as RuleSeverity;
}

function parseTrust(value: unknown): RuleTrust {
	const trust = requireString(value, "trust");
	if (!VALID_TRUST.has(trust as RuleTrust)) throw new Error(`Invalid rule trust: ${trust}`);
	return trust as RuleTrust;
}

function section(body: string, title: string): string {
	const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = body.match(new RegExp(`^# ${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n# |$)`, "m"));
	return match?.[1]?.trim() ?? "";
}
