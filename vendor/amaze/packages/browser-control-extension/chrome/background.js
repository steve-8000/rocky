const OFFSCREEN_URL = "offscreen.html";

ensureOffscreen().catch(() => undefined);
chrome.runtime.onStartup?.addListener(() => ensureOffscreen().catch(() => undefined));
chrome.runtime.onInstalled?.addListener(() => ensureOffscreen().catch(() => undefined));
chrome.action?.onClicked?.addListener(() => ensureOffscreen().catch(() => undefined));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	void handleRuntimeMessage(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error?.message ?? String(error) }));
	return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status === "complete") {
		void sendToOffscreen({ type: "tab_updated", tabId, tab }).catch(() => undefined);
	}
});

chrome.tabs.onRemoved.addListener(tabId => {
	void sendToOffscreen({ type: "tab_removed", tabId }).catch(() => undefined);
});

async function handleRuntimeMessage(message, sender) {
	await ensureOffscreen();
	if (message?.type === "amaze-page-ready") {
		const tabId = sender.tab?.id;
		if (typeof tabId === "number") {
			await sendToOffscreen({ type: "page_ready", tabId, tab: sender.tab ?? (await safeGetTab(tabId)) });
		}
		return { ok: true };
	}
	if (message?.type === "amaze-eval-result") {
		await sendToOffscreen({
			type: "eval_result",
			id: message.id,
			ok: Boolean(message.ok),
			...(message.ok ? { value: message.value } : { error: String(message.error ?? "Evaluation failed") }),
		});
		return { ok: true };
	}
	if (message?.type === "amaze-offscreen-evaluate") {
		return await forwardEvaluate(message);
	}
	if (message?.type === "amaze-offscreen-browser-action") {
		return await runBrowserAction(message.action);
	}
	return { ok: false, error: "Unknown message type." };
}

async function forwardEvaluate(message) {
	const tabId = message.tabId;
	if (typeof tabId !== "number") throw new Error("Bridge request did not include a tab id.");
	await chrome.tabs.sendMessage(tabId, {
		type: "amaze-evaluate",
		id: message.id,
		script: message.script,
		timeoutMs: message.timeoutMs,
	});
	return { ok: true };
}

async function runBrowserAction(action) {
	if (!action || typeof action !== "object") throw new Error("Bridge browser action must be an object.");
	switch (action.type) {
		case "tabs_query":
			return await chrome.tabs.query({});
		case "tab_create":
			return await chrome.tabs.create({ url: action.url, active: action.active !== false });
		case "tab_close":
			await chrome.tabs.remove(action.tabId);
			return { ok: true, tabId: action.tabId };
		case "tab_activate": {
			const tab = await chrome.tabs.update(action.tabId, { active: true });
			if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
			return tab;
		}
		case "tab_navigate":
			return await chrome.tabs.update(action.tabId, { url: action.url, active: true });
		case "tab_reload":
			await chrome.tabs.reload(action.tabId);
			return { ok: true, tabId: action.tabId };
		default:
			throw new Error(`Unknown bridge browser action: ${action.type}`);
	}
}

async function ensureOffscreen() {
	if (!chrome.offscreen?.createDocument) return;
	const existing = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)] });
	if (existing?.length) return;
	await chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: ["DOM_SCRAPING"],
		justification: "Maintain a persistent extension-owned document for the local WebSocket connection to the Amaze browser-control daemon.",
	});
}

async function sendToOffscreen(message) {
	await ensureOffscreen();
	return await chrome.runtime.sendMessage({ ...message, target: "amaze-offscreen" });
}

async function safeGetTab(tabId) {
	try {
		return await chrome.tabs.get(tabId);
	} catch {
		return undefined;
	}
}
