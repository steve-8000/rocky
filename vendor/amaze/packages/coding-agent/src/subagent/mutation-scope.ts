import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSession } from "../tools";
import { enforceContractScope, enforceMissionScope } from "./contract";

export type MutationTarget = {
	raw: string;
	absolutePath: string;
	relativeToCwd: string;
	scheme?: string;
};

export type MutationOperation = "create" | "update" | "delete" | "rename-source" | "rename-destination";

export interface MutationScopeOptions {
	op: MutationOperation;
	source: string;
}

type ScopeErrorThrower = (message: string) => never;

const SCHEME_RE = /^(?<scheme>[a-z][a-z0-9+.-]*):\/\//i;
const CONFLICT_URI_RE = /^(?:(.+):)?conflict:\/\/(.+)$/;

function extractScheme(rawPath: string): string | undefined {
	return rawPath.match(SCHEME_RE)?.groups?.scheme.toLowerCase();
}

function conflictIdFromRaw(rawPath: string): number | "*" | undefined {
	const match = rawPath.match(CONFLICT_URI_RE);
	if (!match) return undefined;
	const tail = match[2] ?? "";
	const idPart = tail.split("/", 1)[0];
	if (idPart === "*") return "*";
	if (!/^\d+$/.test(idPart)) return undefined;
	const id = Number.parseInt(idPart, 10);
	return Number.isFinite(id) && id >= 1 ? id : undefined;
}

export function resolveMutationBackingPath(session: ToolSession, rawPath: string): string {
	const scheme = extractScheme(rawPath);
	if (scheme !== "conflict") return rawPath;

	const conflictId = conflictIdFromRaw(rawPath);
	if (typeof conflictId === "number") {
		const entry = session.conflictHistory?.get(conflictId);
		return entry?.absolutePath ?? rawPath;
	}

	return rawPath;
}

async function realpathIfPossible(absolutePath: string): Promise<string> {
	try {
		return await fs.realpath(absolutePath);
	} catch {
		return absolutePath;
	}
}

export async function resolveMutationTarget(cwd: string, rawPath: string): Promise<MutationTarget> {
	const scheme = extractScheme(rawPath);
	const realCwd = await realpathIfPossible(cwd);
	const absolutePath = await realpathIfPossible(path.resolve(realCwd, rawPath));
	const relativeToCwd = path.relative(realCwd, absolutePath).replace(/\\/g, "/");

	return {
		raw: rawPath,
		absolutePath,
		relativeToCwd: relativeToCwd.length === 0 ? "." : relativeToCwd,
		...(scheme ? { scheme } : {}),
	};
}

function isInsideCwd(cwd: string, absolutePath: string): boolean {
	const relative = path.relative(cwd, absolutePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function throwScopeError(message: string): never {
	throw new Error(message);
}

export async function enforceMutationScope(
	session: ToolSession,
	rawPath: string,
	opts: MutationScopeOptions,
	throwError: ScopeErrorThrower = throwScopeError,
): Promise<void> {
	const realCwd = await realpathIfPossible(session.cwd);
	const backingPath = resolveMutationBackingPath(session, rawPath);
	const target = await resolveMutationTarget(realCwd, backingPath);

	if (!isInsideCwd(realCwd, target.absolutePath)) {
		throwError(
			`Mutation scope violation: ${opts.source} ${opts.op} target "${rawPath}" resolves outside cwd (${target.absolutePath}).`,
		);
	}

	// Single enforcement precedence — contract > mission. Exactly one layer decides
	// each mutation: SubagentContract is most specific; otherwise the active Mission
	// scope is canonical when declared.
	const contract = session.getSubagentContract?.();
	enforceContractScope(contract, target.relativeToCwd, throwError);
	if (!contract) {
		const missionScope = session.getActiveMissionScope?.();
		if (missionScope) enforceMissionScope(missionScope, target.relativeToCwd, throwError);
	}
}
