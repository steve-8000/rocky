import { describe, expect, test } from "bun:test";
import { scoreComplementarity } from "../../src/research/scoring";
import type { EvidenceCard, ResearchBrief } from "../../src/research/types";

function brief(overrides: Partial<ResearchBrief> = {}): ResearchBrief {
	return {
		id: "brief-1",
		objectiveId: null,
		question: "What is true?",
		lanes: ["repo", "source", "social"],
		requiredEvidence: [],
		disallowedEvidence: [],
		riskLevel: "medium",
		stopCriteria: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function card(overrides: Partial<EvidenceCard> = {}): EvidenceCard {
	return {
		id: "ev-1",
		briefId: "brief-1",
		lane: "repo",
		grade: "A",
		sourceRef: "src/file.ts:1",
		excerpt: "evidence",
		claims: ["claim"],
		capturedAt: 1,
		directness: 1,
		specificity: 1,
		recency: 1,
		reproducibility: 1,
		...overrides,
	};
}

describe("scoreComplementarity", () => {
	test("empty evidence has zero coverage, quality, and total", () => {
		const score = scoreComplementarity(brief(), []);

		expect(score.laneCoverage).toBe(0);
		expect(score.sourceQuality).toBe(0);
		expect(score.total).toBe(0);
	});

	test("balanced three-lane grade A evidence scores high", () => {
		const evidence: EvidenceCard[] = [
			card({ id: "repo", lane: "repo" }),
			card({ id: "source", lane: "source" }),
			card({ id: "social", lane: "social" }),
		];
		const score = scoreComplementarity(brief(), evidence);

		expect(score.laneCoverage).toBe(1);
		expect(score.sourceQuality).toBeCloseTo(1);
		expect(score.total).toBeCloseTo(1);
		expect(score.total).toBeGreaterThan(0.9);
	});

	test("social-only evidence triggers overweight penalty", () => {
		const evidence = [
			card({ id: "social-1", lane: "social", grade: "C", directness: 0.5, specificity: 0.5 }),
			card({ id: "social-2", lane: "social", grade: "C", directness: 0.5, specificity: 0.5 }),
		];
		const score = scoreComplementarity(brief(), evidence);

		expect(score.socialOverweightPenalty).toBeGreaterThan(0);
		expect(score.total).toBeLessThan(0.5);
	});

	test("stale evidence triggers staleness penalty", () => {
		const score = scoreComplementarity(brief({ lanes: ["repo"] }), [card({ recency: 0 })]);

		expect(score.stalenessPenalty).toBeGreaterThan(0);
		expect(score.stalenessPenalty).toBeCloseTo(0.25);
	});

	test("detects deterministic contradiction pairs and applies penalty", () => {
		const score = scoreComplementarity(brief({ lanes: ["repo", "source"] }), [
			card({ id: "left", lane: "repo", claims: ["mission control snapshot exists and is implemented"] }),
			card({ id: "right", lane: "source", claims: ["mission control snapshot missing with no production path"] }),
		]);

		expect(score.contradictionPenalty).toBe(0.05);
		expect(score.total).toBeLessThan(1);
	});

	test("total clamps at 1", () => {
		const score = scoreComplementarity(brief({ lanes: ["repo"] }), [
			card({ directness: 10, specificity: 10, recency: 10, reproducibility: 10 }),
		]);

		expect(score.total).toBe(1);
	});

	test("total clamps at 0", () => {
		const score = scoreComplementarity(brief({ lanes: ["repo"] }), [
			card({ lane: "social", grade: "E", directness: 0, specificity: 0, recency: 0, reproducibility: 0 }),
		]);

		expect(score.total).toBe(0);
	});
});
