import type {
	BehaviorDashboardStats,
	CostDashboardStats,
	DashboardStats,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	RequestDetails,
} from "./types";

const API_BASE = "/api";

async function fetchJson<T>(path: string, errorMessage: string): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`);
	if (!res.ok) throw new Error(errorMessage);
	return res.json() as Promise<T>;
}

export async function getStats(range = "24h"): Promise<DashboardStats> {
	return fetchJson<DashboardStats>(`/stats?range=${encodeURIComponent(range)}`, "Failed to fetch stats");
}

export async function getOverviewStats(range = "24h"): Promise<OverviewStats> {
	return fetchJson<OverviewStats>(
		`/stats/overview?range=${encodeURIComponent(range)}`,
		"Failed to fetch overview stats",
	);
}

export async function getModelDashboardStats(range = "24h"): Promise<ModelDashboardStats> {
	return fetchJson<ModelDashboardStats>(
		`/stats/model-dashboard?range=${encodeURIComponent(range)}`,
		"Failed to fetch model stats",
	);
}

export async function getCostDashboardStats(range = "24h"): Promise<CostDashboardStats> {
	return fetchJson<CostDashboardStats>(
		`/stats/costs?range=${encodeURIComponent(range)}`,
		"Failed to fetch cost stats",
	);
}

export async function getRecentRequests(limit = 50): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(`/stats/recent?limit=${limit}`, "Failed to fetch recent requests");
}

export async function getRecentErrors(limit = 50): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(`/stats/errors?limit=${limit}`, "Failed to fetch recent errors");
}

export async function getRequestDetails(id: number): Promise<RequestDetails> {
	return fetchJson<RequestDetails>(`/request/${id}`, "Failed to fetch request details");
}

export async function sync(): Promise<unknown> {
	return fetchJson<unknown>("/sync", "Failed to sync");
}

export async function getBehaviorDashboardStats(range = "24h"): Promise<BehaviorDashboardStats> {
	return fetchJson<BehaviorDashboardStats>(
		`/stats/behavior?range=${encodeURIComponent(range)}`,
		"Failed to fetch behavior stats",
	);
}
