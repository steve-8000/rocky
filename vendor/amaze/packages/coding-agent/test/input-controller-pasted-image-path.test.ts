import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../src/config/settings";

mock.module("../src/slash-commands/builtin-registry.ts", () => ({
	executeBuiltinSlashCommand: async () => false,
}));
const { InputController } = await import("../src/modes/controllers/input-controller");

import type { InteractiveModeContext, SubmittedUserInput } from "../src/modes/types";

type FakeEditor = {
	onSubmit?: (text: string) => Promise<void>;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
};

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function createSubmission(input: {
	text: string;
	images?: InteractiveModeContext["pendingImages"];
}): SubmittedUserInput {
	return {
		text: input.text,
		images: input.images,
		cancelled: false,
		started: false,
	};
}

function createContext(cwd: string): {
	ctx: InteractiveModeContext;
	editor: FakeEditor;
	spies: {
		onInputCallback: ReturnType<typeof vi.fn>;
		startPendingSubmission: ReturnType<typeof vi.fn>;
	};
} {
	let editorText = "";
	const onInputCallback = vi.fn();
	const startPendingSubmission = vi.fn((input: { text: string; images?: InteractiveModeContext["pendingImages"] }) =>
		createSubmission(input),
	);
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
	};

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender: vi.fn() } as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			messages: [],
			extensionRunner: undefined,
			clientBridge: undefined,
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getSessionName: () => "existing session",
			getCwd: () => cwd,
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: { getKeys: () => [] } as unknown as InteractiveModeContext["keybindings"],
		pendingImages: [],
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: false,
		onInputCallback,
		startPendingSubmission,
		flushPendingBashComponents: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		handleBashCommand: vi.fn(),
		handlePythonCommand: vi.fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, spies: { onInputCallback, startPendingSubmission } };
}

function writePng(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, Buffer.from(RED_1X1_PNG_BASE64, "base64"));
}

function setClientBridge(
	ctx: InteractiveModeContext,
	clientBridge: NonNullable<InteractiveModeContext["session"]["clientBridge"]>,
): void {
	Object.defineProperty(ctx.session, "clientBridge", { configurable: true, value: clientBridge });
}

describe("InputController pasted image path submission", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-pasted-image-path-"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: testDir, overrides: { "images.autoResize": false } });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("attaches a shell-escaped macOS screenshot path and replaces it with [Image #1]", async () => {
		const screenshotPath = path.join(
			testDir,
			"TemporaryItems",
			"NSIRD_screencaptureui_abc",
			"스크린샷 2026-06-01 오후 1.43.32.png",
		);
		writePng(screenshotPath);
		const pastedPath = screenshotPath.replaceAll(" ", "\\ ");
		const { ctx, editor, spies } = createContext(testDir);
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.(`please inspect ${pastedPath}`);

		expect(spies.startPendingSubmission).toHaveBeenCalledTimes(1);
		const submitted = spies.startPendingSubmission.mock.calls[0][0] as {
			text: string;
			images?: InteractiveModeContext["pendingImages"];
		};
		expect(submitted.text).toBe("please inspect [Image #1]");
		expect(submitted.text).not.toContain(pastedPath);
		expect(submitted.images).toHaveLength(1);
		expect(submitted.images?.[0]?.mimeType).toBe("image/png");
	});

	it("leaves a non-existing /var screenshot path unchanged with no image attachment when there is no bridge", async () => {
		const rawText =
			"/var/folders/missing/TemporaryItems/NSIRD_screencaptureui_nope/스크린샷\\ 2026-06-01\\ 오후\\ 1.43.32.png";
		const { ctx, editor, spies } = createContext(testDir);
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.(rawText);

		expect(spies.startPendingSubmission).toHaveBeenCalledWith({ text: rawText, images: undefined });
	});

	it("uses client bridge binary read after a local miss and replaces the path with [Image #1]", async () => {
		const rawText =
			"/var/folders/client/TemporaryItems/NSIRD_screencaptureui_bridge/스크린샷\\ 2026-06-01\\ 오후\\ 1.43.32.png";
		const { ctx, editor, spies } = createContext(testDir);
		const readBinaryFile = vi.fn(async () => ({ dataBase64: RED_1X1_PNG_BASE64, mimeType: "text/plain" }));
		setClientBridge(ctx, {
			capabilities: { readBinaryFile: true },
			readBinaryFile,
		} as NonNullable<InteractiveModeContext["session"]["clientBridge"]>);
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.(`please inspect ${rawText}`);

		expect(readBinaryFile).toHaveBeenCalledWith({
			path: "/var/folders/client/TemporaryItems/NSIRD_screencaptureui_bridge/스크린샷 2026-06-01 오후 1.43.32.png",
			maxBytes: 20 * 1024 * 1024,
		});
		const submitted = spies.startPendingSubmission.mock.calls[0][0] as {
			text: string;
			images?: InteractiveModeContext["pendingImages"];
		};
		expect(submitted.text).toBe("please inspect [Image #1]");
		expect(submitted.images).toHaveLength(1);
		expect(submitted.images?.[0]?.mimeType).toBe("image/png");
	});

	it("numbers a bridge-loaded pasted image after an existing pending clipboard image", async () => {
		const rawText = "/var/folders/client/TemporaryItems/NSIRD_screencaptureui_bridge/screenshot\\ 2.png";
		const existingImage = { type: "image" as const, data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const { ctx, editor, spies } = createContext(testDir);
		ctx.pendingImages = [existingImage];
		setClientBridge(ctx, {
			capabilities: { readBinaryFile: true },
			readBinaryFile: vi.fn(async () => ({ dataBase64: RED_1X1_PNG_BASE64, mimeType: "image/png" })),
		} as NonNullable<InteractiveModeContext["session"]["clientBridge"]>);
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.(`compare ${rawText}`);

		const submitted = spies.startPendingSubmission.mock.calls[0][0] as {
			text: string;
			images?: InteractiveModeContext["pendingImages"];
		};
		expect(submitted.text).toBe("compare [Image #2]");
		expect(submitted.images).toHaveLength(2);
		expect(submitted.images?.[0]).toEqual(existingImage);
		expect(submitted.images?.[1]?.mimeType).toBe("image/png");
	});
});
