/**
 * Regression: plugin extensions must resolve `pi-*` imports across every scope
 * that has ever been used to publish or alias the internal packages —
 * `@mariozechner` (original), `@earendil-works` (fork), and `@amaze`
 * (canonical). The shim in `legacy-pi-compat.ts` remaps all three to the same
 * in-process bundled copy so that plugins observe a single module registry
 * regardless of which scope name their peerDependencies happened to declare.
 *
 * Reported failures the test covers:
 *   - `@juicesharp/rpiv-ask-user-question` ⇒ `@earendil-works/tui`
 *   - `@amaze/swarm-extension`         ⇒ `@amaze/utils`
 *   - `@plannotator/amaze-extension`         ⇒ `@amaze/agent-core`
 *   - `@runfusion/fusion`                 ⇒ `@amaze/coding-agent/...`
 *
 * Plus the two upstream-only surfaces that turned up via real-plugin E2E:
 *   - `Key` runtime helper from `tui` (used by plannotator + rpiv-*).
 *   - `ai/oauth` subpath (used by runfusion's bundled extension).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@amaze/coding-agent/extensibility/extensions/loader";
import { TempDir } from "@amaze/utils";

const canonicalCodingAgent = Bun.resolveSync("@amaze/coding-agent", import.meta.dir);
const canonicalCodingAgentExtensions = Bun.resolveSync("@amaze/coding-agent/extensibility/extensions", import.meta.dir);
const canonicalUtils = Bun.resolveSync("@amaze/utils", import.meta.dir);
const canonicalTui = Bun.resolveSync("@amaze/tui", import.meta.dir);
// Subpath remap: upstream `ai/oauth` re-exported `utils/oauth/index`; the
// shim rewrites the legacy subpath onto its current home so plugins keep
// importing the upstream layout.
const canonicalAiOauth = Bun.resolveSync("@amaze/ai/utils/oauth", import.meta.dir);

interface AliasCase {
	id: string;
	aliasSpecifier: string;
	canonicalPath: string;
	symbol: string;
}

const CASES: readonly AliasCase[] = [
	// @earendil-works fork — used by @juicesharp/rpiv-* plugins.
	{
		id: "earendil-tui",
		aliasSpecifier: "@earendil-works/tui",
		canonicalPath: canonicalTui,
		symbol: "visibleWidth",
	},
	// @amaze self-import — canonical scope must still flow through the shim
	// so a duplicate copy is never dragged in from a plugin's own node_modules.
	{ id: "ohmypi-utils", aliasSpecifier: "@amaze/utils", canonicalPath: canonicalUtils, symbol: "logger" },
	{
		id: "ohmypi-coding-agent",
		aliasSpecifier: "@amaze/coding-agent",
		canonicalPath: canonicalCodingAgent,
		symbol: "isToolCallEventType",
	},
	// @mariozechner — defends the original remap (regression: issue #973).
	{
		id: "mariozechner-extensions",
		aliasSpecifier: "@mariozechner/coding-agent/extensibility/extensions",
		canonicalPath: canonicalCodingAgentExtensions,
		symbol: "isToolCallEventType",
	},
	// Subpath remap: legacy `ai/oauth` should resolve to `ai/utils/oauth`.
	{
		id: "mariozechner-ai-oauth",
		aliasSpecifier: "@mariozechner/ai/oauth",
		canonicalPath: canonicalAiOauth,
		// `refreshOAuthToken` is exported by our `utils/oauth/index` and by
		// upstream's `oauth.d.ts`; it makes a stable probe across both layouts.
		symbol: "refreshOAuthToken",
	},
	// `Key` runtime helper restored on tui (plannotator + rpiv-* import it).
	{
		id: "earendil-tui-key",
		aliasSpecifier: "@earendil-works/tui",
		canonicalPath: canonicalTui,
		symbol: "Key",
	},
];

describe("pi-* scope aliases", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@pi-scope-aliases-");
		const pluginDir = path.join(projectDir.path(), "alias-probe-plugin");
		extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "alias-probe-plugin",
				version: "1.0.0",
				pi: { extensions: ["./dist/extension.ts"] },
			}),
		);

		// Each case imports the same symbol via the aliased scope and via the
		// resolved canonical absolute path. The default factory throws unless the
		// two are object-identical, proving they came from a single module
		// instance.
		const lines: string[] = [];
		const checks: string[] = [];
		for (const [idx, c] of CASES.entries()) {
			lines.push(`import { ${c.symbol} as alias${idx} } from "${c.aliasSpecifier}";`);
			lines.push(`import { ${c.symbol} as canonical${idx} } from ${JSON.stringify(c.canonicalPath)};`);
			checks.push(
				`if (alias${idx} !== canonical${idx}) throw new Error(${JSON.stringify(
					`${c.aliasSpecifier} did not remap to the bundled copy (case ${c.id})`,
				)});`,
			);
		}

		fs.writeFileSync(
			extensionPath,
			[...lines, "", ...checks, "", "export default function(pi) {", "\t/* no-op */", "}"].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("remaps every aliased pi-* scope and known upstream subpath to the bundled in-process copy", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());
		expect(result.errors).toEqual([]);
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		expect(extension).toBeDefined();
	});
});
