import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ObjectiveStore } from "../../src/autonomy/store";
import { Settings } from "../../src/config/settings";
import { MissionStore } from "../../src/mission/store";
import { ResearchStore } from "../../src/research/store";
import { BUILTIN_SLASH_COMMANDS_INTERNAL, lookupBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { MISSION_SUBCOMMANDS, runMissionSlashCommand } from "../../src/slash-commands/helpers/mission-command";

const roots: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
	process.env.HOME = originalHome;
	for (const root of roots.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true });
});

/** Create a mission in the default autonomy DB path (homedir/.amaze/autonomy). */
function createMissionFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-slash-"));
	roots.push(root);
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	process.env.HOME = home;
	const dbPath = path.join(os.homedir(), ".amaze", "autonomy", "autonomy.db");
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const objectives = new ObjectiveStore(dbPath);
	const research = new ResearchStore(dbPath);
	const objective = objectives.create({ title: "Slash mission", metricTargets: [], budget: {}, guardrails: {} });
	const brief = research.createBrief({
		objectiveId: objective.id,
		question: "Does /mission read the mission?",
		lanes: ["repo"],
		requiredEvidence: [],
		disallowedEvidence: [],
		riskLevel: "low",
		stopCriteria: [],
	});
	const mission = new MissionStore(dbPath).listMissions({ briefId: brief.id })[0]!;
	research.close();
	objectives.close();
	return { root, mission };
}

describe("/mission slash command registration", () => {
	test("registers the canonical /mission command with the workplan subcommands", () => {
		const spec = lookupBuiltinSlashCommand("mission");
		expect(spec).toBeDefined();
		expect(spec?.handle).toBeDefined();
		const names = (spec?.subcommands ?? []).map(sub => sub.name);
		expect(names).toEqual([
			"create",
			"show",
			"stream",
			"evidence",
			"decision",
			"verify",
			"approve",
			"complete",
			"cancel",
			"rollback",
			"panel",
		]);
		// Subcommand metadata mirrors the shared source of truth.
		expect(names).toEqual(MISSION_SUBCOMMANDS.map(sub => sub.name));
	});

	test("only one canonical mission command exists in the registry", () => {
		const missionSpecs = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(spec => spec.name === "mission");
		expect(missionSpecs).toHaveLength(1);
	});
});

describe("/mission subcommand behavior", () => {
	test("usage text when no verb is given", async () => {
		const result = await runMissionSlashCommand("");
		expect(result.stub).toBe(false);
		expect(result.output).toContain("Usage: /mission");
	});

	test("create without a session reports the session requirement", async () => {
		const result = await runMissionSlashCommand("create build the thing");
		expect(result.stub).toBe(true);
		expect(result.output).toContain("requires a live session");
	});

	test("complete without a session reports the session requirement", async () => {
		const result = await runMissionSlashCommand("complete");
		expect(result.stub).toBe(true);
		expect(result.output).toContain("requires a live session");
	});

	test("cancel without a session reports the session requirement", async () => {
		const result = await runMissionSlashCommand("cancel");
		expect(result.stub).toBe(true);
		expect(result.output).toContain("requires a live session");
	});

	test("read verb without a mission id returns per-verb usage", async () => {
		const result = await runMissionSlashCommand("show");
		expect(result.stub).toBe(false);
		expect(result.output).toBe("Usage: /mission show <missionId>");
	});

	test("show surfaces a not-found error for an unknown mission", async () => {
		const result = await runMissionSlashCommand("show does-not-exist");
		expect(result.stub).toBe(false);
		expect(result.output).toContain("Mission not found");
	});

	test("show wires through to the mission read model for a real mission", async () => {
		const { mission } = createMissionFixture();
		const result = await runMissionSlashCommand(`show ${mission.id}`);
		expect(result.stub).toBe(false);
		expect(result.output).toContain(`Mission: ${mission.id}`);
		expect(result.output).toContain("State:");
	});

	test("verify wires through to the read model for a real mission", async () => {
		const { mission } = createMissionFixture();
		const result = await runMissionSlashCommand(`verify ${mission.id}`);
		expect(result.stub).toBe(false);
		expect(result.output).toContain(`Mission: ${mission.id}`);
		expect(result.output.toLowerCase()).toContain("verification");
	});
});

describe("/mission panel (ACP/text-mode handle)", () => {
	test("panel subcommand is registered with usage hint", () => {
		const sub = MISSION_SUBCOMMANDS.find(s => s.name === "panel");
		expect(sub).toBeDefined();
		expect(sub?.usage).toContain("off");
		expect(sub?.usage).toContain("compact");
		expect(sub?.usage).toContain("expanded");
		expect(sub?.usage).toContain("toggle");
	});

	test("panel without args reports current value via runtime.output", async () => {
		const spec = lookupBuiltinSlashCommand("mission");
		expect(spec?.handle).toBeDefined();
		const settings = Settings.isolated();
		const captured: string[] = [];
		await spec!.handle!({ name: "mission", args: "panel", text: "/mission panel" }, {
			settings,
			output: (text: string) => {
				captured.push(text);
			},
		} as never);
		expect(captured.join("\n")).toMatch(/Mission Control panel: (off|compact|expanded)/);
	});

	test("panel with valid mode persists the setting", async () => {
		const settings = Settings.isolated();
		const spec = lookupBuiltinSlashCommand("mission");
		const captured: string[] = [];
		await spec!.handle!({ name: "mission", args: "panel compact", text: "/mission panel compact" }, {
			settings,
			output: (text: string) => {
				captured.push(text);
			},
		} as never);
		expect(settings.get("mission.terminalPanel")).toBe("compact");
		expect(captured.join("\n")).toContain("compact");
	});

	test("panel toggle cycles off → compact → expanded → off", async () => {
		// Default for `mission.terminalPanel` is `off`; isolated() pulls that default in.
		// We deliberately do NOT pass an override because Settings.isolated overrides
		// always win over `set()`, which would freeze the toggle at "off".
		const settings = Settings.isolated();
		const spec = lookupBuiltinSlashCommand("mission");
		const invoke = async () =>
			spec!.handle!({ name: "mission", args: "panel toggle", text: "/mission panel toggle" }, {
				settings,
				output: () => {},
			} as never);
		await invoke();
		expect(settings.get("mission.terminalPanel")).toBe("compact");
		await invoke();
		expect(settings.get("mission.terminalPanel")).toBe("expanded");
		await invoke();
		expect(settings.get("mission.terminalPanel")).toBe("off");
	});

	test("panel with unknown mode rejects with usage", async () => {
		const settings = Settings.isolated();
		const spec = lookupBuiltinSlashCommand("mission");
		const captured: string[] = [];
		await spec!.handle!({ name: "mission", args: "panel banana", text: "/mission panel banana" }, {
			settings,
			output: (text: string) => {
				captured.push(text);
			},
		} as never);
		expect(captured.join("\n")).toContain("Usage: /mission panel");
	});
});
