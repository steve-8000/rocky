import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@amaze/utils";
import { ProposalStore } from "../learning";
import { readSkillUsageSnapshot, type SkillUsageMap } from "./skill-usage";
import { loadSkillsFromDir } from "./skills";

export interface SkillCuratorOptions {
	agentDir?: string;
	skillsDir?: string;
	staleAfterDays?: number;
	archiveAfterDays?: number;
	now?: Date;
	proposalsDb?: string;
	createProposals?: boolean;
}

export interface SkillCuratorCandidate {
	name: string;
	path: string;
	status: "active" | "stale" | "archive-candidate" | "unused";
	reason: string;
	useCount: number;
	lastUsedAt: string | null;
}

export interface SkillCuratorReport {
	runAt: string;
	skillsDir: string;
	candidates: SkillCuratorCandidate[];
	proposalIds: string[];
}

export async function runSkillCurator(options: SkillCuratorOptions = {}): Promise<SkillCuratorReport> {
	const agentDir = options.agentDir ?? getAgentDir();
	const skillsDir = path.resolve(options.skillsDir ?? path.join(agentDir, "skills"));
	const now = options.now ?? new Date();
	const usage = await readSkillUsageSnapshot(agentDir);
	const { skills } = await loadSkillsFromDir({ dir: skillsDir, source: "amaze:user" });
	const staleMs = days(options.staleAfterDays ?? 45);
	const archiveMs = days(options.archiveAfterDays ?? 120);
	const candidates = skills.map(skill => classifySkill(skill, usage, now, staleMs, archiveMs));
	const proposalIds = options.createProposals ? await createSkillProposals(candidates, options.proposalsDb) : [];
	const report: SkillCuratorReport = { runAt: now.toISOString(), skillsDir, candidates, proposalIds };
	await writeCuratorState(agentDir, report);
	return report;
}

function classifySkill(
	skill: { name: string; filePath: string },
	usage: SkillUsageMap,
	now: Date,
	staleMs: number,
	archiveMs: number,
): SkillCuratorCandidate {
	const record = usage[skill.name];
	if (!record?.last_used_at) {
		return {
			name: skill.name,
			path: skill.filePath,
			status: "unused",
			reason: "No recorded activations",
			useCount: record?.use_count ?? 0,
			lastUsedAt: record?.last_used_at ?? null,
		};
	}
	const age = now.getTime() - Date.parse(record.last_used_at);
	if (age >= archiveMs) {
		return {
			name: skill.name,
			path: skill.filePath,
			status: "archive-candidate",
			reason: `No activations for at least ${Math.floor(archiveMs / days(1))} days`,
			useCount: record.use_count,
			lastUsedAt: record.last_used_at,
		};
	}
	if (age >= staleMs) {
		return {
			name: skill.name,
			path: skill.filePath,
			status: "stale",
			reason: `No activations for at least ${Math.floor(staleMs / days(1))} days`,
			useCount: record.use_count,
			lastUsedAt: record.last_used_at,
		};
	}
	return {
		name: skill.name,
		path: skill.filePath,
		status: "active",
		reason: "Recently activated",
		useCount: record.use_count,
		lastUsedAt: record.last_used_at,
	};
}

async function createSkillProposals(candidates: SkillCuratorCandidate[], dbPath?: string): Promise<string[]> {
	const actionable = candidates.filter(
		candidate => candidate.status === "stale" || candidate.status === "archive-candidate",
	);
	if (actionable.length === 0) return [];
	const store = new ProposalStore(dbPath);
	try {
		return actionable.map(candidate => {
			const proposal = store.create({
				type: "skill",
				gate: "review",
				name: candidate.name,
				sourceMemoryIds: [],
				bodyMarkdown: `---\nname: ${candidate.name}\ndescription: Review stale skill before changing it.\n---\n\n# ${candidate.name}\n\nCurator finding: ${candidate.reason}\n`,
				evidence: { sessionIds: [], eventRefs: [`skill:${candidate.name}`], sampleN: candidate.useCount },
				provenance: { source: "reflection", ruleId: "skill-curator" },
			});
			return proposal.id;
		});
	} finally {
		store.close();
	}
}

async function writeCuratorState(agentDir: string, report: SkillCuratorReport): Promise<void> {
	const statePath = path.join(agentDir, "skills", ".curator_state.json");
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(
		statePath,
		`${JSON.stringify({ lastRunAt: report.runAt, lastRunSummary: summarize(report), paused: false, runCount: 1 }, null, 2)}\n`,
		"utf8",
	);
}

function summarize(report: SkillCuratorReport): string {
	const counts = new Map<string, number>();
	for (const candidate of report.candidates) counts.set(candidate.status, (counts.get(candidate.status) ?? 0) + 1);
	return [...counts.entries()].map(([status, count]) => `${status}:${count}`).join(" ");
}

function days(value: number): number {
	return value * 24 * 60 * 60 * 1000;
}
