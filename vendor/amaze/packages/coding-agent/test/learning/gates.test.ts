import { afterEach, describe, expect, test } from "bun:test";
import {
	defaultExpiresAt,
	defaultGate,
	expirePending,
	type NewLearningProposal,
	ProposalStore,
} from "../../src/learning";

const stores: ProposalStore[] = [];

function createStore(): ProposalStore {
	const store = new ProposalStore(":memory:");
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
	}
});

function memoryProposal(overrides: Partial<NewLearningProposal> = {}): NewLearningProposal {
	return {
		type: "memory",
		gate: "review",
		evidence: { sessionIds: [], eventRefs: [], sampleN: 1 },
		provenance: { source: "manual" },
		content: "remember this",
		memoryType: "note",
		confidence: "inferred",
		...overrides,
	} as NewLearningProposal;
}

describe("proposal gates", () => {
	test("uses auto only for tool-verified memory proposals", () => {
		expect(defaultGate("memory", { type: "memory", confidence: "tool_verified" })).toBe("auto");
		expect(defaultGate("memory", { type: "memory", confidence: "inferred" })).toBe("review");
		expect(defaultGate("memory", { type: "memory", confidence: "hypothesis" })).toBe("review");
	});

	test("uses review for skill and rule proposals", () => {
		expect(defaultGate("skill", { type: "skill" })).toBe("review");
		expect(defaultGate("rule", { type: "rule" })).toBe("review");
	});

	test("requires humans for settings proposals", () => {
		expect(defaultGate("settings", { type: "settings" })).toBe("human-required");
	});

	test("computes default expiration from day count", () => {
		expect(defaultExpiresAt(1_000, 2)).toBe(1_000 + 2 * 24 * 60 * 60 * 1000);
	});

	test("expires only pending proposals whose expiresAt is before now", () => {
		const store = createStore();
		const now = 10_000;
		const expiredPending = store.create(memoryProposal({ expiresAt: now - 1, content: "expired" }));
		const boundaryPending = store.create(memoryProposal({ expiresAt: now, content: "boundary" }));
		const futurePending = store.create(memoryProposal({ expiresAt: now + 1, content: "future" }));
		const alreadyRejected = store.create(memoryProposal({ expiresAt: now - 1, content: "rejected" }));
		store.reject(alreadyRejected.id, "not needed");

		expect(expirePending(store, now)).toBe(1);
		expect(store.get(expiredPending.id)?.status).toBe("expired");
		expect(store.get(boundaryPending.id)?.status).toBe("pending");
		expect(store.get(futurePending.id)?.status).toBe("pending");
		expect(store.get(alreadyRejected.id)?.status).toBe("rejected");
		expect(expirePending(store, now)).toBe(0);
	});
});
