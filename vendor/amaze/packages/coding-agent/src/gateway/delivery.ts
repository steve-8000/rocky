import type { GatewayAdapter, GatewayEditTarget, GatewaySendResult, GatewaySource } from "./types";

const PLATFORM_LIMITS = {
	telegram: 4096,
	discord: 2000,
} as const;

export function splitGatewayText(text: string, platform: keyof typeof PLATFORM_LIMITS): string[] {
	const limit = PLATFORM_LIMITS[platform];
	const normalized = text.length > 0 ? text : " ";
	if (normalized.length <= limit) return [normalized];
	const chunks: string[] = [];
	let remaining = normalized;
	while (remaining.length > limit) {
		let cut = remaining.lastIndexOf("\n", limit);
		if (cut < Math.floor(limit * 0.5)) cut = remaining.lastIndexOf(" ", limit);
		if (cut < Math.floor(limit * 0.5)) cut = limit;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut).trimStart();
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

export async function deliverGatewayText(
	adapter: GatewayAdapter,
	source: GatewaySource,
	text: string,
	options: { editTarget?: GatewayEditTarget; replyToMessageId?: string } = {},
): Promise<GatewaySendResult | undefined> {
	const chunks = splitGatewayText(text, source.platform);
	let first: GatewaySendResult | undefined;
	if (options.editTarget && adapter.edit && chunks.length === 1) {
		return adapter.edit(options.editTarget, chunks[0]);
	}
	for (const [index, chunk] of chunks.entries()) {
		const sent = await adapter.send(source, chunk, {
			replyToMessageId: index === 0 ? options.replyToMessageId : undefined,
			threadId: source.threadId,
		});
		first ??= sent;
	}
	return first;
}
