import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@amaze/utils";
import { FooterComponent } from "../src/modes/components/footer";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { initTheme } from "../src/modes/theme/theme";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setProjectDir(originalProjectDir);
});

function createSegmentContext(usingOAuth: boolean): SegmentContext {
	return {
		session: {
			state: {
				model: {
					id: "gpt-5.5",
					contextWindow: 272_000,
				},
			},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => usingOAuth },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		loopMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 11.5,
		contextWindow: 272_000,
		autoCompactEnabled: true,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		git: {
			branch: null,
			status: null,
			pr: null,
		},
	};
}

function createFooterSession(usingOAuth: boolean) {
	return {
		state: {
			model: {
				id: "gpt-5.5",
				contextWindow: 272_000,
			},
		},
		modelRegistry: { isUsingOAuth: () => usingOAuth },
		sessionManager: {
			getEntries: () => [],
		},
		getContextUsage: () => ({ percent: 11.5, contextWindow: 272_000 }),
	} as const;
}

describe("OAuth billing labels", () => {
	it("renders the status-line cost segment with an explicit oauth label", () => {
		const rendered = renderSegment("cost", createSegmentContext(true));

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("(oauth)");
		expect(rendered.content).not.toContain("(sub)");
	});

	it("renders the footer billing summary with the same oauth label", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-footer-oauth-"));
		try {
			setProjectDir(tempDir);
			const footer = new FooterComponent(createFooterSession(true) as never);
			const lines = footer.render(200);

			expect(lines[1]).toContain("(oauth)");
			expect(lines[1]).not.toContain("(sub)");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
