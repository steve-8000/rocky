import {
	type DecisionRecord,
	type EvidenceCard,
	RESEARCH_LANES,
	type ResearchBrief,
	type ResearchLane,
} from "../research/types";
import type { EpistemicRole, MissionLaneRun, MissionLaneStatus, ResearchCampaign } from "./types";

export interface MissionProjectionLaneSummary {
	lane: ResearchLane;
	status: MissionLaneStatus;
	agent: string;
	epistemicRole: EpistemicRole;
	evidenceCount: number;
	emptyReason: string | null;
	taskId: string | null;
	startedAt: number | null;
	endedAt: number | null;
}

export interface MissionProjectionView {
	mission: ResearchCampaign;
	brief: ResearchBrief | null;
	decision: DecisionRecord | null;
	evidenceCount: number;
	evidenceByLane: Array<{ lane: ResearchLane; count: number }>;
	laneRuns: MissionProjectionLaneSummary[];
}

export function projectMissionView(input: {
	mission: ResearchCampaign;
	brief: ResearchBrief | undefined;
	decision: DecisionRecord | undefined;
	evidence: EvidenceCard[];
	laneRuns: MissionLaneRun[];
}): MissionProjectionView {
	const countsByLane = new Map<ResearchLane, number>();
	for (const evidence of input.evidence) {
		countsByLane.set(evidence.lane, (countsByLane.get(evidence.lane) ?? 0) + 1);
	}

	return {
		mission: input.mission,
		brief: input.brief ?? null,
		decision: input.decision ?? null,
		evidenceCount: input.evidence.length,
		evidenceByLane: RESEARCH_LANES.map(lane => ({ lane, count: countsByLane.get(lane) ?? 0 })),
		laneRuns: [...input.laneRuns]
			.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
			.map(run => ({
				lane: run.lane,
				status: run.status,
				agent: run.agent,
				epistemicRole: run.epistemicRole,
				evidenceCount: run.evidenceCount,
				emptyReason: run.emptyReason,
				taskId: run.taskId,
				startedAt: run.startedAt,
				endedAt: run.endedAt,
			})),
	};
}
