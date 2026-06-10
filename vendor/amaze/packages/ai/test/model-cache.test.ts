/**
 * Regression — `readModelCache` must recompute thinking metadata from the
 * current code rules instead of trusting whatever was serialized into the row.
 *
 * Cache rows store previously enriched models. `enrichModelThinking` treats an
 * existing `thinking` block as authoritative, so a row written before the code
 * understood a model (e.g. the Fable/Mythos flagship line cached with the wrong
 * `mode: "budget"`) would otherwise keep emitting unsupported budget thinking
 * until the row expired. Refreshing on read fixes the derived config while
 * leaving the discovered model list and all other fields untouched.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@amaze/ai";
import { readModelCache } from "@amaze/ai/model-cache";
import type { Model } from "@amaze/ai/types";

const CACHE_SCHEMA_VERSION = 3;

const tempDbs: string[] = [];

function createCacheDb(rows: Array<{ providerId: string; version?: number; models: unknown }>): string {
	const dbPath = path.join(os.tmpdir(), `amaze-model-cache-${crypto.randomUUID()}.db`);
	tempDbs.push(dbPath);
	const db = new Database(dbPath, { create: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run(`
		CREATE TABLE IF NOT EXISTS model_cache (
			provider_id TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			authoritative INTEGER NOT NULL DEFAULT 0,
			static_fingerprint TEXT NOT NULL DEFAULT '',
			models TEXT NOT NULL
		)
	`);
	for (const row of rows) {
		db.run(
			`INSERT OR REPLACE INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, ?, ?, ?, ?, ?)`,
			[row.providerId, row.version ?? CACHE_SCHEMA_VERSION, Date.now(), 1, "fp", JSON.stringify(row.models)],
		);
	}
	db.close();
	return dbPath;
}

afterEach(() => {
	for (const dbPath of tempDbs.splice(0)) {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				fs.rmSync(`${dbPath}${suffix}`);
			} catch {
				// best-effort cleanup
			}
		}
	}
});

describe("readModelCache thinking refresh", () => {
	it("rewrites a stale Fable thinking mode to adaptive while preserving the model list", () => {
		const staleModels: Model<"anthropic-messages">[] = [
			{
				id: "claude-fable-5",
				name: "Fable 5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				// Written by an older build that did not parse the fable kind.
				thinking: { mode: "budget", minLevel: Effort.Minimal, maxLevel: Effort.XHigh },
			},
			{
				id: "claude-opus-4-8",
				name: "Opus 4.8",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				thinking: { mode: "anthropic-adaptive", minLevel: Effort.Minimal, maxLevel: Effort.XHigh },
			},
		];
		const dbPath = createCacheDb([{ providerId: "anthropic", models: staleModels }]);

		const entry = readModelCache<"anthropic-messages">("anthropic", 24 * 60 * 60 * 1000, Date.now, dbPath);

		expect(entry).not.toBeNull();
		// The discovered model list survives intact.
		expect(entry?.models.map(model => model.id)).toEqual(["claude-fable-5", "claude-opus-4-8"]);
		// The stale budget mode is corrected to adaptive.
		expect(entry?.models[0]?.thinking).toEqual({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.XHigh,
		});
		// Non-thinking fields are preserved untouched.
		expect(entry?.models[0]?.contextWindow).toBe(1_000_000);
		expect(entry?.models[0]?.name).toBe("Fable 5");
	});

	it("returns null for rows written under an older schema version", () => {
		const dbPath = createCacheDb([{ providerId: "anthropic", version: CACHE_SCHEMA_VERSION - 1, models: [] }]);

		const entry = readModelCache("anthropic", 24 * 60 * 60 * 1000, Date.now, dbPath);

		expect(entry).toBeNull();
	});
});
