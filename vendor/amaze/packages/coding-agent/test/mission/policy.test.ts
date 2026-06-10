import { describe, expect, test } from "bun:test";
import type { Mission } from "../../src/mission/core/mission";
import { MissionEventBus } from "../../src/mission/event-bus";
import { MissionClassifier, recordPolicyDecision } from "../../src/mission/policy";

function mission(
	overrides: Partial<Pick<Mission, "title" | "objective" | "riskLevel" | "mode">>,
): Pick<Mission, "title" | "objective" | "riskLevel" | "mode"> {
	return {
		title: "Mission",
		objective: "Do the thing",
		riskLevel: "low",
		mode: "interactive",
		...overrides,
	};
}

describe("MissionClassifier", () => {
	const classifier = new MissionClassifier();

	test("low-risk Q&A omits critic, verifier, approval, and denies mutation", () => {
		const d = classifier.classify(mission({ title: "Question", objective: "What is the capital of France?" }));
		expect(d.riskLevel).toBe("low");
		expect(d.requiresCritic).toBe(false);
		expect(d.requiresVerifier).toBe(false);
		expect(d.requiresApproval).toBe(false);
		expect(d.requiresMemory).toBe(false);
		expect(d.deniedToolClasses).toContain("mutation");
		expect(d.deniedToolClasses).toContain("shell");
		expect(d.allowedToolClasses).toContain("read");
	});

	test("repo analysis requires codebase, not web", () => {
		const d = classifier.classify(
			mission({ title: "Analyze", objective: "Explain how does auth work in this codebase" }),
		);
		expect(d.requiresCodebase).toBe(true);
		expect(d.allowedToolClasses).toContain("codebase");
	});

	test("latest-info question requires web + research", () => {
		const d = classifier.classify(
			mission({ title: "News", objective: "What is the latest version of Bun released today?" }),
		);
		expect(d.requiresWeb).toBe(true);
		expect(d.requiresResearch).toBe(true);
		expect(d.allowedToolClasses).toContain("web");
		expect(d.contextBudget.maxWebSources).toBeGreaterThan(0);
	});

	test("high-risk code mutation requires critic + verifier + mutation tools", () => {
		const d = classifier.classify(
			mission({ title: "Refactor", objective: "Refactor the auth architecture and rewrite the security layer" }),
		);
		expect(d.riskLevel).toBe("high");
		expect(d.requiresCritic).toBe(true);
		expect(d.requiresVerifier).toBe(true);
		expect(d.allowedToolClasses).toContain("mutation");
	});

	test("delete/deploy requires approval and is critical", () => {
		const del = classifier.classify(mission({ title: "Cleanup", objective: "Delete the old production database" }));
		expect(del.riskLevel).toBe("critical");
		expect(del.requiresApproval).toBe(true);
		expect(del.requiresVerifier).toBe(true);
		expect(del.allowedToolClasses).toContain("external");

		const deploy = classifier.classify(mission({ title: "Ship", objective: "Deploy the release to production" }));
		expect(deploy.requiresApproval).toBe(true);
		expect(deploy.riskLevel).toBe("critical");
	});

	test("long task requires subagents and memory", () => {
		const d = classifier.classify(
			mission({ title: "Build", objective: "Build this feature end to end, a long task over the whole system" }),
		);
		expect(d.requiresSubagent).toBe(true);
		expect(d.requiresMemory).toBe(true);
	});

	test("caller-asserted risk acts as a floor", () => {
		const d = classifier.classify(mission({ objective: "What is 2 + 2?", riskLevel: "high" }));
		expect(d.riskLevel).toBe("high");
		expect(d.requiresCritic).toBe(true);
	});
});

describe("recordPolicyDecision -> mission.classified", () => {
	test("emits a mission.classified event projecting the decision", () => {
		const bus = new MissionEventBus();
		const classifier = new MissionClassifier();
		const decision = classifier.classify(
			mission({ title: "Cleanup", objective: "Delete the old production database" }),
		);

		const event = recordPolicyDecision(bus, "mission-1", decision, 123);
		expect(event.type).toBe("mission.classified");
		// critical projects down to core `high`.
		expect(event.riskLevel).toBe("high");
		expect(event.missionId).toBe("mission-1");

		const snap = bus.snapshot();
		expect(snap).toHaveLength(1);
		expect(snap[0]).toEqual(event);
	});

	test("low-risk read-only decision carries high confidence", () => {
		const bus = new MissionEventBus();
		const classifier = new MissionClassifier();
		const decision = classifier.classify(mission({ objective: "What is the capital of France?" }));
		const event = recordPolicyDecision(bus, "mission-2", decision);
		expect(event.riskLevel).toBe("low");
		expect(event.confidence).toBe("high");
	});
});
