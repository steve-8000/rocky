import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { createTuiClientBridge } from "../../src/modes/tui-client-bridge";
import type {
	ClientBridge,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../../src/session/client-bridge";
import { BashTool } from "../../src/tools/bash";
import type { ToolSession } from "../../src/tools/index";

function makeSession(opts: {
	settings?: Settings;
	bridge?: ClientBridge;
	cwd?: string;
	getTurnIndex?: () => number | null;
}): ToolSession {
	return {
		cwd: opts.cwd ?? "/tmp",
		hasUI: false,
		settings: opts.settings ?? Settings.isolated({}),
		skills: [],
		getClientBridge: () => opts.bridge,
		getTurnIndex: opts.getTurnIndex,
	} as unknown as ToolSession;
}

function approvingBridge(decision: "allow_once" | "reject_once"): ClientBridge {
	return countingBridge(() => decision).bridge;
}

function countingBridge(decision: () => "allow_once" | "reject_once"): { bridge: ClientBridge; count: () => number } {
	let requests = 0;
	return {
		bridge: {
			capabilities: { requestPermission: true } as ClientBridge["capabilities"],
			requestPermission: async (
				_toolCall: ClientBridgePermissionToolCall,
				_options: ClientBridgePermissionOption[],
			): Promise<ClientBridgePermissionOutcome> => {
				requests++;
				const next = decision();
				return { outcome: "selected", optionId: next, kind: next };
			},
		} as ClientBridge,
		count: () => requests,
	};
}

async function runTool(tool: BashTool, command: string): Promise<{ ok: boolean; error?: string }> {
	try {
		await tool.execute("call-1", { command, timeout: 5 } as never, undefined, undefined, undefined);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function run(session: ToolSession, command: string): Promise<{ ok: boolean; error?: string }> {
	return runTool(new BashTool(session), command);
}

describe("infra deploy approval gate (bash)", () => {
	test("blocks an infra command fail-closed when no approval channel is connected", async () => {
		const session = makeSession({ settings: Settings.isolated({}) });
		const result = await run(session, "kubectl apply -f deploy.yaml");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("requires explicit user approval");
		expect(result.error).toContain("kubectl apply");
	});

	test("blocks when the user rejects the infra command", async () => {
		const session = makeSession({ bridge: approvingBridge("reject_once") });
		const result = await run(session, "terraform destroy -auto-approve");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("requires explicit user approval");
	});

	test("TUI client bridge approval lets the infra gate pass (not blocked by approval)", async () => {
		const tuiBridge = createTuiClientBridge({
			async showHookConfirm() {
				return true;
			},
		});
		const session = makeSession({ bridge: tuiBridge });
		const result = await run(session, "kubectl apply -f /nonexistent.yaml");
		// Approved → the infra approval gate does NOT block. It may still fail on a
		// missing kubectl binary, but never with the approval error.
		if (!result.ok) {
			expect(result.error).not.toContain("requires explicit user approval");
		}
	});

	test("TUI client bridge rejection blocks the infra command", async () => {
		const tuiBridge = createTuiClientBridge({
			async showHookConfirm() {
				return false;
			},
		});
		const session = makeSession({ bridge: tuiBridge });
		const result = await run(session, "kubectl delete ns prod");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("requires explicit user approval");
	});

	test("respects infra.approval.allowlist to bypass a precise pattern", async () => {
		const session = makeSession({
			cwd: "/definitely-missing-amaze-infra-test-cwd",
			settings: Settings.isolated({ "infra.approval.allowlist": ["^kubectl apply -f deploy\\.yaml$"] }),
		});
		const result = await run(session, "kubectl apply -f deploy.yaml");
		expect(result.ok).toBe(false);
		expect(result.error).not.toContain("requires explicit user approval");
		expect(result.error).toContain("Working directory does not exist");
	});

	test("does not gate read-only infra inspection", async () => {
		const session = makeSession({ settings: Settings.isolated({}) });
		// `kubectl version --client` is read-only; the infra gate must not block it.
		// It may still fail if kubectl is absent, but NOT with the approval error.
		const result = await run(session, "kubectl version --client");
		if (!result.ok) {
			expect(result.error).not.toContain("requires explicit user approval");
		}
	});

	test("disabling infra.approval.enabled removes the gate", async () => {
		const session = makeSession({ settings: Settings.isolated({ "infra.approval.enabled": false }) });
		// With the gate off, a kubectl command is no longer blocked by approval.
		// It may fail for other reasons (missing binary) but not the approval error.
		const result = await run(session, "kubectl apply -f /nonexistent.yaml");
		if (!result.ok) {
			expect(result.error).not.toContain("requires explicit user approval");
		}
	});

	test("reuses approval for the same exact infra command in the same turn", async () => {
		const bridge = countingBridge(() => "allow_once");
		const session = makeSession({
			bridge: bridge.bridge,
			cwd: "/definitely-missing-amaze-infra-test-cwd",
			getTurnIndex: () => 3,
		});
		const tool = new BashTool(session);

		const first = await runTool(tool, "kubectl apply -f deploy.yaml");
		const second = await runTool(tool, "kubectl apply -f deploy.yaml");

		expect(first.error).not.toContain("requires explicit user approval");
		expect(second.error).not.toContain("requires explicit user approval");
		expect(bridge.count()).toBe(1);
	});

	test("prompts every time when no turn index is available", async () => {
		const bridge = countingBridge(() => "allow_once");
		const session = makeSession({
			bridge: bridge.bridge,
			cwd: "/definitely-missing-amaze-infra-test-cwd",
		});
		const tool = new BashTool(session);

		await runTool(tool, "kubectl apply -f deploy.yaml");
		await runTool(tool, "kubectl apply -f deploy.yaml");

		expect(bridge.count()).toBe(2);
	});

	test("prompts again for a different infra command in the same turn", async () => {
		const bridge = countingBridge(() => "allow_once");
		const session = makeSession({
			bridge: bridge.bridge,
			cwd: "/definitely-missing-amaze-infra-test-cwd",
			getTurnIndex: () => 3,
		});
		const tool = new BashTool(session);

		await runTool(tool, "kubectl apply -f deploy.yaml");
		await runTool(tool, "kubectl delete ns prod");

		expect(bridge.count()).toBe(2);
	});

	test("prompts again for the same infra command after the turn changes", async () => {
		const bridge = countingBridge(() => "allow_once");
		let turnIndex = 3;
		const session = makeSession({
			bridge: bridge.bridge,
			cwd: "/definitely-missing-amaze-infra-test-cwd",
			getTurnIndex: () => turnIndex,
		});
		const tool = new BashTool(session);

		await runTool(tool, "kubectl apply -f deploy.yaml");
		turnIndex = 4;
		await runTool(tool, "kubectl apply -f deploy.yaml");

		expect(bridge.count()).toBe(2);
	});

	test("does not cache rejected infra approvals", async () => {
		const bridge = countingBridge(() => "reject_once");
		const session = makeSession({
			bridge: bridge.bridge,
			cwd: "/definitely-missing-amaze-infra-test-cwd",
			getTurnIndex: () => 3,
		});
		const tool = new BashTool(session);

		const first = await runTool(tool, "kubectl apply -f deploy.yaml");
		const second = await runTool(tool, "kubectl apply -f deploy.yaml");

		expect(first.error).toContain("requires explicit user approval");
		expect(second.error).toContain("requires explicit user approval");
		expect(bridge.count()).toBe(2);
	});
});
