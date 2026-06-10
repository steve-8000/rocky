import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ObjectiveStore } from "../../src/autonomy/store";
import {
	runMissionEvidenceCommand,
	runMissionRollbackCommand,
	runMissionShowCommand,
	runMissionVerifyCommand,
	streamMissionEvents,
} from "../../src/cli/mission";
import { MissionEventBus } from "../../src/mission/event-bus";
import { MissionJsonlSink } from "../../src/mission/jsonl-sink";
import { MissionStore } from "../../src/mission/store";
import { ResearchStore } from "../../src/research/store";

const repoRoot = path.resolve(import.meta.dir, "../..");
const cliEntry = path.join(repoRoot, "src/cli.ts");
const roots: string[] = [];

const originalHome = process.env.HOME;

afterEach(() => {
	process.env.HOME = originalHome;
	for (const root of roots.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-cli-"));
	roots.push(root);
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	process.env.HOME = home;
	const dbPath = path.join(root, "autonomy.db");
	const eventsDir = path.join(home, ".amaze", "observability", "missions");
	const bus = new MissionEventBus();
	const sink = new MissionJsonlSink(bus, { baseDir: eventsDir, batchSize: 1, flushIntervalMs: 10_000 });
	const objectives = new ObjectiveStore(dbPath);
	const research = new ResearchStore(dbPath, bus);
	const objective = objectives.create({
		title: "Improve mission control",
		metricTargets: [],
		budget: {},
		guardrails: {},
	});
	const brief = research.createBrief({
		objectiveId: objective.id,
		question: "Should we ship mission control?",
		lanes: ["repo", "source"],
		requiredEvidence: [],
		disallowedEvidence: [],
		riskLevel: "medium",
		stopCriteria: [],
	});
	const mission = new MissionStore(dbPath).listMissions({ briefId: brief.id })[0];
	return { root, home, dbPath, eventsDir, bus, sink, objectives, research, objective, brief, mission };
}

async function closeFixture(fixture: Fixture): Promise<void> {
	fixture.research.close();
	fixture.objectives.close();
	await fixture.sink.close();
}

async function runCli(root: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const home = path.join(root, "home");
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: repoRoot,
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	let stdout = "";
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return stdout;
}

function addEvidenceAndDecision(fixture: Fixture) {
	const evidence = fixture.research.addEvidence({
		briefId: fixture.brief.id,
		lane: "repo",
		grade: "A",
		sourceRef: "src/file.ts:1",
		excerpt: "Strong evidence",
		claims: ["mission cli is ready"],
		directness: 1,
		specificity: 1,
		recency: 1,
		reproducibility: 1,
	});
	const decision = fixture.research.recordDecision({
		briefId: fixture.brief.id,
		hypothesis: "Ship Mission Control CLI",
		rationale: "The read model exposes the operator surfaces.",
		confidence: "high",
		evidenceRefs: [evidence.id],
		rejectedOptions: [],
		nextActions: ["watch verify surface"],
	});
	return { evidence, decision };
}

describe("mission CLI", () => {
	test("mission list --json returns mission rows", async () => {
		const fixture = await createFixture();
		try {
			const result = await runCli(fixture.root, ["mission", "list", "--db", fixture.dbPath, "--json"]);
			if (result.exitCode !== 0) throw new Error(`mission list failed: ${result.stderr}\n${result.stdout}`);
			const rows = JSON.parse(result.stdout);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ id: fixture.mission.id, briefId: fixture.brief.id, state: "researching" });
		} finally {
			await closeFixture(fixture);
		}
	});

	test("mission show text includes header, lanes, and decision summary", async () => {
		const fixture = await createFixture();
		try {
			const { decision } = addEvidenceAndDecision(fixture);
			const missions = new MissionStore(fixture.dbPath);
			try {
				missions.createLaneRun({
					missionId: fixture.mission.id,
					lane: "repo",
					agent: "Explore",
					epistemicRole: "repo_truth",
					status: "completed",
					evidenceCount: 1,
					emptyReason: null,
					taskId: "task-1",
					startedAt: 1,
					endedAt: 2,
				});
			} finally {
				missions.close();
			}
			const stdout = await captureStdout(() =>
				runMissionShowCommand({ db: fixture.dbPath, id: fixture.mission.id }),
			);
			expect(stdout).toContain(`Mission: ${fixture.mission.id}`);
			expect(stdout).toContain("Lanes:");
			expect(stdout).toContain("repo_truth");
			expect(stdout).toContain("Decision summary:");
			expect(stdout).toContain(decision.id);
			expect(stdout).toContain("Proposals:");
			expect(stdout).toContain("Contracts: 0");
			expect(stdout).toContain("Verification: not yet recorded");
			expect(stdout).toContain("Rollbacks: 0");
			expect(stdout).toContain("Runtime critic: blocked checks=1 dialogue=0");
		} finally {
			await closeFixture(fixture);
		}
	});

	test("mission evidence filters and annotates classifications", async () => {
		const fixture = await createFixture();
		try {
			const accepted = fixture.research.addEvidence({
				briefId: fixture.brief.id,
				lane: "repo",
				grade: "A",
				sourceRef: "src/mission.ts:1",
				excerpt: "Accepted evidence",
				claims: ["mission evidence accepted"],
				directness: 1,
				specificity: 1,
				recency: 1,
				reproducibility: 1,
			});
			const speculative = fixture.research.addEvidence({
				briefId: fixture.brief.id,
				lane: "source",
				grade: "B",
				sourceRef: "docs/agi.md:1",
				excerpt: "Speculative exploratory note",
				claims: ["mission evidence exploratory"],
				directness: 1,
				specificity: 1,
				recency: 1,
				reproducibility: 1,
			});
			const conflicting = fixture.research.addEvidence({
				briefId: fixture.brief.id,
				lane: "repo",
				grade: "C",
				sourceRef: "src/conflict.ts:1",
				excerpt: "Conflict evidence",
				claims: ["mission toggle exists and is implemented"],
				directness: 1,
				specificity: 1,
				recency: 1,
				reproducibility: 1,
			});
			fixture.research.addEvidence({
				briefId: fixture.brief.id,
				lane: "source",
				grade: "C",
				sourceRef: "docs/conflict.md:1",
				excerpt: "Conflict evidence",
				claims: ["mission toggle missing and not implemented"],
				directness: 1,
				specificity: 1,
				recency: 1,
				reproducibility: 1,
			});

			const speculativeStdout = await captureStdout(() =>
				runMissionEvidenceCommand({ db: fixture.dbPath, id: fixture.mission.id, status: "speculative" }),
			);
			expect(speculativeStdout).toContain(`${speculative.id} [speculative]`);
			expect(speculativeStdout).not.toContain(accepted.id);

			const conflictingJson = await captureStdout(() =>
				runMissionEvidenceCommand({
					db: fixture.dbPath,
					id: fixture.mission.id,
					json: true,
					status: "conflicting",
				}),
			);
			const payload = JSON.parse(conflictingJson);
			expect(payload.evidence.map((card: { id: string }) => card.id)).toContain(conflicting.id);

			const queryStdout = await captureStdout(() =>
				runMissionEvidenceCommand({
					db: fixture.dbPath,
					id: fixture.mission.id,
					lane: "repo",
					grade: "A",
					query: "accepted",
				}),
			);
			expect(queryStdout).toContain(accepted.id);
			expect(queryStdout).not.toContain(speculative.id);
		} finally {
			await closeFixture(fixture);
		}
	});

	test("mission evidence --json includes evidenceByLane counts and evidence cards", async () => {
		const fixture = await createFixture();
		try {
			const { evidence } = addEvidenceAndDecision(fixture);
			const stdout = await captureStdout(() =>
				runMissionEvidenceCommand({ db: fixture.dbPath, id: fixture.mission.id, json: true }),
			);
			const payload = JSON.parse(stdout);
			expect(payload.evidenceByLane).toContainEqual({ lane: "repo", count: 1 });
			expect(payload.evidenceByLane).toContainEqual({ lane: "source", count: 0 });
			expect(payload.evidence[0]).toMatchObject({ id: evidence.id, grade: "A", sourceRef: "src/file.ts:1" });
		} finally {
			await closeFixture(fixture);
		}
	});

	test("mission stream --json returns mission events after createBrief/addEvidence/recordDecision", async () => {
		const fixture = await createFixture();
		try {
			addEvidenceAndDecision(fixture);
			await fixture.sink.flush();
			const result = await runCli(fixture.root, [
				"mission",
				"stream",
				fixture.mission.id,
				"--db",
				fixture.dbPath,
				"--json",
			]);
			if (result.exitCode !== 0) throw new Error(`mission stream failed: ${result.stderr}\n${result.stdout}`);
			expect(result.stderr).toBe("");
			const events = JSON.parse(result.stdout);
			expect(events.map((event: { type: string }) => event.type)).toEqual([
				"research.brief.created",
				"research.evidence.added",
				"decision.recorded",
			]);
		} finally {
			await closeFixture(fixture);
		}
	});

	test("mission stream --follow polls and emits newly appended JSONL events", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-stream-follow-"));
		roots.push(root);
		const eventsDir = path.join(root, "events");
		const missionId = "mission-follow-1";
		const stdoutPromise = captureStdout(() =>
			streamMissionEvents(missionId, {
				baseDir: eventsDir,
				json: true,
				pollIntervalMs: 5,
				idleTimeoutMs: 500,
				once: true,
			}),
		);
		await Bun.sleep(20);
		fs.mkdirSync(eventsDir, { recursive: true });
		fs.appendFileSync(
			path.join(eventsDir, `${missionId}.jsonl`),
			`${JSON.stringify({ type: "research.evidence.added", missionId, briefId: "brief-1", evidenceId: "ev-1", lane: "repo", grade: "A", ts: 1 })}\n`,
		);
		const stdout = await stdoutPromise;
		const lines = stdout
			.trim()
			.split("\\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { type: string });
		expect(lines.some(event => event.type === "research.evidence.added")).toBe(true);
	});

	test("mission stream text summarizes mission lifecycle events", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-stream-text-"));
		roots.push(root);
		const eventsDir = path.join(root, "events");
		const missionId = "mission-stream-text-1";
		fs.mkdirSync(eventsDir, { recursive: true });
		fs.appendFileSync(
			path.join(eventsDir, `${missionId}.jsonl`),
			`${[
				{ type: "contract.created", missionId, contractId: "contract-1", role: "worker", ts: 1 },
				{
					type: "verification.completed",
					missionId,
					verificationId: "verify-1",
					status: "fail",
					failedCount: 1,
					uncertainCount: 2,
					ts: 2,
				},
				{
					type: "rollback.snapshot.created",
					missionId,
					rollbackId: "rollback-1",
					targetType: "decision",
					targetId: "decision-1",
					snapshotRef: "snapshot-1",
					ts: 3,
				},
				{
					type: "research.synthesis.proposed",
					missionId,
					briefId: "brief-1",
					hypothesisCount: 2,
					recommended: "H1",
					ts: 4,
				},
				{
					type: "research.critique.completed",
					missionId,
					briefId: "brief-1",
					blockingCount: 1,
					softCount: 3,
					verdict: "needs-more-research",
					ts: 5,
				},
			]
				.map(event => JSON.stringify(event))
				.join("\n")}\n`,
		);

		const stdout = await captureStdout(() =>
			streamMissionEvents(missionId, { baseDir: eventsDir, pollIntervalMs: 5, idleTimeoutMs: 20, once: true }),
		);

		expect(stdout).toContain("contract=contract-1 role=worker");
		expect(stdout).toContain("verification=verify-1 status=fail failed=1 uncertain=2");
		expect(stdout).toContain("rollback=rollback-1 target=decision:decision-1 snapshot=snapshot-1");
		expect(stdout).toContain("brief=brief-1 hypotheses=2 recommended=H1");
		expect(stdout).toContain("brief=brief-1 verdict=needs-more-research blocking=1 soft=3");
	});

	test("mission verify surfaces non-decision mission events in related events", async () => {
		const fixture = await createFixture();
		try {
			addEvidenceAndDecision(fixture);
			await fixture.sink.flush();
			const stdout = await captureStdout(() =>
				runMissionVerifyCommand({ db: fixture.dbPath, id: fixture.mission.id }),
			);
			expect(stdout).toContain("Related mission events:");
			expect(stdout).toContain("research.brief.created");
			expect(stdout).toContain("research.evidence.added");
			expect(stdout).toContain("decision.recorded");
		} finally {
			await closeFixture(fixture);
		}
	});

	test("mission verify --events reports replay consistency in text and json", async () => {
		const fixture = await createFixture();
		try {
			addEvidenceAndDecision(fixture);
			const missions = new MissionStore(fixture.dbPath, fixture.bus);
			try {
				missions.recordContract({
					missionId: fixture.mission.id,
					role: "worker",
					parentMissionRev: 1,
					include: ["src/**"],
					exclude: [],
					successCriteria: ["tests"],
					escalation: { onUncertainty: "ask-parent", budgetCap: 100 },
					inputArtifact: null,
					mustProduce: ["notes"],
					createdAt: Date.now() + 1,
				});
				missions.recordVerification({
					missionId: fixture.mission.id,
					status: "pass",
					failedCount: 0,
					uncertainCount: 0,
					summary: "verified",
					createdAt: Date.now() + 2,
				});
				missions.recordRollback({
					id: "rollback-replay-1",
					missionId: fixture.mission.id,
					targetType: "decision",
					targetId: "decision-1",
					snapshotRef: "snapshot-replay-1",
					summary: "snapshot ready",
					createdAt: Date.now() + 3,
				});
			} finally {
				missions.close();
			}
			await fixture.sink.flush();

			const text = await captureStdout(() =>
				runMissionVerifyCommand({ db: fixture.dbPath, id: fixture.mission.id, events: fixture.eventsDir }),
			);
			expect(text).toContain("Event replay:");
			expect(text).toContain("status: consistent");
			expect(text).toContain("decision: db=true events=true ok");
			expect(text).toContain("contracts: db=1 events=1 ok");
			expect(text).toContain("verification: db=true events=true ok");
			expect(text).toContain("rollbacks: db=1 events=1 ok");

			const json = await captureStdout(() =>
				runMissionVerifyCommand({
					db: fixture.dbPath,
					id: fixture.mission.id,
					events: fixture.eventsDir,
					json: true,
				}),
			);
			const payload = JSON.parse(json);
			expect(payload.replay).toMatchObject({
				ok: true,
				db: { decision: true, contracts: 1, verification: true, rollbacks: 1 },
				events: { decision: true, contracts: 1, verification: true, rollbacks: 1 },
				matches: { decision: true, contracts: true, verification: true, rollbacks: true },
			});
			expect(payload.runtimeCritic).toMatchObject({ status: "blocked" });
			expect(payload.runtimeCritic.checks).toHaveLength(1);
		} finally {
			await closeFixture(fixture);
		}
	});

	test("mission rollback text says unavailable when snapshotRef is null", async () => {
		const fixture = await createFixture();
		try {
			addEvidenceAndDecision(fixture);
			const stdout = await captureStdout(() =>
				runMissionRollbackCommand({ db: fixture.dbPath, id: fixture.mission.id }),
			);
			expect(stdout).toContain("rollback: unavailable");
			expect(stdout).toContain("Snapshot: <none>");
		} finally {
			await closeFixture(fixture);
		}
	});

	test("mission verify and rollback text reflect stored records", async () => {
		const fixture = await createFixture();
		try {
			const missions = new MissionStore(fixture.dbPath, fixture.bus);
			try {
				missions.recordVerification({
					missionId: fixture.mission.id,
					status: "uncertain",
					failedCount: 1,
					uncertainCount: 2,
					summary: "manual review required",
					createdAt: 10,
				});
				missions.recordRollback({
					id: "rollback-cli-1",
					missionId: fixture.mission.id,
					targetType: "decision",
					targetId: "decision-1",
					snapshotRef: "snapshot-cli-1",
					summary: "restore decision",
					createdAt: 20,
				});
			} finally {
				missions.close();
			}
			await fixture.sink.flush();

			const verifyStdout = await captureStdout(() =>
				runMissionVerifyCommand({ db: fixture.dbPath, id: fixture.mission.id }),
			);
			expect(verifyStdout).toContain("verification: uncertain failed=1 uncertain=2 manual review required");
			expect(verifyStdout).toContain("Related mission events:");
			expect(verifyStdout).toContain("verification.completed");
			expect(verifyStdout).toContain("rollback.snapshot.created");

			const rollbackStdout = await captureStdout(() =>
				runMissionRollbackCommand({ db: fixture.dbPath, id: fixture.mission.id }),
			);
			expect(rollbackStdout).toContain("Recorded rollbacks:");
			expect(rollbackStdout).toContain(
				"rollback-cli-1  decision:decision-1  snapshot=snapshot-cli-1  restore decision",
			);
			expect(rollbackStdout).toContain("Snapshot: <none>");
		} finally {
			await closeFixture(fixture);
		}
	});

	test("root cli.ts command registration contains mission", async () => {
		const source = fs.readFileSync(cliEntry, "utf8");
		expect(source).toContain('{ name: "mission"');
	});
});
