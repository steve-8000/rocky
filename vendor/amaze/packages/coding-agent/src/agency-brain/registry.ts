import { parseFrontmatter } from "@amaze/utils";

export type AgencyAgentRegistryEntryStatus = "draft" | "active" | "inactive" | "archived";

export interface AgencyAgentRegistryEntry {
	name: string;
	description: string;
	vertical?: string;
	brain?: {
		agencySourceId?: string;
		clientSourceId?: string;
	};
	tools: string[];
	approvals: string[];
	status: AgencyAgentRegistryEntryStatus;
}

export interface AgencyAgentRegistry {
	type?: string;
	version?: number;
	agents: AgencyAgentRegistryEntry[];
	warnings: string[];
}

const VALID_STATUSES = new Set<AgencyAgentRegistryEntryStatus>(["draft", "active", "inactive", "archived"]);

function normalizeStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map(item => item.trim())
			.filter(Boolean);
	}
	return [];
}

function normalizeBrain(value: unknown): AgencyAgentRegistryEntry["brain"] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const brain: NonNullable<AgencyAgentRegistryEntry["brain"]> = {};
	if (typeof record.agencySourceId === "string" && record.agencySourceId.trim()) {
		brain.agencySourceId = record.agencySourceId.trim();
	}
	if (typeof record.clientSourceId === "string" && record.clientSourceId.trim()) {
		brain.clientSourceId = record.clientSourceId.trim();
	}
	return Object.keys(brain).length > 0 ? brain : undefined;
}

function describeEntry(entry: unknown, index: number): string {
	if (entry && typeof entry === "object" && !Array.isArray(entry)) {
		const name = (entry as Record<string, unknown>).name;
		if (typeof name === "string" && name.trim()) return `agent ${name.trim()}`;
	}
	return `agent at index ${index}`;
}

function normalizeEntry(entry: unknown, index: number, warnings: string[]): AgencyAgentRegistryEntry | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		warnings.push(`Dropped ${describeEntry(entry, index)}: entry must be an object.`);
		return undefined;
	}

	const record = entry as Record<string, unknown>;
	const label = describeEntry(record, index);
	const name = typeof record.name === "string" ? record.name.trim() : "";
	const description = typeof record.description === "string" ? record.description.trim() : "";

	if (!name) {
		warnings.push(`Dropped ${label}: name is required.`);
		return undefined;
	}
	if (!description) {
		warnings.push(`Dropped ${label}: description is required.`);
		return undefined;
	}

	let status: AgencyAgentRegistryEntryStatus = "draft";
	if (typeof record.status === "string" && record.status.trim()) {
		const normalizedStatus = record.status.trim() as AgencyAgentRegistryEntryStatus;
		if (VALID_STATUSES.has(normalizedStatus)) {
			status = normalizedStatus;
		} else {
			warnings.push(`Defaulted ${label} status to draft: ${record.status} is not supported.`);
		}
	}

	return {
		name,
		description,
		vertical: typeof record.vertical === "string" && record.vertical.trim() ? record.vertical.trim() : undefined,
		brain: normalizeBrain(record.brain),
		tools: normalizeStringArray(record.tools),
		approvals: normalizeStringArray(record.approvals),
		status,
	};
}

export function parseAgencyAgentRegistryPage(markdown: string): AgencyAgentRegistry {
	const { frontmatter } = parseFrontmatter(markdown, { source: "agency-agent-registry", level: "off" });
	const warnings: string[] = [];
	const rawAgents = Array.isArray(frontmatter.agents) ? frontmatter.agents : [];

	if (frontmatter.agents !== undefined && !Array.isArray(frontmatter.agents)) {
		warnings.push("Ignored agents: expected an array.");
	}

	return {
		type: typeof frontmatter.type === "string" ? frontmatter.type : undefined,
		version: typeof frontmatter.version === "number" ? frontmatter.version : undefined,
		agents: rawAgents
			.map((entry, index) => normalizeEntry(entry, index, warnings))
			.filter((entry): entry is AgencyAgentRegistryEntry => Boolean(entry)),
		warnings,
	};
}
