/**
 * Infrastructure / deployment command classifier.
 *
 * Identifies shell commands that mutate live infrastructure (Kubernetes, Helm,
 * Terraform, cloud provider CLIs, GitOps controllers, container registries).
 * These MUST always require explicit user approval before execution — they are
 * never auto-approved, regardless of `mission.autoApprove` or a prior
 * `allow_always` permission decision.
 *
 * Read-only infra inspection (`kubectl get`, `helm list`, `terraform plan`,
 * `aws ... describe`) is NOT flagged — only state-changing operations are.
 *
 * The classifier is conservative-by-construction for the verbs it knows, but a
 * shell can express infinite variations; callers combine it with the broader
 * bash safety policy. When in doubt for a known infra CLI, it flags.
 */

export interface InfraCommandMatch {
	/** The infra CLI that triggered the match (e.g. "kubectl", "terraform"). */
	tool: string;
	/** The mutating subcommand/verb detected (e.g. "apply", "destroy"). */
	operation: string;
	/** The offending segment, for the approval prompt / error message. */
	segment: string;
}

/**
 * Per-CLI mutating-subcommand sets. A command matches when its first positional
 * subcommand is in the CLI's mutating set. Anything else (incl. read-only verbs)
 * does not match.
 */
const MUTATING_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
	kubectl: new Set([
		"apply",
		"create",
		"delete",
		"edit",
		"patch",
		"replace",
		"scale",
		"autoscale",
		"rollout",
		"set",
		"label",
		"annotate",
		"taint",
		"cordon",
		"uncordon",
		"drain",
		"exec",
		"cp",
		"run",
		"expose",
		"attach",
	]),
	oc: new Set(["apply", "create", "delete", "edit", "patch", "replace", "scale", "rollout", "set", "new-app"]),
	helm: new Set(["install", "upgrade", "uninstall", "delete", "rollback", "push"]),
	helmfile: new Set(["apply", "sync", "destroy", "delete"]),
	terraform: new Set(["apply", "destroy", "import", "taint", "untaint", "state"]),
	terragrunt: new Set(["apply", "destroy", "import", "run-all"]),
	tofu: new Set(["apply", "destroy", "import", "taint", "untaint", "state"]),
	pulumi: new Set(["up", "destroy", "import", "cancel", "refresh"]),
	kustomize: new Set([]), // kustomize alone only builds; mutation happens via kubectl apply -k
	argocd: new Set(["app", "proj", "repo", "cluster", "login", "sync"]),
	flux: new Set(["bootstrap", "create", "delete", "reconcile", "suspend", "resume"]),
	kubeadm: new Set(["init", "join", "reset", "upgrade"]),
	eksctl: new Set(["create", "delete", "scale", "upgrade"]),
	doctl: new Set(["apply", "create", "delete", "update"]),
	flyctl: new Set(["deploy", "destroy", "scale", "secrets"]),
	fly: new Set(["deploy", "destroy", "scale", "secrets"]),
	vagrant: new Set(["up", "destroy", "provision"]),
	skaffold: new Set(["run", "deploy", "delete", "apply"]),
};

/** CLIs whose mutating intent is in the SECOND token (cloud provider verb groups). */
const CLOUD_CLIS: ReadonlySet<string> = new Set(["aws", "gcloud", "az", "ibmcloud"]);

/** Cloud subcommand verbs that mutate state. Read verbs (describe/list/get) are excluded. */
const CLOUD_MUTATING_VERBS: ReadonlySet<string> = new Set([
	"create",
	"delete",
	"update",
	"apply",
	"deploy",
	"put",
	"remove",
	"rm",
	"set",
	"add",
	"modify",
	"terminate",
	"start",
	"stop",
	"reboot",
	"scale",
	"destroy",
	"run-instances",
	"delete-cluster",
	"update-kubeconfig",
]);

/** Tokenize a single segment on whitespace, dropping empty tokens. Quote-naive
 *  (sufficient: infra CLIs are invoked with plain tokens; quoting tricks fall to
 *  the broader safety policy). */
function tokenize(segment: string): string[] {
	return segment
		.trim()
		.split(/\s+/)
		.filter(t => t.length > 0);
}

/** Skip leading `VAR=val` env assignments and `sudo`/`env` prefixes to find the CLI. */
function stripCommandPrefix(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			i++;
			continue;
		}
		if (t === "sudo" || t === "env" || t === "command" || t === "exec" || t === "time") {
			i++;
			continue;
		}
		break;
	}
	return tokens.slice(i);
}

/** First positional token after the CLI, skipping global flags (`-n ns`, `--flag`, `--flag=v`). */
function firstSubcommand(tokens: string[]): string | undefined {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("-")) {
			// `-n value` style: skip the value for known value-taking short flags.
			if (/^-[nNlf]$/.test(t)) i++;
			continue;
		}
		return t;
	}
	return undefined;
}

/** Base CLI name from a token, stripping any path (`/usr/local/bin/kubectl` → `kubectl`). */
function baseCli(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash >= 0 ? token.slice(slash + 1) : token;
}

function classifySegment(segment: string): InfraCommandMatch | undefined {
	const raw = tokenize(segment);
	if (raw.length === 0) return undefined;
	const tokens = stripCommandPrefix(raw);
	if (tokens.length === 0) return undefined;
	const cli = baseCli(tokens[0]);

	// `kubectl apply -k` / `kubectl kustomize | kubectl apply` already covered via kubectl.
	if (cli in MUTATING_SUBCOMMANDS) {
		const sub = firstSubcommand(tokens.slice(1));
		if (sub && MUTATING_SUBCOMMANDS[cli].has(sub)) {
			return { tool: cli, operation: sub, segment: segment.trim() };
		}
		return undefined;
	}

	if (CLOUD_CLIS.has(cli)) {
		// Scan positionals for the first mutating verb anywhere in the verb group
		// (e.g. `aws ec2 run-instances`, `gcloud container clusters create`).
		for (const t of tokens.slice(1)) {
			if (t.startsWith("-")) continue;
			if (CLOUD_MUTATING_VERBS.has(t)) {
				return { tool: cli, operation: t, segment: segment.trim() };
			}
		}
		return undefined;
	}

	// `docker`/`podman`/`nerdctl` push to a registry is a deploy-class mutation.
	if (cli === "docker" || cli === "podman" || cli === "nerdctl") {
		const sub = firstSubcommand(tokens.slice(1));
		if (sub === "push") return { tool: cli, operation: "push", segment: segment.trim() };
		return undefined;
	}

	return undefined;
}

/** Split a command on top-level segment connectors so each pipeline/chain stage
 *  is classified independently. Quote-naive split — adequate for infra detection;
 *  anything that defeats it is still caught by the broader bash safety policy. */
function splitSegments(command: string): string[] {
	return command.split(/(?:&&|\|\||[;|&\n])/);
}

/**
 * Classify a shell command. Returns the first infrastructure-mutating match
 * found across its segments, or `undefined` when none mutate live infra.
 */
export function classifyInfraCommand(command: string): InfraCommandMatch | undefined {
	for (const segment of splitSegments(command)) {
		const match = classifySegment(segment);
		if (match) return match;
	}
	return undefined;
}

/** Whether a command requires mandatory user approval as an infra-deploy command. */
export function isInfraDeployCommand(command: string): boolean {
	return classifyInfraCommand(command) !== undefined;
}
