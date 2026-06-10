import type { MissionLifecycleState } from "./core";
import type { MissionIntent } from "./policy/intent";
import type { MissionView } from "./read-model";

const MAX_EVIDENCE_CLAIMS = 5;
const MAX_NEXT_ACTIONS = 5;
const MAX_CONTRACT_INCLUDES = 3;
const MAX_CONTRACT_CRITERIA = 5;

type MissionMemoryRecallAuthority =
	| "instruction"
	| "repo_truth"
	| "mission_evidence"
	| "session_context"
	| "verified_project_decision"
	| "durable_memory"
	| "historical_summary";

type MissionMemoryRecallType = "instruction" | "repo_truth" | "evidence" | "decision" | "durable_memory" | "summary";

interface MissionMemoryRecallItem {
	id: string;
	missionId?: string;
	projectId?: string;
	sessionId?: string;
	type: MissionMemoryRecallType;
	authority: MissionMemoryRecallAuthority;
	content: string;
	confidence: number;
	sourceEventId?: string;
	sourceEvidenceRefs: string[];
	createdAt: string;
	updatedAt: string;
}

export interface MissionMemoryRecall {
	missionId: string;
	query: string;
	items: MissionMemoryRecallItem[];
	authority: MissionMemoryRecallAuthority;
}

export type ActiveMissionVerificationVerdict = "pass" | "fail" | "pending";

export interface ActiveMissionPacket {
	objective: string;
	state: MissionView["mission"]["state"];
	decision: {
		hypothesis: string;
		kind: NonNullable<MissionView["decisionSummary"]>["kind"];
		confidence: NonNullable<MissionView["decisionSummary"]>["confidence"];
		evidenceRefs: string[];
	} | null;
	activeContract: {
		role: string;
		scopeIncludes: string[];
		successCriteria: string[];
		mustProduce: string[];
	} | null;
	evidenceClaims: Array<{ id: string; lane: string; grade: string; claim: string }>;
	blockingCritique: {
		verdict: string;
		blockingCount: number;
		summary: string;
	} | null;
	nextActions: string[];
	intent?: MissionIntent;
	phase?: string;
	decisionId?: string | null;
	regressionContractId?: string | null;
	verificationVerdict?: ActiveMissionVerificationVerdict | null;
	/**
	 * Optional recall surfaced from memory (Lane J). Additive and opt-in: only
	 * populated when a {@link MissionMemoryBridge} attaches recall. Items are
	 * guidance authority and never override repo truth.
	 */
	memoryRecall?: MissionMemoryRecall;
	omitted: {
		evidenceClaims: number;
		evidenceCards: number;
		contracts: number;
		contractIncludes: number;
		contractCriteria: number;
		nextActions: number;
	};
}

export function buildActiveMissionPacket(view: MissionView): ActiveMissionPacket {
	const activeContract = view.contracts.at(-1) ?? null;
	const evidenceClaims = view.evidenceCards.flatMap(card =>
		card.claims.map(claim => ({ id: card.id, lane: card.lane, grade: card.grade, claim })),
	);
	const nextActions = view.decision?.nextActions ?? [];
	const missionPointers = view.mission as MissionPointerSource;
	const blockingCritique = view.latestCritique?.blockingCount
		? {
				verdict: view.latestCritique.verdict,
				blockingCount: view.latestCritique.blockingCount,
				summary: view.latestCritique.summary,
			}
		: null;

	const packet: ActiveMissionPacket = {
		objective: view.objective?.title ?? view.mission.title,
		state: view.mission.state,
		decision: view.decisionSummary
			? {
					hypothesis: view.decisionSummary.hypothesis,
					kind: view.decisionSummary.kind,
					confidence: view.decisionSummary.confidence,
					evidenceRefs: [...view.decisionSummary.evidenceRefs],
				}
			: null,
		activeContract: activeContract
			? {
					role: activeContract.role,
					scopeIncludes: activeContract.include.slice(0, MAX_CONTRACT_INCLUDES),
					successCriteria: activeContract.successCriteria.slice(0, MAX_CONTRACT_CRITERIA),
					mustProduce: [...activeContract.mustProduce],
				}
			: null,
		evidenceClaims: evidenceClaims.slice(0, MAX_EVIDENCE_CLAIMS),
		blockingCritique,
		nextActions: nextActions.slice(0, MAX_NEXT_ACTIONS),
		omitted: {
			evidenceClaims: Math.max(0, evidenceClaims.length - MAX_EVIDENCE_CLAIMS),
			evidenceCards: Math.max(0, view.evidenceCards.length - MAX_EVIDENCE_CLAIMS),
			contracts: Math.max(0, view.contracts.length - (activeContract ? 1 : 0)),
			contractIncludes: activeContract ? Math.max(0, activeContract.include.length - MAX_CONTRACT_INCLUDES) : 0,
			contractCriteria: activeContract
				? Math.max(0, activeContract.successCriteria.length - MAX_CONTRACT_CRITERIA)
				: 0,
			nextActions: Math.max(0, nextActions.length - MAX_NEXT_ACTIONS),
		},
	};

	if (missionPointers.intent !== undefined) packet.intent = missionPointers.intent;
	if (missionPointers.lifecycle !== undefined) packet.phase = phaseFromLifecycle(missionPointers.lifecycle);
	if ("decisionId" in missionPointers) packet.decisionId = missionPointers.decisionId ?? null;
	if ("regressionContractId" in missionPointers) {
		packet.regressionContractId = missionPointers.regressionContractId ?? null;
	}
	if ("verification" in missionPointers) packet.verificationVerdict = missionPointers.verification?.verdict ?? null;

	return packet;
}

type MissionPointerSource = {
	intent?: MissionIntent;
	lifecycle?: MissionLifecycleState;
	decisionId?: string | null;
	regressionContractId?: string | null;
	verification?: { verdict?: ActiveMissionVerificationVerdict } | null;
};

export function phaseFromLifecycle(lifecycle: MissionLifecycleState): string {
	switch (lifecycle) {
		case "created":
		case "classified":
			return "frame";
		case "planning":
			return "plan";
		case "executing":
			return "execute";
		case "verifying":
			return "verify";
		case "completed":
			return "done";
		case "blocked":
			return "blocked";
		case "cancelled":
			return "cancelled";
		default:
			return lifecycle;
	}
}

/**
 * Attach memory recall to an existing packet (Lane J, additive). Returns a new
 * packet with `memoryRecall` set; does not mutate the input and does not change
 * any other field, so default packet construction is unaffected.
 */
export function withMemoryRecall(packet: ActiveMissionPacket, recall: MissionMemoryRecall): ActiveMissionPacket {
	return { ...packet, memoryRecall: recall };
}

export function renderActiveMissionPacket(packet: ActiveMissionPacket | null | undefined): string {
	if (!packet) return "";
	const lines = [
		"<active-mission>",
		`Objective: ${packet.objective}`,
		`State: ${packet.state}`,
		`Decision: ${packet.decision ? `${packet.decision.confidence} confidence — ${packet.decision.hypothesis}` : "<none>"}`,
	];
	if (packet.activeContract) {
		lines.push(
			`Active contract: ${packet.activeContract.role}; scope ${formatList(packet.activeContract.scopeIncludes)}; criteria ${formatList(packet.activeContract.successCriteria)}; must produce ${formatList(packet.activeContract.mustProduce)}`,
		);
	}
	if (packet.evidenceClaims.length > 0) {
		lines.push("Top evidence claims:");
		for (const claim of packet.evidenceClaims) {
			lines.push(`- ${claim.id} [${claim.lane}/${claim.grade}]: ${claim.claim}`);
		}
	}
	if (packet.blockingCritique) {
		lines.push(
			`Blocking critique: ${packet.blockingCritique.verdict}; ${packet.blockingCritique.blockingCount} blocking — ${packet.blockingCritique.summary}`,
		);
	}
	if (packet.nextActions.length > 0) {
		lines.push(`Next actions: ${formatList(packet.nextActions)}`);
	}
	if (packet.memoryRecall && packet.memoryRecall.items.length > 0) {
		lines.push(`Recalled memory (guidance only, never overrides repo truth):`);
		for (const item of packet.memoryRecall.items) {
			lines.push(`- [${item.type}] ${item.content}`);
		}
	}
	const hasPointers = hasPointerFields(packet);
	if (hasPointers) {
		if (packet.intent !== undefined) lines.push(`intent: ${packet.intent}`);
		if (packet.phase !== undefined) lines.push(`phase: ${packet.phase}`);
		if (packet.decisionId !== undefined) lines.push(`decision: ${packet.decisionId ?? "pending"}`);
		if (packet.regressionContractId !== undefined) {
			lines.push(`regression: ${packet.regressionContractId ?? "pending"}`);
		}
		if (packet.verificationVerdict !== undefined && packet.verificationVerdict !== null) {
			lines.push(`verification: ${packet.verificationVerdict}`);
		}
		lines.push(`(For details: /mission decision <id> | /mission verify <id> | /mission evidence <id>)`);
	}
	lines.push(
		`Omitted: ${packet.omitted.evidenceClaims} evidence claims, ${packet.omitted.evidenceCards} evidence cards, ${packet.omitted.contracts} older contracts, ${packet.omitted.contractIncludes} contract includes, ${packet.omitted.contractCriteria} contract criteria, ${packet.omitted.nextActions} next actions.`,
		"</active-mission>",
	);
	return lines.join("\n");
}

function hasPointerFields(packet: ActiveMissionPacket): boolean {
	return (
		packet.intent !== undefined ||
		packet.phase !== undefined ||
		packet.decisionId !== undefined ||
		packet.regressionContractId !== undefined ||
		packet.verificationVerdict !== undefined
	);
}

function formatList(values: string[]): string {
	return values.length > 0 ? values.join("; ") : "<none>";
}
