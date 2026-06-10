/**
 * Bash output redaction bridge.
 *
 * The executor can run without a session, so callers may pass the active
 * SecretObfuscator when available; absent obfuscators keep chunks verbatim.
 */

import type { SecretObfuscator } from "../secrets/obfuscator";

export interface BashOutputRedactorOptions {
	obfuscator?: SecretObfuscator | { obfuscateText?: (text: string) => string; obfuscate?: (text: string) => string };
}

export function redactBashChunk(chunk: string, opts: BashOutputRedactorOptions): string {
	const obfuscator = opts.obfuscator;
	if (!obfuscator) return chunk;
	const candidate = obfuscator as { obfuscateText?: (text: string) => string; obfuscate?: (text: string) => string };
	if (typeof candidate.obfuscateText === "function") return candidate.obfuscateText(chunk);
	if (typeof candidate.obfuscate === "function") return candidate.obfuscate(chunk);
	return chunk;
}
