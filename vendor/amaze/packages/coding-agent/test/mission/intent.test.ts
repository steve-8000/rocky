import { describe, expect, test } from "bun:test";
import type { Mission } from "../../src/mission/core/mission";
import { defaultMissionClassifier, inferIntent, type MissionIntent, riskAtLeast } from "../../src/mission/policy";

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

describe("inferIntent", () => {
	const cases: Array<[string, MissionIntent]> = [
		["안녕", "conversation"],
		["what does foo do?", "question_answering"],
		["왜 이 함수가 이렇게 동작해?", "question_answering"],
		["look at the auth flow", "repo_exploration"],
		["fix the null-deref bug", "code_change"],
		["add a retry to the http client", "code_change"],
		["이 버그 수정해줘", "code_change"],
		["refactor the session manager", "runtime_refactor"],
		["리팩터 하자", "runtime_refactor"],
		["change the mission control architecture", "architecture_change"],
		["rebrand paseo and amaze to fpacs", "architecture_change"],
		["rename the @amaze/* packages to @fpacs/*", "architecture_change"],
		["quarantine packages/app/src into legacy-src", "architecture_change"],
		["wipe runtime memory under ~/.fpacs", "architecture_change"],
		["clean cutover from amaze to fpacs", "architecture_change"],
		["리브랜딩 진행", "architecture_change"],
		["전체 격리 후 재구축", "architecture_change"],
		["패키지 이름 바꾸기", "architecture_change"],
		["prepare for the v3 release hardening", "release_hardening"],
		["안정화 작업", "release_hardening"],
		["ssh into prod and patch the cert", "external_side_effect"],
		["deploy v3 to staging", "external_side_effect"],
	];

	for (const [input, expected] of cases) {
		test(`${input} -> ${expected}`, () => {
			expect(inferIntent({ objective: input })).toBe(expected);
		});
	}

	test("classifier includes inferred intent", () => {
		const decision = defaultMissionClassifier.classify(
			mission({ objective: "refactor mission control architecture" }),
		);
		expect(decision.intent).toBe("architecture_change");
		expect(riskAtLeast(decision.riskLevel, "medium")).toBe(true);
	});

	test("classifier includes destructive architecture intent", () => {
		const decision = defaultMissionClassifier.classify(
			mission({ objective: "rebrand the monorepo architecture and migrate the schema" }),
		);
		expect(decision.intent).toBe("architecture_change");
		expect(riskAtLeast(decision.riskLevel, "high")).toBe(true);
	});
});
