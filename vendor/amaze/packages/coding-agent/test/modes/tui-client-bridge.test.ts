import { describe, expect, test } from "bun:test";
import { createTuiClientBridge } from "../../src/modes/tui-client-bridge";
import type { ClientBridgePermissionOption } from "../../src/session/client-bridge";

const INFRA_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Approve", kind: "allow_once" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

function bridgeWith(answer: boolean, capture?: (title: string, message: string) => void) {
	return createTuiClientBridge({
		async showHookConfirm(title, message) {
			capture?.(title, message);
			return answer;
		},
	});
}

describe("createTuiClientBridge", () => {
	test("advertises only requestPermission capability", () => {
		const bridge = bridgeWith(true);
		expect(bridge.capabilities.requestPermission).toBe(true);
		expect(bridge.capabilities.terminal).toBe(false);
		expect(bridge.capabilities.readTextFile).toBe(false);
		expect(bridge.capabilities.writeTextFile).toBe(false);
	});

	test("approve → selected allow_once", async () => {
		let seenTitle = "";
		let seenMessage = "";
		const bridge = bridgeWith(true, (t, m) => {
			seenTitle = t;
			seenMessage = m;
		});
		const outcome = await bridge.requestPermission!(
			{
				toolCallId: "c1",
				toolName: "bash",
				title: "Infrastructure deploy: kubectl apply",
				rawInput: { command: "kubectl apply -f deploy.yaml" },
			},
			INFRA_OPTIONS,
		);
		expect(outcome).toEqual({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
		expect(seenTitle).toContain("kubectl apply");
		expect(seenMessage).toBe("$ kubectl apply -f deploy.yaml");
	});

	test("reject → selected reject_once", async () => {
		const bridge = bridgeWith(false);
		const outcome = await bridge.requestPermission!(
			{ toolCallId: "c2", toolName: "bash", title: "Infrastructure deploy: terraform destroy" },
			INFRA_OPTIONS,
		);
		expect(outcome).toEqual({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	});

	test("falls back to cancelled when the dialog throws", async () => {
		const bridge = createTuiClientBridge({
			async showHookConfirm() {
				throw new Error("ui torn down");
			},
		});
		const outcome = await bridge.requestPermission!(
			{ toolCallId: "c3", toolName: "bash", title: "x" },
			INFRA_OPTIONS,
		);
		expect(outcome).toEqual({ outcome: "cancelled" });
	});
});
