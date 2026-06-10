import { describe, expect, test } from "bun:test";
import { classifyInfraCommand, isInfraDeployCommand } from "../../src/security/infra-command-classifier";

describe("classifyInfraCommand — mutating infra commands flagged", () => {
	const mutating: Array<[string, string, string]> = [
		["kubectl apply -f deploy.yaml", "kubectl", "apply"],
		["kubectl -n prod delete pod web-0", "kubectl", "delete"],
		["kubectl rollout restart deployment/api", "kubectl", "rollout"],
		["helm upgrade --install api ./chart", "helm", "upgrade"],
		["helm uninstall api", "helm", "uninstall"],
		["terraform apply -auto-approve", "terraform", "apply"],
		["terraform destroy", "terraform", "destroy"],
		["tofu apply", "tofu", "apply"],
		["pulumi up --yes", "pulumi", "up"],
		["argocd app sync my-app", "argocd", "app"],
		["flux reconcile kustomization flux-system", "flux", "reconcile"],
		["aws ec2 run-instances --image-id ami-123", "aws", "run-instances"],
		["gcloud container clusters create prod", "gcloud", "create"],
		["az aks create -g rg -n cluster", "az", "create"],
		["eksctl create cluster -f cfg.yaml", "eksctl", "create"],
		["docker push registry.io/app:latest", "docker", "push"],
		["sudo kubectl delete ns prod", "kubectl", "delete"],
		["KUBECONFIG=/tmp/kc kubectl apply -f x.yaml", "kubectl", "apply"],
		["/usr/local/bin/helm rollback api 3", "helm", "rollback"],
	];

	for (const [command, tool, operation] of mutating) {
		test(`flags: ${command}`, () => {
			const match = classifyInfraCommand(command);
			expect(match).toBeDefined();
			expect(match?.tool).toBe(tool);
			expect(match?.operation).toBe(operation);
			expect(isInfraDeployCommand(command)).toBe(true);
		});
	}
});

describe("classifyInfraCommand — read-only / unrelated commands NOT flagged", () => {
	const readonly = [
		"kubectl get pods",
		"kubectl -n monitoring get pods -o wide",
		"kubectl describe deployment api",
		"kubectl logs -f pod/web-0",
		"helm list",
		"helm status api",
		"terraform plan",
		"terraform validate",
		"aws s3 ls",
		"aws ec2 describe-instances",
		"gcloud container clusters list",
		"az aks show -g rg -n cluster",
		"docker build -t app .",
		"docker ps",
		"ls -la",
		"git status",
		"echo kubectl apply", // not an invocation of kubectl
		"cat deploy.yaml",
	];

	for (const command of readonly) {
		test(`does not flag: ${command}`, () => {
			expect(classifyInfraCommand(command)).toBeUndefined();
			expect(isInfraDeployCommand(command)).toBe(false);
		});
	}
});

describe("classifyInfraCommand — detects infra in a pipeline/chain segment", () => {
	test("flags kubectl apply hidden after a pipe", () => {
		const match = classifyInfraCommand("cat deploy.yaml && kubectl apply -f -");
		expect(match?.tool).toBe("kubectl");
		expect(match?.operation).toBe("apply");
	});

	test("flags terraform destroy after a semicolon", () => {
		const match = classifyInfraCommand("cd infra; terraform destroy -auto-approve");
		expect(match?.tool).toBe("terraform");
	});
});
