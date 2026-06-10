/**
 * Bash command read-only classifier.
 *
 * The mission policy gate treats `bash` as a mutation tool by default — the safe assumption,
 * since a shell can do anything. That gate, combined with `requireProposalBeforeMutation`
 * intents (architecture_change, runtime_refactor, external_side_effect), means every shell
 * call to investigate the running system (`kubectl get`, `git status`, `ls`, etc.) demands a
 * proposal even when the orchestrator is doing strictly read-only work.
 *
 * This classifier exists to opt **specific** commands out of that gate. It is intentionally
 * narrow: an allow-list of verbs and well-known subcommands that are statically guaranteed
 * not to mutate workspace, repo, cluster, or filesystem state. Anything not on the list —
 * including arbitrary `node -e ...`, `python -c ...`, command substitutions, redirections —
 * stays under the mutation gate. False negatives (gated read-only commands) are recoverable
 * by attaching a proposal. False positives (un-gated mutations) would silently bypass the
 * policy, which is why this list is conservative.
 *
 * The classifier returns `true` only when every parsed segment, joined by safe shell
 * connectors (`;`, `&&`, `||`, `|`), passes the read-only check. A single suspicious token
 * (`sudo`, `$()`, `>` redirect, etc.) anywhere in the command makes the whole thing fail.
 */

/** Top-level verbs whose mere invocation is side-effect-free regardless of arguments. */
const READONLY_VERBS = new Set([
	"pwd",
	"whoami",
	"id",
	"hostname",
	"uname",
	"date",
	"echo",
	"printf",
	"which",
	"type",
	"command",
	"env",
	"printenv",
	"ls",
	"ll",
	"la",
	"tree",
	"stat",
	"file",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"diff",
	"cmp",
	"sort",
	"uniq",
	"cut",
	"tr",
	"column",
	"nl",
	"rev",
	"fold",
	"jq",
	"yq",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"df",
	"du",
	"ps",
	"top",
	"htop",
	"free",
	"uptime",
	"lsof",
	"netstat",
	"ss",
	"ping",
	"true",
	"false",
	"test",
	"[",
	"sleep",
]);

/** Verbs that are read-only only when their flag set excludes a known mutating switch. */
const CONDITIONAL_READONLY: Record<string, (rest: readonly string[]) => boolean> = {
	find: rest => !rest.some(t => t === "-delete" || t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir"),
	fd: rest => !rest.some(t => t === "-x" || t === "--exec" || t === "-X" || t === "--exec-batch"),
	sed: rest => !rest.some(t => t === "-i" || t === "--in-place" || /^-i[^=\s]*$/.test(t)),
	awk: rest => !rest.some(t => /system\(|print\s*>/.test(t)),
	xargs: () => false, // xargs can run anything; never auto-allow
	tee: rest => rest.length === 0, // tee with target file writes
	// Version-only invocations of language runtimes are safe; arbitrary code execution is not.
	node: rest => isVersionOnly(rest),
	bun: rest => isVersionOnly(rest) || isBunReadOnlyInvocation(rest),
	python: rest => isVersionOnly(rest),
	python3: rest => isVersionOnly(rest),
	ruby: rest => isVersionOnly(rest),
	go: rest => rest[0] === "version" || rest[0] === "env",
	deno: rest => isVersionOnly(rest),
};

function isVersionOnly(rest: readonly string[]): boolean {
	if (rest.length === 0) return false;
	const first = rest[0];
	return first === "--version" || first === "-v" || first === "-V" || first === "version";
}

/** Allow-listed `bun run <script>` recipe names — verification surfaces the agent is expected
 *  to drive (tests, typecheck, lint). `bun run <anything-else>` stays gated because package.json
 *  scripts can do arbitrary mutation (`bun run release`, `bun run publish`, …). */
const BUN_RUN_READONLY_SCRIPTS: ReadonlySet<string> = new Set([
	"test",
	"test:ts",
	"test:rs",
	"test:ts:failed",
	"check",
	"check:ts",
	"check:tools",
	"check:rs",
	"lint",
	"lint:ts",
	"lint:tools",
	"lint:rs",
	"typecheck",
	"types",
	"types:check",
	"stats",
]);

function isBunReadOnlyInvocation(rest: readonly string[]): boolean {
	if (rest.length === 0) return false;
	// `bun test [paths…]` — canonical test runner.
	if (rest[0] === "test") return true;
	// `bun run <safe-script> [args…]`.
	if (rest[0] === "run" && rest[1] !== undefined && BUN_RUN_READONLY_SCRIPTS.has(rest[1])) return true;
	if (rest[0] === "pm" && rest[1] === "ls") return true;
	return false;
}

/** Subcommand-keyed allow-lists for common multi-verb CLIs. */
const SUBCOMMAND_ALLOWLISTS: Record<string, ReadonlySet<string>> = {
	git: new Set([
		"status",
		"log",
		"diff",
		"show",
		"branch",
		"remote",
		"rev-parse",
		"rev-list",
		"ls-files",
		"ls-tree",
		"ls-remote",
		"config", // `git config --get` is read-only; `--set` would need a value. Conservative: allow only --get* / -l.
		"tag", // `git tag` with no args lists; gate write forms.
		"stash", // `git stash list/show` are read-only; other forms gated below.
		"reflog",
		"blame",
		"shortlog",
		"describe",
		"name-rev",
		"cat-file",
		"grep",
		"worktree",
		"submodule",
		"bisect",
		"version",
	]),
	kubectl: new Set([
		"get",
		"describe",
		"logs",
		"top",
		"explain",
		"api-resources",
		"api-versions",
		"version",
		"cluster-info",
		"config",
		"auth",
		"diff",
		"events",
		"wait",
	]),
	k: new Set([
		"get",
		"describe",
		"logs",
		"top",
		"explain",
		"api-resources",
		"api-versions",
		"version",
		"cluster-info",
		"config",
		"auth",
		"events",
	]),
	helm: new Set(["list", "ls", "status", "get", "history", "search", "show", "version", "env", "repo", "template"]),
	docker: new Set(["ps", "images", "logs", "inspect", "version", "info", "stats", "top", "diff", "history", "port"]),
	terraform: new Set(["version", "show", "plan", "output", "validate", "fmt", "providers", "state", "workspace"]),
	gcloud: new Set(["config", "version", "info", "auth"]),
	az: new Set(["version", "account", "configure"]),
	aws: new Set(["configure", "sts"]), // aws subcommands like `s3 ls` are handled per-CLI elsewhere; keep narrow.
	npm: new Set([
		"list",
		"ls",
		"view",
		"show",
		"info",
		"search",
		"outdated",
		"config",
		"root",
		"ping",
		"version",
		"-v",
	]),
	pnpm: new Set(["list", "ls", "view", "outdated", "store", "root", "config"]),
	yarn: new Set(["list", "info", "config", "why"]),
	cargo: new Set(["tree", "metadata", "check", "search", "owner", "--version"]),
};

/**
 * Subcommands that override the parent allow-list as definitely mutating. Used when a parent
 * CLI's "config" or "stash" verb has both read and write forms — we err on the side of gating.
 * Keys are `"<verb> <subverb>"` joined by a single space.
 */
const KNOWN_MUTATING_PAIRS: ReadonlySet<string> = new Set([
	// git stash forms that mutate
	"git stash push",
	"git stash pop",
	"git stash apply",
	"git stash drop",
	"git stash clear",
	"git stash save",
	"git stash create",
	"git stash store",
	// git remote forms that mutate
	"git remote add",
	"git remote remove",
	"git remote rm",
	"git remote rename",
	"git remote set-url",
	"git remote set-head",
	"git remote prune",
	// git submodule mutating forms
	"git submodule add",
	"git submodule update",
	"git submodule init",
	"git submodule deinit",
	"git submodule sync",
	// git worktree mutating
	"git worktree add",
	"git worktree remove",
	"git worktree prune",
	"git worktree move",
	"git worktree repair",
	// git bisect mutating
	"git bisect start",
	"git bisect bad",
	"git bisect good",
	"git bisect reset",
	"git bisect skip",
	"git bisect run",
	// helm template can render with --kube-apiserver but never mutates; keep allowed.
	// terraform state / workspace mutating forms
	"terraform state mv",
	"terraform state rm",
	"terraform state push",
	"terraform state replace-provider",
	"terraform workspace new",
	"terraform workspace delete",
	"terraform workspace select",
	// npm/pnpm/yarn config write
	"npm config set",
	"npm config delete",
	"pnpm config set",
	"pnpm config delete",
	"yarn config set",
	// kubectl auth login flows can mutate kubeconfig; gate them explicitly.
	"kubectl config set-context",
	"kubectl config set-cluster",
	"kubectl config set-credentials",
	"kubectl config delete-context",
	"kubectl config delete-cluster",
	"kubectl config delete-user",
	"kubectl config use-context",
	"kubectl config rename-context",
]);

/** Strip simple single/double-quoted strings so their contents do not trip downstream regex. */
function stripStrings(input: string): string {
	let result = "";
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === "'" || ch === '"') {
			const quote = ch;
			i++;
			while (i < input.length && input[i] !== quote) {
				if (input[i] === "\\" && i + 1 < input.length) i += 2;
				else i++;
			}
			i++; // skip closing quote (or EOF)
			result += " "; // keep length-ish parity; content erased
			continue;
		}
		result += ch;
		i++;
	}
	return result;
}

/** Split a command on top-level segment connectors (`;`, `&&`, `||`, `|`), ignoring those
 *  inside quoted strings or grouping parens. Used only for the read-only classifier, so a
 *  best-effort split is sufficient — anything tricky enough to defeat this falls through to
 *  the global mutation-feature reject path. */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let buf = "";
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let parenDepth = 0;
	while (i < command.length) {
		const ch = command[i];
		if (inSingle) {
			buf += ch;
			if (ch === "'") inSingle = false;
			i++;
			continue;
		}
		if (inDouble) {
			buf += ch;
			if (ch === '"' && command[i - 1] !== "\\") inDouble = false;
			i++;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			buf += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			buf += ch;
			i++;
			continue;
		}
		if (ch === "(") {
			parenDepth++;
			buf += ch;
			i++;
			continue;
		}
		if (ch === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
			buf += ch;
			i++;
			continue;
		}
		if (parenDepth === 0) {
			if (ch === ";") {
				segments.push(buf);
				buf = "";
				i++;
				continue;
			}
			if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
				segments.push(buf);
				buf = "";
				i += 2;
				continue;
			}
			if (ch === "|") {
				segments.push(buf);
				buf = "";
				i++;
				continue;
			}
		}
		buf += ch;
		i++;
	}
	if (buf.trim()) segments.push(buf);
	return segments;
}

/** Tokenize a single segment by whitespace, respecting quote boundaries. */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else buf += ch;
			continue;
		}
		if (inDouble) {
			if (ch === '"' && segment[i - 1] !== "\\") inDouble = false;
			else buf += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (buf) tokens.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf) tokens.push(buf);
	return tokens;
}

/** Skip leading flag tokens (`-x`, `--long`, `--long=val`, `-x value` for known value-taking
 *  short flags) to find the first positional argument. Used to locate the *real* subcommand
 *  when the user front-loads global flags like `kubectl -n monitoring get pods`. */
function firstPositional(tokens: readonly string[]): number {
	const KUBECTL_VALUE_FLAGS = new Set(["-n", "-l", "-o", "-c", "-f", "-A"]); // common value-taking short flags
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i];
		if (!t.startsWith("-")) return i;
		if (t.startsWith("--")) {
			// `--long` or `--long=value`: single-token flag, advance one
			i++;
			continue;
		}
		// Short flag: `-x` may or may not consume the next token. Be permissive: if the next
		// token is also a flag or there is no next token, treat as standalone; else consume one.
		if (KUBECTL_VALUE_FLAGS.has(t) && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
			i += 2;
			continue;
		}
		i++;
	}
	return tokens.length;
}

function isReadOnlySegment(segment: string): boolean {
	const trimmed = segment.trim();
	if (!trimmed) return true;

	const tokens = tokenize(trimmed);
	if (tokens.length === 0) return true;

	// Skip leading inline env assignments (`KEY=value cmd ...`).
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	if (i >= tokens.length) return true; // pure env assignment, no command — no-op

	const cmd = tokens[i];
	const rest = tokens.slice(i + 1);

	if (READONLY_VERBS.has(cmd)) return true;

	if (cmd in CONDITIONAL_READONLY) {
		return CONDITIONAL_READONLY[cmd](rest);
	}

	if (cmd in SUBCOMMAND_ALLOWLISTS) {
		// Skip global flags like `kubectl -n ns get pods` to find the real subcommand.
		const subIdx = firstPositional(rest);
		const sub = rest[subIdx];
		if (!sub) return cmd === "git" || cmd === "helm" || cmd === "docker"; // bare invocation prints help
		// Three-token mutating pairs first (`kubectl config set-context`, `git stash push`,
		// `terraform state rm`, …) — these live under an otherwise allow-listed sub.
		const subRest = rest.slice(subIdx + 1);
		const subSubIdx = firstPositional(subRest);
		const subSub = subRest[subSubIdx];
		if (subSub) {
			const triple = `${cmd} ${sub} ${subSub}`;
			if (KNOWN_MUTATING_PAIRS.has(triple)) return false;
		}
		const pair = `${cmd} ${sub}`;
		if (KNOWN_MUTATING_PAIRS.has(pair)) return false;
		return SUBCOMMAND_ALLOWLISTS[cmd].has(sub);
	}

	return false;
}

/**
 * Top-level classifier. Returns `true` only when the command is statically read-only.
 *
 * Hard rejects (regardless of segment content):
 *   - Output redirects (`>`, `>>`, `<<<`, process substitutions `>(...)`) — can write files.
 *   - Command substitutions (`$(...)`, backticks) — can execute arbitrary code.
 *   - Privilege escalation (`sudo`, `doas`, `su`).
 *   - Shell builtins that can rewire execution: `eval`, `source`, leading `.` (dot-source),
 *     `exec` (replaces shell), `trap`.
 *
 * Then each segment (`;`/`&&`/`||`/`|`-separated) must individually be read-only.
 */
export function isReadOnlyBashCommand(command: string): boolean {
	if (typeof command !== "string") return false;
	const trimmed = command.trim();
	if (!trimmed) return true;

	const stripped = stripStrings(trimmed);

	// Reject any redirection: stdout/stderr/append/process substitution.
	if (/(^|[^0-9&])>{1,2}|<<<|<\(|>\(/.test(stripped)) return false;

	// Reject command substitution forms.
	if (/\$\(|`/.test(stripped)) return false;

	// Reject privilege escalation and arbitrary-code shell builtins.
	if (/(^|\s)(sudo|doas|su|eval|source|exec|trap)(\s|$)/.test(stripped)) return false;
	if (/(^|\s|;|&&|\|\|)\.\s/.test(stripped)) return false;

	const segments = splitSegments(trimmed);
	if (segments.length === 0) return true;
	return segments.every(isReadOnlySegment);
}
