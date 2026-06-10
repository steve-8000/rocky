export const DEFAULT_BRIDGE_PORT = 17362;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PROTOCOL_VERSION = 1;

export type BridgeClientMessage =
	| {
			type: "hello";
			version: number;
			client: "amaze-chrome-extension";
			tabId?: number;
			url?: string;
			title?: string;
	  }
	| {
			type: "tab_removed";
			tabId: number;
	  }
	| {
			type: "result";
			id: string;
			ok: true;
			value: unknown;
	  }
	| {
			type: "result";
			id: string;
			ok: false;
			error: string;
	  };

export type BridgeServerMessage =
	| {
			type: "ack";
			version: number;
	  }
	| {
			type: "evaluate";
			id: string;
			tabId: number;
			script: string;
			timeoutMs: number;
	  }
	| {
			type: "browser_action";
			id: string;
			action: BrowserAction;
	  };

export type BrowserAction =
	| {
			type: "tabs_query";
	  }
	| {
			type: "tab_create";
			url: string;
			active?: boolean;
	  }
	| {
			type: "tab_close";
			tabId: number;
	  }
	| {
			type: "tab_activate";
			tabId: number;
	  }
	| {
			type: "tab_navigate";
			tabId: number;
			url: string;
	  }
	| {
			type: "tab_reload";
			tabId: number;
	  };

export interface ConnectedTab {
	id: string;
	tabId: number;
	url?: string;
	title?: string;
	connectedAt: number;
	lastSeenAt: number;
}
