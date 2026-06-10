import { describe, expect, it } from "bun:test";
import { isReadOnlyBashCommand } from "@amaze/coding-agent/tools/gateway/bash-readonly-classifier";

describe("isReadOnlyBashCommand", () => {
	describe("allows read-only investigative commands", () => {
		const cases = [
			"kubectl get pods",
			"kubectl -n monitoring get po -o wide",
			"kubectl describe deployment foo",
			"kubectl logs -l app=bar --tail=50",
			"kubectl top pods",
			"kubectl config current-context",
			"kubectl config get-contexts",
			"git status",
			"git log --oneline -n 20",
			"git diff HEAD~3",
			"git rev-parse HEAD",
			"git stash list",
			"git stash show",
			"ls -la",
			"cat /etc/hosts",
			"pwd",
			"whoami",
			"echo hello world",
			"helm list -A",
			"docker ps -a",
			"docker logs my-container",
			"terraform plan",
			"terraform show",
			"node --version",
			"bun -v",
			"python3 --version",
			// Pipelines and conjunctions of read-only segments remain read-only.
			"kubectl get pods | grep Running",
			"git log --oneline | head -20 | wc -l",
			"kubectl get ns && kubectl get pods -A",
			// Inline env assignments are allowed.
			"KUBECONFIG=/tmp/kc kubectl get nodes",
		];
		for (const cmd of cases) {
			it(`passes: ${cmd}`, () => {
				expect(isReadOnlyBashCommand(cmd)).toBe(true);
			});
		}
	});

	describe("rejects mutations and dangerous shell features", () => {
		const cases = [
			// Workspace mutation
			"rm -rf node_modules",
			"mv a b",
			"touch x",
			"mkdir -p out",
			"chmod +x script.sh",
			// CLI mutating subcommands
			"kubectl apply -f deploy.yaml",
			"kubectl delete pod foo",
			"kubectl edit deployment bar",
			"kubectl exec -it foo -- sh",
			"kubectl config set-context staging",
			"git push origin main",
			"git commit -am wip",
			"git checkout -b feature",
			"git stash push -m wip",
			"git remote add upstream git@x:y",
			"helm install nginx bitnami/nginx",
			"helm upgrade nginx bitnami/nginx",
			"docker run -d nginx",
			"docker build .",
			"terraform apply -auto-approve",
			"terraform state rm aws_instance.foo",
			"npm install left-pad",
			// Privilege escalation / arbitrary code
			"sudo kubectl get pods",
			"eval 'rm -rf /'",
			"source env.sh",
			". ./env.sh",
			"exec bash",
			// Redirects
			"kubectl get pods > out.txt",
			"echo hi >> log",
			"cat file <<< 'data'",
			// Command substitution
			"echo $(rm -rf .)",
			"echo `whoami`",
			// Pipeline with one mutating segment
			"kubectl get pods | tee out.txt",
			"git status && git push",
			"git log; rm tmp",
			// Conditional read-only verbs with mutating flags
			"find . -name 'tmp' -delete",
			"sed -i 's/a/b/g' file",
			"xargs rm",
			'node -e \'require("fs").rmSync("x")\'',
			"python -c 'import os; os.remove(\"x\")'",
			// Unknown verbs default to mutation
			"make build",
			"unknown_tool foo bar",
		];
		for (const cmd of cases) {
			it(`rejects: ${cmd}`, () => {
				expect(isReadOnlyBashCommand(cmd)).toBe(false);
			});
		}
	});

	it("treats empty/whitespace commands as read-only no-ops", () => {
		expect(isReadOnlyBashCommand("")).toBe(true);
		expect(isReadOnlyBashCommand("   ")).toBe(true);
	});

	it("rejects non-string input defensively", () => {
		expect(isReadOnlyBashCommand(undefined as unknown as string)).toBe(false);
		expect(isReadOnlyBashCommand(null as unknown as string)).toBe(false);
	});
});
