/**
 * Lane C1 — ToolGateway Skeleton (workplan §9.3).
 *
 * A small in-memory registry of {@link ToolDescriptor}s keyed by name. This is
 * additive infrastructure; nothing in the existing tool pipeline consumes it
 * yet. Registration is deduped by name (last writer wins unless `strict`).
 */
import type { ToolDescriptor } from "./tool-descriptor";

export interface RegisterOptions {
	/**
	 * When true, re-registering an existing name throws instead of replacing.
	 * Default false (idempotent overwrite — convenient for legacy bootstrap).
	 */
	strict?: boolean;
}

export class ToolRegistry {
	#tools = new Map<string, ToolDescriptor<any, any>>();

	/** Register (or replace) a descriptor. Deduped by `descriptor.name`. */
	register<TInput, TOutput>(descriptor: ToolDescriptor<TInput, TOutput>, options: RegisterOptions = {}): this {
		const { name } = descriptor;
		if (!name) {
			throw new Error("ToolRegistry.register: descriptor.name is required");
		}
		if (options.strict && this.#tools.has(name)) {
			throw new Error(`ToolRegistry.register: duplicate tool name "${name}"`);
		}
		this.#tools.set(name, descriptor as ToolDescriptor<any, any>);
		return this;
	}

	/** Register many descriptors in order. */
	registerAll(descriptors: Iterable<ToolDescriptor<any, any>>, options: RegisterOptions = {}): this {
		for (const descriptor of descriptors) {
			this.register(descriptor, options);
		}
		return this;
	}

	/** Look up a descriptor by name. Returns undefined when absent. */
	get<TInput = unknown, TOutput = unknown>(name: string): ToolDescriptor<TInput, TOutput> | undefined {
		return this.#tools.get(name) as ToolDescriptor<TInput, TOutput> | undefined;
	}

	/** Whether a descriptor is registered under `name`. */
	has(name: string): boolean {
		return this.#tools.has(name);
	}

	/** All registered descriptors, in insertion order. */
	list(): ToolDescriptor<any, any>[] {
		return [...this.#tools.values()];
	}

	/** All registered tool names, in insertion order. */
	names(): string[] {
		return [...this.#tools.keys()];
	}

	/** Number of registered descriptors. */
	get size(): number {
		return this.#tools.size;
	}
}
