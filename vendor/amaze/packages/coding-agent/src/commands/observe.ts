/**
 * Inspect observability event streams.
 */

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { Args, Command, Flags } from "@amaze/utils/cli";
import { EventBus, type SessionEvent } from "../observability";

const ACTIONS = ["tail", "export"] as const;
type ObserveAction = (typeof ACTIONS)[number];

export default class Observe extends Command {
	static description = "Inspect observability events";

	static args = {
		action: Args.string({ description: "Observe action", required: true, options: [...ACTIONS] }),
	};

	static flags = {
		filter: Flags.string({ description: "Only include events with this type" }),
		session: Flags.string({ description: "Session id to export" }),
		since: Flags.string({ description: "Only include events at or after this timestamp" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Observe);
		const action = args.action as ObserveAction;

		if (action === "tail") {
			runObserveTailCommand({ filter: flags.filter });
			return;
		}

		await runObserveExportCommand({
			session: flags.session ?? "",
			filter: flags.filter,
			since: parseOptionalNumber(flags.since, "--since"),
		});
	}
}

function parseOptionalNumber(value: string | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
	return parsed;
}

interface ObserveTailArgs {
	filter?: string;
}

interface ObserveExportArgs {
	session: string;
	since?: number;
	filter?: string;
	baseDir?: string;
}

function runObserveTailCommand(args: ObserveTailArgs = {}): void {
	const bus = new EventBus();
	bus.subscribe(event => {
		if (matchesFilter(event, args.filter)) {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		}
	});
}

async function runObserveExportCommand(args: ObserveExportArgs): Promise<void> {
	if (!args.session) {
		throw new Error("observe export requires --session <id>");
	}

	const filePath = path.join(observabilityBaseDir(args.baseDir), "sessions", `${args.session}.jsonl`);
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return;
		throw error;
	}

	for (const line of text.split(/\r?\n/)) {
		if (line.length === 0) continue;
		const event = JSON.parse(line) as SessionEvent;
		if (args.since !== undefined && event.ts < args.since) continue;
		if (!matchesFilter(event, args.filter)) continue;
		process.stdout.write(`${line}\n`);
	}
}

function observabilityBaseDir(baseDir?: string): string {
	return (
		baseDir ??
		process.env.AMAZE_OBSERVABILITY_DIR ??
		path.join(process.env.HOME || homedir(), ".amaze", "observability")
	);
}

function matchesFilter(event: SessionEvent, filter?: string): boolean {
	return !filter || event.type === filter;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
