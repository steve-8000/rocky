import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { LocalProtocolHandler, resolveLocalUrlToPath } from "../internal-urls/local-protocol";

function resolveLocalArtifactPath(uri: string): string {
	if (!uri.startsWith("local://")) {
		throw new Error(`Artifact hash requires a local:// URI: ${uri}`);
	}
	const options = LocalProtocolHandler.resolveOptions();
	if (!options) {
		throw new Error(`Artifact hash cannot resolve local:// URI without local protocol options: ${uri}`);
	}
	const filePath = resolveLocalUrlToPath(uri, options);
	if (!existsSync(filePath)) {
		throw new Error(`Artifact hash file is missing for ${uri}`);
	}
	return filePath;
}

export function computeArtifactSha256HexSync(uri: string): string {
	const buffer = readFileSync(resolveLocalArtifactPath(uri));
	return createHash("sha256").update(buffer).digest("hex");
}

export async function computeArtifactSha256Hex(uri: string): Promise<string> {
	const filePath = resolveLocalArtifactPath(uri);
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		throw new Error(`Artifact hash file is missing for ${uri}`);
	}
	const buffer = await file.arrayBuffer();
	return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}
