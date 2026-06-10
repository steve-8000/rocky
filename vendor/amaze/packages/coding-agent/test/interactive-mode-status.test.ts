import { beforeAll, describe, expect, test, vi } from "bun:test";
import { initTheme } from "@amaze/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@amaze/coding-agent/modes/types";
import { UiHelpers } from "@amaze/coding-agent/modes/utils/ui-helpers";
import { MEMORY_ACTIVITY_MESSAGE_TYPE } from "@amaze/coding-agent/session/messages";
import { buildSessionContext } from "@amaze/coding-agent/session/session-manager";
import { Container } from "@amaze/tui";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}
function renderContainer(container: Container, width = 120): string {
	return container.children.flatMap(child => child.render(width)).join("\n");
}

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme();
	});

	test("coalesces immediately-sequential status messages", () => {
		const ctx = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			isBackgrounded: false,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);

		helpers.showStatus("STATUS_ONE");
		expect(ctx.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(ctx.chatContainer)).toContain("STATUS_ONE");

		helpers.showStatus("STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(ctx.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(ctx.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(ctx.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const ctx = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			isBackgrounded: false,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);

		helpers.showStatus("STATUS_ONE");
		expect(ctx.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		ctx.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(ctx.chatContainer.children).toHaveLength(3);

		helpers.showStatus("STATUS_TWO");
		// adds spacer + text
		expect(ctx.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(ctx.chatContainer)).toContain("STATUS_TWO");
	});

	test("renders update notification with Amaze binary command", () => {
		const ctx = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			isBackgrounded: false,
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);

		helpers.showNewVersionNotification("15.1.8");

		const rendered = renderContainer(ctx.chatContainer);
		expect(rendered).toContain("Update Available");
		expect(rendered).toContain("New version 15.1.8 is available. Run:");
		expect(rendered).toContain("amaze update");
		expect(rendered).not.toContain("omp update");
	});

	test("preserves optimistic user signatures when rebuilding transcript state", () => {
		const ctx = {
			chatContainer: new Container(),
			pendingTools: new Map(),
			ui: { requestRender: vi.fn() },
			optimisticUserMessageSignature: "hello\u00001",
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);

		helpers.renderSessionContext(buildSessionContext([]));

		// renderSessionContext must not clear the signature — the message_start
		// handler owns this lifecycle and uses it to guard against clearing the
		// user's in-progress editor draft during an optimistic send (#783).
		expect(ctx.optimisticUserMessageSignature).toBe("hello\u00001");
	});

	test("renders and coalesces live memory activity as a structured chat block", () => {
		const ctx = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			isBackgrounded: false,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			lastMemorySpacer: undefined,
			lastMemoryText: undefined,
			pendingTools: new Map(),
			session: { extensionRunner: undefined },
			toolOutputExpanded: false,
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);

		helpers.addMessageToChat({
			role: "custom",
			customType: MEMORY_ACTIVITY_MESSAGE_TYPE,
			content: "Indexed 12 files",
			display: true,
			details: {
				title: "Memory",
				sections: [
					{
						label: "Indexing",
						items: [
							{ status: "success", text: "Indexed 12 files." },
							{ status: "info", text: "Skipped 3 unchanged files." },
						],
					},
				],
			},
			attribution: "agent",
			timestamp: Date.now(),
		});

		expect(ctx.chatContainer.children).toHaveLength(2);
		let rendered = renderContainer(ctx.chatContainer);
		expect(rendered).toContain("[Memory]");
		expect(rendered).toContain("Indexing");
		expect(rendered).toContain("Indexed 12 files.");
		expect(rendered).toContain("Skipped 3 unchanged files.");

		helpers.addMessageToChat({
			role: "custom",
			customType: MEMORY_ACTIVITY_MESSAGE_TYPE,
			content: "Captured new memory entries",
			display: true,
			details: {
				title: "Memory",
				sections: [
					{
						label: "Consolidation",
						items: [{ status: "success", text: "Captured 2 new memory entries." }],
					},
					{
						label: "Writeback",
						items: [{ status: "info", text: "No durable writeback performed." }],
					},
				],
			},
			attribution: "agent",
			timestamp: Date.now(),
		});

		expect(ctx.chatContainer.children).toHaveLength(2);
		rendered = renderContainer(ctx.chatContainer);
		expect(rendered).toContain("Consolidation");
		expect(rendered).toContain("Captured 2 new memory entries.");
		expect(rendered).toContain("Writeback");
		expect(rendered).toContain("No durable writeback performed.");
		expect(rendered).not.toContain("Skipped 3 unchanged files.");
	});
});
