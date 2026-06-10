chrome.runtime.sendMessage({ type: "amaze-page-ready" }).catch(() => undefined);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type !== "amaze-evaluate") return false;
	void evaluateForBridge(message);
	sendResponse({ ok: true });
	return false;
});

async function evaluateForBridge(message) {
	const timeoutMs = typeof message.timeoutMs === "number" && message.timeoutMs > 0 ? message.timeoutMs : 30000;
	try {
		const script = String(message.script ?? "");
		const value = script === "__AMAZE_SNAPSHOT__" ? buildSnapshot() : await withTimeout(runScript(script), timeoutMs);
		await chrome.runtime.sendMessage({ type: "amaze-eval-result", id: message.id, ok: true, value });
	} catch (error) {
		await chrome.runtime.sendMessage({
			type: "amaze-eval-result",
			id: message.id,
			ok: false,
			error: error?.message ?? String(error),
		});
	}
}

async function runScript(script) {
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	const fn = new AsyncFunction(
		"helpers",
		`const { $, $$, text, click, fill, wait } = helpers;\n${script}`,
	);
	return await fn({ $, $$, text, click, fill, wait });
}

function buildSnapshot() {
	return {
		title: document.title,
		url: location.href,
		text: (document.body?.innerText ?? document.documentElement?.innerText ?? "").slice(0, 20000),
		links: [...document.querySelectorAll("a[href]")]
			.map(a => ({
				text: (a.innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "").trim(),
				href: a.href,
			}))
			.filter(link => link.href),
		html: document.documentElement.outerHTML,
	};
}

function $(selector) {
	const element = document.querySelector(selector);
	if (!element) throw new Error(`No element matches selector: ${selector}`);
	return element;
}

function $$(selector) {
	return [...document.querySelectorAll(selector)];
}

function text(selector = "body") {
	return $(selector).innerText ?? $(selector).textContent ?? "";
}

function click(selector) {
	$(selector).click();
}

function fill(selector, value) {
	const element = $(selector);
	element.focus();
	element.value = value;
	element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
	element.dispatchEvent(new Event("change", { bubbles: true }));
}

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs);
		promise.then(
			value => {
				clearTimeout(timer);
				resolve(value);
			},
			error => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
