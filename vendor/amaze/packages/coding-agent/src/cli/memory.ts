import { Settings } from "../config/settings";
export interface MemoryCommandArgs {
	action: "doctor";
}

export interface MemoryDoctorReport {
	status: "ok" | "degraded";
	backend: "removed";
	text: string;
}

const REMOVED_MEMORY_BACKEND_MESSAGE = [
	"Memory backend: removed",
	"- Legacy local memory backends (Hermes/mem0) have been removed.",
	"- Supported memory: GBrain Agency Brain via MCP.",
].join("\n");

export async function runMemoryCommand(args: MemoryCommandArgs): Promise<void> {
	await Settings.init();
	if (args.action === "doctor") {
		await runMemoryDoctorCommand();
		return;
	}
	throw new Error(`Unknown memory action: ${String(args.action)}`);
}

export async function getMemoryDoctorReport(_settings?: Settings): Promise<MemoryDoctorReport> {
	return {
		status: "ok",
		backend: "removed",
		text: REMOVED_MEMORY_BACKEND_MESSAGE,
	};
}

function safeSettings(): Settings {
	try {
		return Settings.instance;
	} catch {
		return Settings.isolated({});
	}
}

export async function runMemoryDoctorCommand(settings: Settings = safeSettings()): Promise<void> {
	process.stdout.write(`${(await getMemoryDoctorReport(settings)).text}\n`);
}
