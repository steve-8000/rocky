/**
 * Lane C1 — ToolGateway Skeleton (workplan §9).
 *
 * The ToolGateway runs a tool call through a fixed policy pipeline:
 *
 *   PolicyGate → PermissionGate → MutationScopeGuard → TimeoutPolicy → execute
 *
 * It is additive and OPT-IN: no existing tool call path is routed through it
 * yet. Lifecycle hooks are left as optional callbacks (no event emission). On
 * any policy denial it short-circuits with a failed {@link ToolResult} rather
 * than throwing.
 */
import type { ToolDescriptor, ToolExecutionContext, ToolResult, ToolRiskLevel } from "../registry/tool-descriptor";
import type { ToolRegistry } from "../registry/tool-registry";
import { type AsyncMutationScopeGuard, DefaultMutationScopeGuard, type MutationScopeGuard } from "./mutation-guard";
import { DefaultPermissionGate, type PermissionGate } from "./permission-gate";
import { classifyRisk } from "./risk-classifier";
import { DefaultTimeoutPolicy, type TimeoutPolicy } from "./timeout-policy";

export interface PolicyDecision {
	allowed: boolean;
	reason?: string;
	code?: string;
	details?: Record<string, unknown>;
}

/**
 * Optional first-stage gate (e.g. MissionPolicyEngine in Wave 3). Defaults to
 * allow-all in the skeleton.
 */
export interface PolicyGate {
	check(descriptor: ToolDescriptor<any, any>, ctx: ToolExecutionContext, riskLevel: ToolRiskLevel): PolicyDecision;
}

class AllowAllPolicyGate implements PolicyGate {
	check(): PolicyDecision {
		return { allowed: true };
	}
}

/** Stage at which a call was denied, for diagnostics. */
export type DenyStage = "policy" | "permission" | "mutation";

export interface GatewayHooks {
	onClassified?(descriptor: ToolDescriptor<any, any>, riskLevel: ToolRiskLevel, ctx: ToolExecutionContext): void;
	onDenied?(descriptor: ToolDescriptor<any, any>, stage: DenyStage, reason: string, ctx: ToolExecutionContext): void;
	onBeforeExecute?(descriptor: ToolDescriptor<any, any>, timeoutMs: number, ctx: ToolExecutionContext): void;
	onResult?(descriptor: ToolDescriptor<any, any>, result: ToolResult<any>, ctx: ToolExecutionContext): void;
}

export interface ToolGatewayOptions {
	policyGate?: PolicyGate;
	permissionGate?: PermissionGate;
	mutationGuard?: MutationScopeGuard;
	/**
	 * Optional async mutation-scope guard (e.g. subagent/mission scope enforcement
	 * that must touch the filesystem). Consulted by {@link ToolGateway.guard} in
	 * addition to the synchronous {@link mutationGuard}. Absent ⇒ skipped.
	 */
	asyncMutationGuard?: AsyncMutationScopeGuard;
	timeoutPolicy?: TimeoutPolicy;
	hooks?: GatewayHooks;
}

function deniedResult(reason: string, riskLevel: ToolRiskLevel): ToolResult<never> {
	return {
		ok: false,
		output: undefined as never,
		error: new Error(reason),
		riskLevel,
	};
}

export class ToolGateway {
	#registry: ToolRegistry;
	#policyGate: PolicyGate;
	#permissionGate: PermissionGate;
	#mutationGuard: MutationScopeGuard;
	#asyncMutationGuard?: AsyncMutationScopeGuard;
	#timeoutPolicy: TimeoutPolicy;
	#hooks: GatewayHooks;

	constructor(registry: ToolRegistry, options: ToolGatewayOptions = {}) {
		this.#registry = registry;
		this.#policyGate = options.policyGate ?? new AllowAllPolicyGate();
		this.#permissionGate = options.permissionGate ?? new DefaultPermissionGate();
		this.#mutationGuard = options.mutationGuard ?? new DefaultMutationScopeGuard();
		this.#asyncMutationGuard = options.asyncMutationGuard;
		this.#timeoutPolicy = options.timeoutPolicy ?? new DefaultTimeoutPolicy();
		this.#hooks = options.hooks ?? {};
	}

	get registry(): ToolRegistry {
		return this.#registry;
	}

	/**
	 * Run a registered tool by name through the policy pipeline.
	 * Returns a failed ToolResult (never throws) on lookup miss or policy deny.
	 */
	async run<TInput = unknown, TOutput = unknown>(
		name: string,
		input: TInput,
		ctx: ToolExecutionContext = {},
	): Promise<ToolResult<TOutput>> {
		const descriptor = this.#registry.get<TInput, TOutput>(name);
		if (!descriptor) {
			return {
				ok: false,
				output: undefined as never,
				error: new Error(`ToolGateway.run: no tool registered under "${name}"`),
			};
		}

		const riskLevel = classifyRisk(descriptor);
		this.#hooks.onClassified?.(descriptor, riskLevel, ctx);

		// 1. PolicyGate
		const policy = this.#policyGate.check(descriptor, ctx, riskLevel);
		if (!policy.allowed) {
			const reason = policy.reason ?? `policy denied tool "${name}"`;
			this.#hooks.onDenied?.(descriptor, "policy", reason, ctx);
			return deniedResult(reason, riskLevel);
		}

		// 2. PermissionGate
		const permission = this.#permissionGate.check(descriptor, ctx, riskLevel);
		if (!permission.allowed) {
			const reason = permission.reason ?? `permission denied for tool "${name}"`;
			this.#hooks.onDenied?.(descriptor, "permission", reason, ctx);
			return deniedResult(reason, riskLevel);
		}

		// 3. MutationScopeGuard
		const mutation = this.#mutationGuard.check(descriptor, ctx);
		if (!mutation.allowed) {
			const reason = mutation.reason ?? `mutation scope denied for tool "${name}"`;
			this.#hooks.onDenied?.(descriptor, "mutation", reason, ctx);
			return deniedResult(reason, riskLevel);
		}

		// 4. TimeoutPolicy
		const timeoutMs = this.#timeoutPolicy.resolve(descriptor, riskLevel);
		this.#hooks.onBeforeExecute?.(descriptor, timeoutMs, ctx);

		// 5. Execute
		let result: ToolResult<TOutput>;
		try {
			result = await descriptor.execute(input, ctx);
		} catch (err) {
			result = {
				ok: false,
				output: undefined as never,
				error: err instanceof Error ? err : new Error(String(err)),
			};
		}

		// Annotate with policy metadata (without clobbering explicit values).
		result.riskLevel ??= riskLevel;
		result.timeoutMs ??= timeoutMs;

		this.#hooks.onResult?.(descriptor, result, ctx);
		return result;
	}

	/**
	 * Run only the policy pipeline (PolicyGate → PermissionGate → MutationScopeGuard →
	 * TimeoutPolicy) for an already-resolved descriptor, WITHOUT executing it. This is the
	 * seam entrypoint used by the agent loop, which keeps ownership of the real execution
	 * (streaming `onUpdate`, abort signal, original result shape) while delegating the
	 * allow/deny + timeout + telemetry decision to the gateway.
	 *
	 * Emits a `mission.tool.requested` record when a mission context is present and the call
	 * is allowed. The caller MUST invoke {@link settle} once execution finishes to emit the
	 * matching `mission.tool.completed` record.
	 */
	async guard(descriptor: ToolDescriptor<any, any>, ctx: ToolExecutionContext): Promise<GuardDecision> {
		const riskLevel = classifyRisk(descriptor);
		this.#hooks.onClassified?.(descriptor, riskLevel, ctx);

		const deny = (stage: DenyStage, reason: string, code?: string): GuardDecision => {
			this.#hooks.onDenied?.(descriptor, stage, reason, ctx);
			this.#emitRecord(ctx, descriptor, "completed", "denied");
			return { allowed: false, stage, reason, code, riskLevel, timeoutMs: 0 };
		};

		const policy = this.#policyGate.check(descriptor, ctx, riskLevel);
		if (!policy.allowed)
			return deny("policy", policy.reason ?? `policy denied tool "${descriptor.name}"`, policy.code);

		const permission = this.#permissionGate.check(descriptor, ctx, riskLevel);
		if (!permission.allowed) {
			return deny("permission", permission.reason ?? `permission denied for tool "${descriptor.name}"`);
		}

		const mutation = this.#mutationGuard.check(descriptor, ctx);
		if (!mutation.allowed) {
			return deny("mutation", mutation.reason ?? `mutation scope denied for tool "${descriptor.name}"`);
		}

		if (this.#asyncMutationGuard) {
			const asyncMutation = await this.#asyncMutationGuard.checkAsync(descriptor, ctx);
			if (!asyncMutation.allowed) {
				return deny("mutation", asyncMutation.reason ?? `mutation scope denied for tool "${descriptor.name}"`);
			}
		}

		const timeoutMs = this.#timeoutPolicy.resolve(descriptor, riskLevel);
		this.#hooks.onBeforeExecute?.(descriptor, timeoutMs, ctx);
		this.#emitRecord(ctx, descriptor, "requested");
		return { allowed: true, riskLevel, timeoutMs };
	}

	/**
	 * Emit the terminal `mission.tool.completed` record for a call that passed {@link guard}.
	 * No-op when no mission context is present.
	 */
	settle(descriptor: ToolDescriptor<any, any>, ctx: ToolExecutionContext, status: "ok" | "error"): void {
		this.#emitRecord(ctx, descriptor, "completed", status);
	}

	#emitRecord(
		ctx: ToolExecutionContext,
		descriptor: ToolDescriptor<any, any>,
		phase: "requested" | "completed",
		status?: "ok" | "error" | "denied",
	): void {
		const mission = ctx.mission;
		if (!mission) return;
		const ts = Date.now();
		const toolCallId = ctx.toolCallId ?? "";
		const taskId = mission.taskId ?? null;
		if (phase === "requested") {
			mission.emit({
				type: "mission.tool.requested",
				missionId: mission.missionId,
				taskId,
				toolCallId,
				tool: descriptor.name,
				ts,
			});
			return;
		}
		mission.emit({
			type: "mission.tool.completed",
			missionId: mission.missionId,
			taskId,
			toolCallId,
			tool: descriptor.name,
			status: status ?? "ok",
			ts,
		});
	}
}

/** Decision returned by {@link ToolGateway.guard}. */
export type GuardDecision =
	| { allowed: true; riskLevel: ToolRiskLevel; timeoutMs: number }
	| { allowed: false; stage: DenyStage; reason: string; code?: string; riskLevel: ToolRiskLevel; timeoutMs: number };
