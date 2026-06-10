/**
 * MissionProposal — a hash-verified artifact a mission must produce and have
 * approved before its mutation gate unlocks.
 *
 * The artifact lives at `artifactUri` (e.g. `local://PLAN.md`); `contentHash` is
 * the SHA-256 of the bytes resolved through that URI at the moment of save. The
 * gate compares the current bytes' hash against `contentHash` and refuses to
 * unlock when they diverge.
 */
export const MISSION_PROPOSAL_STATUSES = ["draft", "approved", "applied", "rolled_back"] as const;
export type MissionProposalStatus = (typeof MISSION_PROPOSAL_STATUSES)[number];

export interface MissionProposal {
	id: string;
	missionId: string;
	artifactUri: string;
	contentHash: string;
	status: MissionProposalStatus;
	approvedBy: string | null;
	approvedAt: number | null;
	summary: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface NewMissionProposal {
	id?: string;
	missionId: string;
	artifactUri: string;
	contentHash: string;
	status?: MissionProposalStatus;
	approvedBy?: string | null;
	approvedAt?: number | null;
	summary?: string | null;
}
