import type { ComplementarityScore, EvidenceCard, ResearchBrief } from "./types";

const GRADE_WEIGHT: Record<string, number> = { A: 1.0, B: 0.75, C: 0.5, D: 0.25, E: 0.1 };
const SOCIAL_OVERWEIGHT_THRESHOLD = 0.5;

export function scoreComplementarity(brief: ResearchBrief, evidence: EvidenceCard[]): ComplementarityScore {
	const breakdown = brief.lanes.map(lane => {
		const cards = evidence.filter(card => card.lane === lane);
		return {
			lane,
			cardCount: cards.length,
			avgGradeWeight: mean(cards.map(card => gradeWeight(card))),
		};
	});
	const laneCoverage = brief.lanes.length
		? breakdown.filter(item => item.cardCount > 0).length / brief.lanes.length
		: 0;
	const sourceQuality = mean(
		evidence.map(
			card =>
				0.4 * gradeWeight(card) +
				0.2 * card.directness +
				0.2 * card.specificity +
				0.1 * card.recency +
				0.1 * card.reproducibility,
		),
	);
	const contradictionCount = countContradictionPairs(evidence);
	const contradictionPenalty = Math.min(0.3, contradictionCount * 0.05);
	const stalenessPenalty = mean(evidence.map(card => Math.max(0, 1 - card.recency) * 0.25));
	const socialShare = evidence.length ? evidence.filter(card => card.lane === "social").length / evidence.length : 0;
	const socialOverweightPenalty =
		socialShare > SOCIAL_OVERWEIGHT_THRESHOLD ? 0.3 * (socialShare - SOCIAL_OVERWEIGHT_THRESHOLD) : 0;
	const total = clamp01(
		laneCoverage * 0.4 + sourceQuality * 0.6 - contradictionPenalty - stalenessPenalty - socialOverweightPenalty,
	);

	return {
		briefId: brief.id,
		total,
		laneCoverage,
		sourceQuality,
		contradictionPenalty,
		stalenessPenalty,
		socialOverweightPenalty,
		breakdown,
	};
}

function gradeWeight(card: EvidenceCard): number {
	return GRADE_WEIGHT[card.grade] ?? 0;
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

type CueBucket = "defer" | "adopt" | "exists" | "missing" | "allow" | "block";

const OPPOSITE_CUES: Array<[CueBucket, CueBucket]> = [
	["defer", "adopt"],
	["exists", "missing"],
	["allow", "block"],
];

const CUE_WORDS: Record<CueBucket, string[]> = {
	defer: ["defer", "deferred", "rejected", "not yet"],
	adopt: ["adopt", "adopted", "enable", "ship now"],
	exists: ["exists", "implemented"],
	missing: ["missing", "not implemented", "no production"],
	allow: ["allow"],
	block: ["block", "blocked"],
};

const STOPWORDS = new Set([
	"about",
	"after",
	"again",
	"being",
	"could",
	"every",
	"from",
	"have",
	"into",
	"should",
	"their",
	"there",
	"these",
	"those",
	"with",
	"would",
]);

export function countContradictionPairs(evidence: EvidenceCard[]): number {
	let count = 0;
	for (let leftIndex = 0; leftIndex < evidence.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < evidence.length; rightIndex += 1) {
			const left = evidence[leftIndex];
			const right = evidence[rightIndex];
			if (!left || !right || left.id === right.id) continue;
			if (cardsContradict(left, right)) count += 1;
		}
	}
	return count;
}

export function evidenceContradictsAny(card: EvidenceCard, evidence: EvidenceCard[]): boolean {
	return evidence.some(other => other.id !== card.id && cardsContradict(card, other));
}

function cardsContradict(left: EvidenceCard, right: EvidenceCard): boolean {
	for (const leftClaim of left.claims) {
		for (const rightClaim of right.claims) {
			if (claimsContradict(leftClaim, rightClaim)) return true;
		}
	}
	return false;
}

function claimsContradict(left: string, right: string): boolean {
	const leftNormalized = left.toLowerCase();
	const rightNormalized = right.toLowerCase();
	const sharedTokens = claimTokens(leftNormalized).filter(token => claimTokens(rightNormalized).includes(token));
	if (sharedTokens.length === 0) return false;
	const leftBuckets = cueBuckets(leftNormalized);
	const rightBuckets = cueBuckets(rightNormalized);
	return OPPOSITE_CUES.some(
		([a, b]) => (leftBuckets.has(a) && rightBuckets.has(b)) || (leftBuckets.has(b) && rightBuckets.has(a)),
	);
}

function cueBuckets(claim: string): Set<CueBucket> {
	const buckets = new Set<CueBucket>();
	for (const [bucket, cues] of Object.entries(CUE_WORDS) as Array<[CueBucket, string[]]>) {
		if (cues.some(cue => claim.includes(cue))) buckets.add(bucket);
	}
	return buckets;
}

function claimTokens(claim: string): string[] {
	return claim.split(/[^a-z0-9]+/).filter(token => token.length >= 5 && !STOPWORDS.has(token));
}
