import {
	runMissionDecisionCommand,
	runMissionEvidenceCommand,
	runMissionRollbackCommand,
	runMissionShowCommand,
	runMissionStreamCommand,
	runMissionVerifyCommand,
} from "../../cli/mission";
import type { MissionControlRuntime } from "../../mission/core/mission-control-runtime";

/**
 * Canonical `/mission` subcommands.
 *
 * Read-only verbs (`show`, `stream`, `evidence`, `decision`, `verify`,
 * `rollback`) are backed by the read-model CLI in {@link runMissionSlashCommand}.
 * Mutating verbs (`create`, `complete`, `cancel`, `approve`, `panel`) require
 * session context and are handled directly by the slash-command registry; they
 * call into {@link MissionControlRuntime} on the live session.
 */
export const MISSION_SUBCOMMANDS = [
	{ name: "create", description: "Create a new mission and make it active", usage: "<objective>" },
	{ name: "show", description: "Show mission details", usage: "<missionId>" },
	{ name: "stream", description: "Show or follow the mission event log", usage: "<missionId> [--follow]" },
	{ name: "evidence", description: "List mission evidence", usage: "<missionId>" },
	{ name: "decision", description: "Show the mission decision", usage: "<missionId>" },
	{ name: "verify", description: "Show mission verification status", usage: "<missionId>" },
	{ name: "approve", description: "Approve the active mission's plan as its proposal (unblocks mutations)" },
	{ name: "complete", description: "Complete the active mission with an outcome summary", usage: "[summary]" },
	{ name: "cancel", description: "Cancel the active mission", usage: "[--reason <text>]" },
	{ name: "rollback", description: "Show mission rollback candidates", usage: "<missionId>" },
	{
		name: "panel",
		description: "Show or set Mission Control panel display (off/compact/expanded/toggle)",
		usage: "[off|compact|expanded|toggle]",
	},
] as const;

const READ_VERBS = new Set(["show", "stream", "evidence", "decision", "verify", "rollback"]);

const USAGE =
	"Usage: /mission <create|show|stream|evidence|decision|verify|approve|complete|cancel|rollback|panel> [args]";

/** Capture `process.stdout.write` for the duration of `fn`, returning what was written. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	let out = "";
	const original = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = original;
	}
	return out.replace(/\n$/, "");
}

export interface MissionCommandResult {
	/** Text to surface to the operator. */
	output: string;
	/** True when the verb has no backing write surface yet (stubbed). */
	stub: boolean;
}

/**
 * Run a parsed `/mission` invocation against the mission read-model surface.
 *
 * Pure with respect to the session — it only reads the autonomy DB / event log
 * and returns text. Mutating verbs return a stub message instead of side
 * effects. Used by both the slash-command handler and tests.
 */
export async function runMissionSlashCommand(args: string): Promise<MissionCommandResult> {
	const trimmed = args.trim();
	if (!trimmed) return { output: USAGE, stub: false };
	const spaceIdx = trimmed.search(/\s/);
	const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
	const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

	// `create`, `complete`, `cancel`, `approve`, `panel` are session-scoped writers handled by the
	// slash-command registry before this read-only helper runs. If they reach here it means the
	// helper was called without a session — surface a clear hint instead of pretending to act.
	if (verb === "create" || verb === "complete" || verb === "cancel") {
		return {
			output: `\`/mission ${verb}\` requires a live session; run it from the interactive TUI or ACP client.`,
			stub: true,
		};
	}
	if (!READ_VERBS.has(verb)) {
		return { output: USAGE, stub: false };
	}

	const tokens = rest.split(/\s+/).filter(Boolean);
	const id = tokens.find(token => !token.startsWith("-"));
	if (!id) {
		return { output: `Usage: /mission ${verb} <missionId>`, stub: false };
	}
	const follow = tokens.includes("--follow") || tokens.includes("-f");

	try {
		const output = await captureStdout(async () => {
			switch (verb) {
				case "show":
					await runMissionShowCommand({ id });
					return;
				case "stream":
					await runMissionStreamCommand({ id, follow, once: follow });
					return;
				case "evidence":
					await runMissionEvidenceCommand({ id });
					return;
				case "decision":
					await runMissionDecisionCommand({ id });
					return;
				case "verify":
					await runMissionVerifyCommand({ id });
					return;
				case "rollback":
					await runMissionRollbackCommand({ id });
					return;
			}
		});
		return { output, stub: false };
	} catch (error) {
		return { output: error instanceof Error ? error.message : String(error), stub: false };
	}
}

/**
 * Handle the session-scoped writer verbs (`create`, `complete`, `cancel`) against a live
 * MissionControlRuntime. Returns `undefined` when `verb` is not one of these — callers must
 * fall through to the read-model helper or the registry's other verbs.
 *
 * Acceptance-failure / "no active mission" cases yield a string explanation; the slash
 * registry surfaces it to the operator.
 */
export async function handleMissionWriteVerb(
	verb: string,
	args: string,
	missionControl: MissionControlRuntime | undefined,
): Promise<string | undefined> {
	if (verb !== "create" && verb !== "complete" && verb !== "cancel") return undefined;
	if (!missionControl) {
		return `\`/mission ${verb}\` requires an active session with a mission runtime.`;
	}
	const rest = stripVerb(args, verb);

	if (verb === "create") {
		const objective = rest.trim();
		if (!objective) return "Usage: /mission create <objective>";
		try {
			const mission = await missionControl.createMission({
				title: deriveTitleFromObjective(objective),
				objective,
				mode: "interactive",
			});
			return `Created mission ${mission.id} (lifecycle: ${mission.lifecycle}). It is now the active mission.`;
		} catch (err) {
			return `Failed to create mission: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	if (verb === "cancel") {
		const reason = parseReason(rest);
		try {
			const mission = await missionControl.cancelActiveMission(reason);
			return mission
				? `Cancelled mission ${mission.id}${reason ? ` (reason: ${reason})` : ""}. No active mission now.`
				: "No active mission to cancel.";
		} catch (err) {
			return `Failed to cancel mission: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	// verb === "complete"
	const summary = rest.trim() || "Completed via /mission complete.";
	try {
		const mission = await missionControl.completeActiveMission({ status: "success", summary });
		return mission ? `Completed mission ${mission.id}. No active mission now.` : "No active mission to complete.";
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// MissionRuntime#complete throws MissionAcceptanceFailureError when unmet criteria block close.
		return `Cannot complete mission: ${message}`;
	}
}

function stripVerb(args: string, verb: string): string {
	const trimmed = args.trim();
	if (!trimmed.toLowerCase().startsWith(verb)) return trimmed;
	return trimmed.slice(verb.length).trim();
}

function parseReason(rest: string): string | undefined {
	const match = rest.match(/--reason(?:\s+|=)(.+)$/);
	if (match) return match[1].trim() || undefined;
	return rest.trim() || undefined;
}

function deriveTitleFromObjective(objective: string): string {
	const first = objective.split(/\r?\n/)[0]?.trim() ?? "";
	const truncated = first.length > 80 ? `${first.slice(0, 77)}...` : first;
	return truncated || "Untitled mission";
}
