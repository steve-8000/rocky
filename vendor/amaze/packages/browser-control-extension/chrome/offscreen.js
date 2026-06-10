const BRIDGE_URL = "ws://127.0.0.1:17362/bridge";
const RETRY_DELAY_MS = 1000;
const activeTabs = new Map();
let socket;
let retryTimer;
let connecting = false;

connect();
setInterval(() => {
	if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) connect();
	for (const tabId of activeTabs.keys()) sendHello(tabId);
}, 15000);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.target !== "amaze-offscreen") return false;
	void handleMessage(message).then(sendResponse, error => sendResponse({ ok: false, error: error?.message ?? String(error) }));
	return true;
});

async function handleMessage(message) {
	if (message.type === "page_ready" || message.type === "tab_updated") {
		if (typeof message.tabId === "number") {
			activeTabs.set(message.tabId, message.tab ?? {});
			sendHello(message.tabId);
		}
		return { ok: true };
	}
	if (message.type === "tab_removed") {
		activeTabs.delete(message.tabId);
		sendToBridge({ type: "tab_removed", tabId: message.tabId });
		return { ok: true };
	}
	if (message.type === "eval_result") {
		sendToBridge({
			type: "result",
			id: message.id,
			ok: Boolean(message.ok),
			...(message.ok ? { value: message.value } : { error: String(message.error ?? "Evaluation failed") }),
		});
		return { ok: true };
	}
	return { ok: false, error: "Unknown offscreen message." };
}

function connect() {
	if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
	connecting = true;
	clearTimeout(retryTimer);
	socket = new WebSocket(BRIDGE_URL);
	socket.addEventListener("open", () => {
		connecting = false;
		for (const tabId of activeTabs.keys()) sendHello(tabId);
	});
	socket.addEventListener("message", event => {
		void handleBridgeMessage(event.data);
	});
	socket.addEventListener("close", scheduleReconnect);
	socket.addEventListener("error", scheduleReconnect);
}

function scheduleReconnect() {
	connecting = false;
	clearTimeout(retryTimer);
	retryTimer = setTimeout(connect, RETRY_DELAY_MS);
}

async function handleBridgeMessage(raw) {
	let message;
	try {
		message = JSON.parse(raw);
	} catch {
		return;
	}
	if (message.type === "evaluate") {
		try {
			await chrome.runtime.sendMessage({
				type: "amaze-offscreen-evaluate",
				id: message.id,
				tabId: message.tabId,
				script: message.script,
				timeoutMs: message.timeoutMs,
			});
		} catch (error) {
			sendToBridge({ type: "result", id: message.id, ok: false, error: error?.message ?? String(error) });
		}
		return;
	}
	if (message.type === "browser_action") {
		try {
			const result = await chrome.runtime.sendMessage({ type: "amaze-offscreen-browser-action", action: message.action });
			sendToBridge({ type: "result", id: message.id, ok: true, value: result });
		} catch (error) {
			sendToBridge({ type: "result", id: message.id, ok: false, error: error?.message ?? String(error) });
		}
	}
}

function sendHello(tabId) {
	const tab = activeTabs.get(tabId);
	sendToBridge({
		type: "hello",
		version: 1,
		client: "amaze-chrome-extension",
		tabId,
		url: tab?.url,
		title: tab?.title,
	});
}

function sendToBridge(message) {
	if (socket?.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(message));
	}
}
