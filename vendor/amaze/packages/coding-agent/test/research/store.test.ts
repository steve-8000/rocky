import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionEventBus } from "../../src/mission/event-bus";
import { MissionStore } from "../../src/mission/store";
import { ResearchStore } from "../../src/research/store";
import type {
	NewCritiqueRecord,
	NewDecisionRecord,
	NewEvidenceCard,
	NewResearchBrief,
	NewSynthesisRecord,
} from "../../src/research/types";

const stores: ResearchStore[] = [];

function createStore(dbPath = ":memory:"): ResearchStore {
	const store = new ResearchStore(dbPath);
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
	}
});

function withTempDb(run: (dbPath: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-research-store-"));
	try {
		run(path.join(root, "autonomy.db"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function brief(overrides: Partial<NewResearchBrief> = {}): NewResearchBrief {
	return {
		objectiveId: "objective-1",
		question: "Which lane is grounded?",
		lanes: ["repo", "source"],
		requiredEvidence: ["primary source"],
		disallowedEvidence: ["uncited claim"],
		riskLevel: "medium",
		stopCriteria: ["two lanes covered"],
		...overrides,
	};
}

function evidence(briefId: string, overrides: Partial<NewEvidenceCard> = {}): NewEvidenceCard {
	return {
		briefId,
		lane: "repo",
		grade: "A",
		sourceRef: "src/file.ts:1",
		excerpt: "const value = true;",
		claims: ["repo says true"],
		directness: 1,
		specificity: 1,
		recency: 1,
		reproducibility: 1,
		...overrides,
	};
}

function decision(briefId: string, overrides: Partial<NewDecisionRecord> = {}): NewDecisionRecord {
	return {
		briefId,
		hypothesis: "Use repo evidence",
		rationale: "It is directly observed",
		kind: "select",
		confidence: "high",
		evidenceRefs: ["ev-1"],
		rejectedOptions: [{ id: "alt", reason: "unsupported" }],
		nextActions: ["apply"],
		...overrides,
	};
}

function synthesis(briefId: string, overrides: Partial<NewSynthesisRecord> = {}): NewSynthesisRecord {
	return {
		briefId,
		hypothesisCount: 2,
		recommended: "H1",
		summary: "H1 is best supported.",
		rawOutput: "Raw synthesis output.",
		...overrides,
	};
}

function critique(briefId: string, overrides: Partial<NewCritiqueRecord> = {}): NewCritiqueRecord {
	return {
		briefId,
		blockingCount: 0,
		softCount: 1,
		verdict: "accept-with-modifications",
		summary: "Accept with a caveat.",
		rawOutput: "Raw critique output.",
		...overrides,
	};
}

describe("ResearchStore", () => {
	test("creates, gets, and lists briefs", () => {
		const store = createStore();
		const created = store.createBrief(brief({ id: "brief-1", lanes: ["repo", "source", "social"] }));

		expect(created.id).toBe("brief-1");
		expect(created.lanes).toEqual(["repo", "source", "social"]);
		expect(created.createdAt).toBeNumber();
		expect(created.updatedAt).toBe(created.createdAt);
		expect(store.getBrief("brief-1")).toEqual(created);
		expect(store.listBriefs()).toEqual([created]);
	});

	test("createBrief creates a matching mission", () => {
		withTempDb(dbPath => {
			const store = createStore(dbPath);
			const created = store.createBrief(brief({ id: "brief-1", objectiveId: "objective-1" }));

			const mission = store.getMissionForBrief(created.id);
			expect(mission).toBeDefined();
			expect(mission?.briefId).toBe(created.id);
			expect(mission?.objectiveId).toBe("objective-1");
			expect(mission?.title).toBe(created.question);
			expect(mission?.state).toBe("researching");
		});
	});

	test("createBrief backfills exact mission link from objectiveId when it names an active goal mission", () => {
		withTempDb(dbPath => {
			const missions = new MissionStore(dbPath);
			const activeGoalMission = missions.createMission({
				id: "goal-1",
				title: "Original goal title",
				objectiveId: null,
				briefId: null,
				decisionId: null,
				riskLevel: "low",
				state: "drafting",
				confidence: null,
				snapshotRef: null,
			});
			missions.createMission({
				id: "wrong-title",
				title: "Which lane is grounded?",
				objectiveId: "other-goal",
				briefId: "other-brief",
				decisionId: null,
				riskLevel: "medium",
				state: "researching",
				confidence: null,
				snapshotRef: null,
			});
			missions.close();

			const store = createStore(dbPath);
			const created = store.createBrief(brief({ id: "brief-linked", objectiveId: activeGoalMission.id }));
			const mission = store.getMissionForBrief(created.id);

			expect(mission?.id).toBe(activeGoalMission.id);
			expect(mission?.briefId).toBe(created.id);
			expect(mission?.objectiveId).toBe(activeGoalMission.id);
			expect(mission?.title).toBe(created.question);
			expect(mission?.state).toBe("researching");
		});
	});

	test("createBrief throws on unknown lane", () => {
		const store = createStore();
		expect(() => store.createBrief(brief({ lanes: ["repo", "bogus" as any] }))).toThrow("Invalid research lane");
	});

	test("listBriefs filters by objectiveId", () => {
		const store = createStore();
		const first = store.createBrief(brief({ id: "brief-1", objectiveId: "objective-1" }));
		store.createBrief(brief({ id: "brief-2", objectiveId: "objective-2" }));

		expect(store.listBriefs({ objectiveId: "objective-1" })).toEqual([first]);
	});

	test("addEvidence requires an existing brief", () => {
		const store = createStore();
		expect(() => store.addEvidence(evidence("missing"))).toThrow("Research brief not found");
	});

	test("addEvidence clamps floats and validates lane and grade", () => {
		const store = createStore();
		const created = store.createBrief(brief({ id: "brief-1" }));

		expect(() => store.addEvidence(evidence(created.id, { lane: "bogus" as any }))).toThrow("Invalid research lane");
		expect(() => store.addEvidence(evidence(created.id, { grade: "Z" as any }))).toThrow("Invalid evidence grade");

		const card = store.addEvidence(
			evidence(created.id, {
				id: "ev-1",
				directness: -1,
				specificity: 2,
				recency: Number.POSITIVE_INFINITY,
				reproducibility: Number.NEGATIVE_INFINITY,
			}),
		);
		expect(card.directness).toBe(0);
		expect(card.specificity).toBe(1);
		expect(card.recency).toBe(1);
		expect(card.reproducibility).toBe(0);
		expect(store.listEvidence(created.id)).toEqual([card]);
	});

	test("listEvidence orders by capturedAt ascending", () => {
		const store = createStore();
		const created = store.createBrief(brief({ id: "brief-1" }));
		const later = store.addEvidence(evidence(created.id, { id: "ev-later", capturedAt: 20 }));
		const earlier = store.addEvidence(evidence(created.id, { id: "ev-earlier", capturedAt: 10 }));

		expect(store.listEvidence(created.id)).toEqual([earlier, later]);
	});

	test("recordDecision validates confidence and returns latest decision", () => {
		const store = createStore();
		const created = store.createBrief(brief({ id: "brief-1" }));
		expect(() => store.recordDecision(decision(created.id, { confidence: "certain" as any }))).toThrow(
			"Invalid decision confidence",
		);

		expect(() => store.recordDecision(decision(created.id, { kind: "maybe" as any }))).toThrow(
			"Invalid decision kind",
		);

		const first = store.recordDecision(decision(created.id, { id: "dec-first" }));
		const second = store.recordDecision(decision(created.id, { id: "dec-second" }));

		expect(store.getDecision(created.id)).toEqual(second);
		expect(store.listDecisions(created.id)).toEqual([first, second]);
		expect(first.kind).toBe("select");
	});

	test("recordDecision updates the brief mission", () => {
		withTempDb(dbPath => {
			const store = createStore(dbPath);
			const created = store.createBrief(brief({ id: "brief-1" }));
			const recorded = store.recordDecision(decision(created.id, { id: "dec-1", confidence: "medium" }));

			const mission = store.getMissionForBrief(created.id);
			expect(mission?.decisionId).toBe(recorded.id);
			expect(mission?.confidence).toBe("medium");
			expect(mission?.state).toBe("deciding");
		});
	});

	test("recordDecision requires an existing brief", () => {
		const store = createStore();
		expect(() => store.recordDecision(decision("missing"))).toThrow("Research brief not found");
	});

	test("addEvidence moves the latest lane run to running and updates evidence count", () => {
		withTempDb(dbPath => {
			const store = createStore(dbPath);
			const created = store.createBrief(brief({ id: "brief-live", lanes: ["repo", "source"] }));
			const mission = store.getMissionForBrief(created.id);
			if (!mission) throw new Error("Expected mission for brief");
			const missions = new MissionStore(dbPath);
			try {
				missions.createResearchRun({
					id: "run-live",
					missionId: mission.id,
					briefId: created.id,
					objectiveId: created.objectiveId,
					status: "running",
					startedAt: 10,
					completedAt: null,
				});
				const lane = missions.createLaneRun({
					id: "lane-live",
					missionId: mission.id,
					lane: "repo",
					agent: "Explore",
					epistemicRole: "repo_truth",
					status: "pending",
					evidenceCount: 0,
					emptyReason: null,
					taskId: null,
					startedAt: null,
					endedAt: null,
				});

				store.addEvidence(evidence(created.id, { id: "ev-live-1", lane: "repo", capturedAt: 100 }));
				expect(missions.getLatestLaneRunForMissionLane(mission.id, "repo")).toMatchObject({
					id: lane.id,
					status: "running",
					evidenceCount: 1,
					startedAt: 100,
				});

				store.addEvidence(evidence(created.id, { id: "ev-live-2", lane: "repo", capturedAt: 200 }));
				expect(missions.getLatestLaneRunForMissionLane(mission.id, "repo")).toMatchObject({
					id: lane.id,
					status: "running",
					evidenceCount: 2,
					startedAt: 100,
				});
			} finally {
				missions.close();
			}
		});
	});

	test("critique finalizes live run lanes and marks lanes without evidence empty", () => {
		withTempDb(dbPath => {
			const store = createStore(dbPath);
			const created = store.createBrief(brief({ id: "brief-finalize", lanes: ["repo", "source"] }));
			const mission = store.getMissionForBrief(created.id);
			if (!mission) throw new Error("Expected mission for brief");
			const missions = new MissionStore(dbPath);
			try {
				missions.createResearchRun({
					id: "run-finalize",
					missionId: mission.id,
					briefId: created.id,
					objectiveId: created.objectiveId,
					status: "running",
					startedAt: 10,
					completedAt: null,
				});
				missions.createLaneRun({
					id: "lane-finalize-repo",
					missionId: mission.id,
					lane: "repo",
					agent: "Explore",
					epistemicRole: "repo_truth",
					status: "pending",
					evidenceCount: 0,
					emptyReason: null,
					taskId: null,
					startedAt: null,
					endedAt: null,
				});
				missions.createLaneRun({
					id: "lane-finalize-source",
					missionId: mission.id,
					lane: "source",
					agent: "Resercher",
					epistemicRole: "source_harvest",
					status: "pending",
					evidenceCount: 0,
					emptyReason: null,
					taskId: null,
					startedAt: null,
					endedAt: null,
				});

				store.addEvidence(evidence(created.id, { id: "ev-finalize", lane: "repo", capturedAt: 100 }));
				store.recordCritique(
					critique(created.id, { id: "crit-finalize", verdict: "accept", blockingCount: 0, createdAt: 300 }),
				);

				expect(missions.getResearchRun("run-finalize")).toMatchObject({
					status: "completed",
					completedAt: 300,
				});
				expect(missions.getLatestLaneRunForMissionLane(mission.id, "repo")).toMatchObject({
					status: "completed",
					evidenceCount: 1,
					endedAt: 300,
				});
				expect(missions.getLatestLaneRunForMissionLane(mission.id, "source")).toMatchObject({
					status: "empty",
					evidenceCount: 0,
					emptyReason: "no evidence recorded",
					endedAt: 300,
				});
			} finally {
				missions.close();
			}
		});
	});

	test("synthesis leaves live run open and decision remains blocked until critique completes", () => {
		withTempDb(dbPath => {
			const store = createStore(dbPath);
			const created = store.createBrief(brief({ id: "brief-synthesis-open", lanes: ["repo"] }));
			const mission = store.getMissionForBrief(created.id);
			if (!mission) throw new Error("Expected mission for brief");
			const missions = new MissionStore(dbPath);
			try {
				missions.createResearchRun({
					id: "run-synthesis-open",
					missionId: mission.id,
					briefId: created.id,
					objectiveId: created.objectiveId,
					status: "running",
					startedAt: 10,
					completedAt: null,
				});
				missions.createLaneRun({
					id: "lane-synthesis-open",
					missionId: mission.id,
					lane: "repo",
					agent: "Explore",
					epistemicRole: "repo_truth",
					status: "pending",
					evidenceCount: 0,
					emptyReason: null,
					taskId: null,
					startedAt: null,
					endedAt: null,
				});

				store.addEvidence(evidence(created.id, { id: "ev-synthesis-open", lane: "repo", capturedAt: 100 }));
				store.recordSynthesis(synthesis(created.id, { id: "syn-synthesis-open", createdAt: 200 }));

				expect(missions.getResearchRun("run-synthesis-open")).toMatchObject({
					status: "running",
					completedAt: null,
				});
				expect(() => store.recordDecision(decision(created.id, { id: "dec-too-early" }))).toThrow(
					"Cannot record decision while research run is running",
				);

				store.recordCritique(
					critique(created.id, { id: "crit-synthesis-open", verdict: "accept", createdAt: 300 }),
				);
				expect(missions.getResearchRun("run-synthesis-open")).toMatchObject({
					status: "completed",
					completedAt: 300,
				});
				expect(store.recordDecision(decision(created.id, { id: "dec-after-critique" })).id).toBe(
					"dec-after-critique",
				);
			} finally {
				missions.close();
			}
		});
	});

	test("rejecting critique finalizes the live run as blocked", () => {
		withTempDb(dbPath => {
			const store = createStore(dbPath);
			const created = store.createBrief(brief({ id: "brief-blocked", lanes: ["repo"] }));
			const mission = store.getMissionForBrief(created.id);
			if (!mission) throw new Error("Expected mission for brief");
			const missions = new MissionStore(dbPath);
			try {
				missions.createResearchRun({
					id: "run-blocked",
					missionId: mission.id,
					briefId: created.id,
					objectiveId: created.objectiveId,
					status: "running",
					startedAt: 10,
					completedAt: null,
				});
				missions.createLaneRun({
					id: "lane-blocked",
					missionId: mission.id,
					lane: "repo",
					agent: "Explore",
					epistemicRole: "repo_truth",
					status: "pending",
					evidenceCount: 0,
					emptyReason: null,
					taskId: null,
					startedAt: null,
					endedAt: null,
				});

				store.recordCritique(
					critique(created.id, { id: "crit-blocked", verdict: "reject", blockingCount: 0, createdAt: 400 }),
				);

				expect(missions.getResearchRun("run-blocked")).toMatchObject({
					status: "blocked",
					completedAt: 400,
				});
				expect(missions.getLatestLaneRunForMissionLane(mission.id, "repo")).toMatchObject({
					status: "empty",
					emptyReason: "no evidence recorded",
					endedAt: 400,
				});
			} finally {
				missions.close();
			}
		});
	});

	test("completed research run only allows select decisions", () => {
		withTempDb(dbPath => {
			const store = createStore(dbPath);
			const created = store.createBrief(brief({ id: "brief-completed", lanes: ["repo"] }));
			const mission = store.getMissionForBrief(created.id);
			if (!mission) throw new Error("Expected mission for brief");
			const missions = new MissionStore(dbPath);
			try {
				missions.createResearchRun({
					id: "run-completed",
					missionId: mission.id,
					briefId: created.id,
					objectiveId: created.objectiveId,
					status: "completed",
					startedAt: 10,
					completedAt: 20,
				});

				expect(store.recordDecision(decision(created.id, { id: "dec-select", kind: "select" })).kind).toBe(
					"select",
				);
				expect(() => store.recordDecision(decision(created.id, { id: "dec-reject", kind: "reject" }))).toThrow(
					"Decision kind reject is not allowed for completed research run",
				);
			} finally {
				missions.close();
			}
		});
	});

	test("blocked research run allows non-select decision kinds", () => {
		withTempDb(dbPath => {
			const store = createStore(dbPath);
			const created = store.createBrief(brief({ id: "brief-blocked-decisions", lanes: ["repo"] }));
			const mission = store.getMissionForBrief(created.id);
			if (!mission) throw new Error("Expected mission for brief");
			const missions = new MissionStore(dbPath);
			try {
				missions.createResearchRun({
					id: "run-blocked-decisions",
					missionId: mission.id,
					briefId: created.id,
					objectiveId: created.objectiveId,
					status: "blocked",
					startedAt: 10,
					completedAt: 20,
				});

				for (const kind of ["reject", "defer", "needs-more-research", "scope-reduction"] as const) {
					expect(store.recordDecision(decision(created.id, { id: `dec-${kind}`, kind })).kind).toBe(kind);
				}
				expect(() =>
					store.recordDecision(decision(created.id, { id: "dec-blocked-select", kind: "select" })),
				).toThrow("Decision kind select is not allowed for blocked research run");
			} finally {
				missions.close();
			}
		});
	});

	test("records syntheses and critiques with latest and list accessors", () => {
		const store = createStore();
		const created = store.createBrief(brief({ id: "brief-1" }));
		const firstSynthesis = store.recordSynthesis(synthesis(created.id, { id: "syn-first", createdAt: 10 }));
		const secondSynthesis = store.recordSynthesis(synthesis(created.id, { id: "syn-second", createdAt: 20 }));
		const firstCritique = store.recordCritique(critique(created.id, { id: "crit-first", createdAt: 10 }));
		const secondCritique = store.recordCritique(
			critique(created.id, { id: "crit-second", verdict: "accept", blockingCount: 0, createdAt: 20 }),
		);

		expect(store.getLatestSynthesis(created.id)).toEqual(secondSynthesis);
		expect(store.listSyntheses(created.id)).toEqual([firstSynthesis, secondSynthesis]);
		expect(store.getLatestCritique(created.id)).toEqual(secondCritique);
		expect(store.listCritiques(created.id)).toEqual([firstCritique, secondCritique]);
	});

	test("synthesis and critique require an existing brief and critique validates verdict", () => {
		const store = createStore();
		const created = store.createBrief(brief({ id: "brief-1" }));

		expect(() => store.recordSynthesis(synthesis("missing"))).toThrow("Research brief not found");
		expect(() => store.recordCritique(critique("missing"))).toThrow("Research brief not found");
		expect(() => store.recordCritique(critique(created.id, { verdict: "maybe" as any }))).toThrow(
			"Invalid critique verdict",
		);
	});

	test("recordSynthesis and recordCritique update mission state and emit events", () => {
		withTempDb(dbPath => {
			const bus = new MissionEventBus();
			const store = new ResearchStore(dbPath, bus);
			stores.push(store);
			const created = store.createBrief(brief({ id: "brief-review" }));
			const mission = store.getMissionForBrief(created.id);
			expect(mission).toBeDefined();
			if (!mission) throw new Error("Expected mission for brief");

			const recordedSynthesis = store.recordSynthesis(synthesis(created.id, { id: "syn-review" }));
			expect(store.getMissionForBrief(created.id)?.state).toBe("synthesizing");
			const recordedCritique = store.recordCritique(
				critique(created.id, { id: "crit-review", verdict: "needs-more-research", blockingCount: 0 }),
			);
			expect(store.getMissionForBrief(created.id)?.state).toBe("blocked");

			expect(bus.snapshot().slice(1)).toEqual([
				{
					type: "research.synthesis.proposed",
					missionId: mission.id,
					briefId: created.id,
					hypothesisCount: 2,
					recommended: "H1",
					ts: recordedSynthesis.createdAt,
				},
				{
					type: "research.critique.completed",
					missionId: mission.id,
					briefId: created.id,
					blockingCount: 0,
					softCount: 1,
					verdict: "needs-more-research",
					ts: recordedCritique.createdAt,
				},
			]);
		});
	});

	test("schema initialization is idempotent for file databases", () => {
		withTempDb(dbPath => {
			const first = createStore(dbPath);
			first.createBrief(brief({ id: "brief-1" }));
			first.close();
			stores.splice(stores.indexOf(first), 1);

			const second = createStore(dbPath);
			expect(second.getBrief("brief-1")?.id).toBe("brief-1");
		});
	});
	test("emits brief, evidence, and decision mission events with mission linkage", () => {
		withTempDb(dbPath => {
			const bus = new MissionEventBus();
			const store = new ResearchStore(dbPath, bus);
			stores.push(store);

			const created = store.createBrief(brief({ id: "brief-events", objectiveId: "objective-events" }));
			const mission = store.getMissionForBrief(created.id);
			expect(mission).toBeDefined();
			if (!mission) throw new Error("Expected mission for brief");
			const card = store.addEvidence(evidence(created.id, { id: "ev-events", lane: "source", grade: "B" }));
			const recorded = store.recordDecision(decision(created.id, { id: "dec-events", confidence: "medium" }));

			expect(bus.snapshot()).toEqual([
				{
					type: "research.brief.created",
					missionId: mission.id,
					briefId: created.id,
					objectiveId: "objective-events",
					lanes: ["repo", "source"],
					ts: created.createdAt,
				},
				{
					type: "research.evidence.added",
					missionId: mission.id,
					briefId: created.id,
					evidenceId: card.id,
					lane: "source",
					grade: "B",
					ts: card.capturedAt,
				},
				{
					type: "decision.recorded",
					missionId: mission.id,
					briefId: created.id,
					decisionId: recorded.id,
					confidence: "medium",
					ts: recorded.createdAt,
				},
			]);
		});
	});

	test("derives conservative deterministic assessment from research records", () => {
		const store = createStore();
		const created = store.createBrief(
			brief({
				id: "research-assess",
				lanes: ["repo", "source"],
				requiredEvidence: [],
				disallowedEvidence: [],
				stopCriteria: [],
			}),
		);

		expect(store.assessBrief(created.id)).toEqual({
			briefId: created.id,
			readiness: "insufficient",
			incompleteLanes: ["repo", "source"],
			speculativeEvidenceIds: [],
			conflictingEvidenceIds: [],
			blockingCount: 0,
			recommendedNextAction: "collect-evidence",
		});

		store.addEvidence(evidence(created.id, { id: "ev-repo", lane: "repo", claims: ["allow durable storage"] }));
		store.addEvidence(
			evidence(created.id, {
				id: "ev-source",
				lane: "source",
				grade: "D",
				directness: 0.3,
				claims: ["block durable storage"],
			}),
		);
		expect(store.assessBrief(created.id)).toMatchObject({
			readiness: "researching",
			incompleteLanes: [],
			speculativeEvidenceIds: ["ev-source"],
			conflictingEvidenceIds: ["ev-repo", "ev-source"],
			recommendedNextAction: "run-synthesis",
		});

		store.recordSynthesis(synthesis(created.id, { id: "syn-assess" }));
		expect(store.assessBrief(created.id)).toMatchObject({
			readiness: "ready-to-critique",
			recommendedNextAction: "run-critique",
		});

		store.recordCritique(critique(created.id, { id: "crit-assess", verdict: "accept", blockingCount: 0 }));
		expect(store.assessBrief(created.id)).toMatchObject({
			readiness: "ready-to-decide",
			recommendedNextAction: "record-decision",
		});

		store.recordDecision(decision(created.id, { id: "dec-assess" }));
		expect(store.assessBrief(created.id)).toMatchObject({
			readiness: "decided",
			recommendedNextAction: "none",
		});
	});

	test("persists deterministic runtime critic checks and builds selective uncertainty maps", () => {
		const store = createStore();
		const created = store.createBrief(
			brief({
				id: "research-critic",
				lanes: ["repo", "source", "social"],
				requiredEvidence: [],
				disallowedEvidence: [],
				stopCriteria: [],
			}),
		);
		const weak = store.addEvidence(
			evidence(created.id, {
				id: "ev-weak",
				lane: "repo",
				grade: "D",
				directness: 0.2,
				specificity: 0.2,
			}),
		);

		const checks = store.refreshRuntimeCriticChecks(created.id);

		expect(checks.map(check => [check.trigger, check.severity, check.requiredAction, check.lane])).toEqual([
			["missing-lane-evidence", "blocking", "collect-evidence", "social"],
			["missing-lane-evidence", "blocking", "collect-evidence", "source"],
			["speculative-evidence", "soft", "collect-evidence", "repo"],
		]);
		expect(checks[2]?.evidenceRefs).toEqual([weak.id]);
		expect(store.listRuntimeCriticChecks(created.id)).toEqual(checks);

		const map = store.getUncertaintyMap(created.id, { requiredLanes: ["repo", "social"] });

		expect(map.requiredLanes).toEqual(["repo", "social"]);
		expect(map.parts).toEqual([
			expect.objectContaining({
				lane: "repo",
				evidenceCount: 1,
				missingEvidence: false,
				speculativeEvidenceIds: [weak.id],
				status: "uncertain",
			}),
			expect.objectContaining({
				lane: "social",
				evidenceCount: 0,
				missingEvidence: true,
				status: "uncertain",
			}),
		]);
	});

	test("brief policy requirements affect readiness and runtime critic checks", () => {
		const store = createStore();
		const created = store.createBrief(
			brief({
				id: "research-policy",
				lanes: ["repo", "source"],
				requiredEvidence: ["primary source"],
				disallowedEvidence: ["uncited claim"],
				stopCriteria: ["two lanes covered"],
			}),
		);
		const badEvidence = store.addEvidence(
			evidence(created.id, {
				id: "ev-policy",
				lane: "repo",
				excerpt: "This uncited claim is only repo-local.",
				claims: ["uncited claim"],
			}),
		);

		expect(store.assessBrief(created.id)).toMatchObject({
			readiness: "insufficient",
			recommendedNextAction: "collect-evidence",
			blockingCount: 3,
			incompleteLanes: ["source"],
			speculativeEvidenceIds: [badEvidence.id],
		});

		store.addEvidence(
			evidence(created.id, {
				id: "ev-source-policy",
				lane: "source",
				excerpt: "Primary source confirms two lanes covered.",
				claims: ["primary source", "two lanes covered"],
			}),
		);
		expect(store.assessBrief(created.id)).toMatchObject({
			readiness: "insufficient",
			recommendedNextAction: "run-synthesis",
			blockingCount: 1,
		});

		const checks = store.refreshRuntimeCriticChecks(created.id);
		expect(
			checks.some(
				check => check.trigger === "policy-disallowed-evidence" && check.evidenceRefs.includes(badEvidence.id),
			),
		).toBe(true);
	});

	test("structured critique findings persist and drive runtime critic checks", () => {
		const store = createStore();
		const created = store.createBrief(
			brief({ id: "research-findings", requiredEvidence: [], disallowedEvidence: [], stopCriteria: [] }),
		);
		const card = store.addEvidence(evidence(created.id, { id: "ev-finding" }));
		const recorded = store.recordCritique(
			critique(created.id, {
				id: "crit-findings",
				blockingCount: 0,
				softCount: 0,
				verdict: "needs-more-research",
				findings: [
					{
						id: "finding-blocker",
						severity: "blocking",
						requiredAction: "collect-evidence",
						message: "Persisted blocker requires source proof.",
						evidenceRefs: [card.id],
					},
				],
			}),
		);

		expect(store.getLatestCritique(created.id)).toEqual(recorded);
		expect(store.listCritiques(created.id)[0]?.findings).toEqual(recorded.findings);
		expect(store.assessBrief(created.id)).toMatchObject({
			readiness: "blocked",
			blockingCount: 1,
			recommendedNextAction: "collect-evidence",
		});
		expect(store.deriveRuntimeCriticChecks(created.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					trigger: "critique-finding",
					severity: "blocking",
					message: "Persisted blocker requires source proof.",
					evidenceRefs: [card.id],
				}),
			]),
		);
	});
});
