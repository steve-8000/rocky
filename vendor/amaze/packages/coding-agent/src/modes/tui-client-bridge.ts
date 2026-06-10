/**
 * TUI-side {@link ClientBridge}.
 *
 * In ACP mode the editor host provides `requestPermission`; plain terminal (TUI)
 * mode had no client bridge, so tools that require interactive approval (notably
 * infrastructure/deploy bash commands) were blocked fail-closed. This bridge
 * routes those approval requests to the TUI's Yes/No confirmation dialog
 * (`showHookConfirm`) so the user can approve or reject each command in the
 * terminal.
 *
 * It deliberately advertises ONLY the `requestPermission` capability — file and
 * terminal operations continue to run locally as before (the TUI is itself the
 * local terminal, so there is no remote host to delegate fs/terminal to).
 */

import { logger } from "@amaze/utils";
import type {
	ClientBridge,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../session/client-bridge";

/** Minimal surface the bridge needs from the interactive mode. */
export interface TuiPermissionHost {
	/** Yes/No modal that steals focus and resolves true on "Yes". */
	showHookConfirm(title: string, message: string): Promise<boolean>;
}

/**
 * Build a ClientBridge backed by the TUI confirmation dialog. The agent session
 * calls `requestPermission` for gated tool calls; we present an approve/reject
 * prompt and map the answer to an `allow_once` / `reject_once` outcome.
 *
 * There is intentionally no `allow_always` path here: the caller (e.g. the bash
 * infra-deploy gate) decides cacheability. For commands routed through this
 * bridge we always re-prompt, matching the "every infra command needs approval"
 * guarantee.
 */
export function createTuiClientBridge(host: TuiPermissionHost): ClientBridge {
	return {
		// Used solely for the bash infra-deploy gate; never gates other mutations.
		infraApprovalOnly: true,
		capabilities: {
			readTextFile: false,
			writeTextFile: false,
			terminal: false,
			requestPermission: true,
		},
		async requestPermission(
			toolCall: ClientBridgePermissionToolCall,
			options: ClientBridgePermissionOption[],
		): Promise<ClientBridgePermissionOutcome> {
			const allowOption = options.find(o => o.kind === "allow_once") ?? options.find(o => o.kind === "allow_always");
			const rejectOption =
				options.find(o => o.kind === "reject_once") ?? options.find(o => o.kind === "reject_always");
			const command =
				toolCall.rawInput && typeof toolCall.rawInput === "object" && !Array.isArray(toolCall.rawInput)
					? (toolCall.rawInput as { command?: unknown }).command
					: undefined;
			const message = typeof command === "string" ? `$ ${command}` : toolCall.toolName;
			try {
				const approved = await host.showHookConfirm(toolCall.title, message);
				if (approved && allowOption) {
					return { outcome: "selected", optionId: allowOption.optionId, kind: allowOption.kind };
				}
				if (!approved && rejectOption) {
					return { outcome: "selected", optionId: rejectOption.optionId, kind: rejectOption.kind };
				}
				// No matching option supplied for the chosen answer → treat as cancel.
				return { outcome: "cancelled" };
			} catch (error) {
				logger.warn("tui.requestPermission.failed", { error: String(error) });
				return { outcome: "cancelled" };
			}
		},
	};
}
