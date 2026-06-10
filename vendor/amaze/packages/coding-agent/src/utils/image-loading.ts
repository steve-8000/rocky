import * as fs from "node:fs/promises";
import type { ImageContent } from "@amaze/ai";
import { formatBytes, parseImageMetadata, readImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "@amaze/utils";
import type { ClientBridge } from "../session/client-bridge";
import { resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, resizeImage } from "./image-resize";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_INPUT_IMAGE_MIME_TYPES = SUPPORTED_IMAGE_MIME_TYPES;

export interface LoadImageInputOptions {
	path: string;
	cwd: string;
	autoResize: boolean;
	maxBytes?: number;
	resolvedPath?: string;
	detectedMimeType?: string;
	clientBridge?: ClientBridge;
}

export interface LoadedImageInput {
	resolvedPath: string;
	mimeType: string;
	data: string;
	textNote: string;
	dimensionNote?: string;
	bytes: number;
}

export class ImageInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Image file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "ImageInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

export async function ensureSupportedImageInput(image: ImageContent): Promise<ImageContent | null> {
	if (SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) {
		return image;
	}
	try {
		const bytes = Buffer.from(image.data, "base64");
		const data = await new Bun.Image(bytes).png().toBase64();
		return { type: "image", data, mimeType: "image/png" };
	} catch {
		return null;
	}
}

function clientReadPath(filePath: string, resolvedPath: string): string {
	if (!filePath.includes("\\") || resolvedPath !== filePath) return resolvedPath;
	return filePath.replace(/\\([ \t"'(){}[\]])/g, "$1");
}

async function loadLocalImageInput(
	options: LoadImageInputOptions,
	resolvedPath: string,
	maxBytes: number,
): Promise<LoadedImageInput | null> {
	const metadata = options.detectedMimeType
		? { mimeType: options.detectedMimeType }
		: await readImageMetadata(resolvedPath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) return null;

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	if (inputBuffer.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	return normalizeLoadedImageInput({ resolvedPath, inputBuffer, mimeType, autoResize: options.autoResize });
}

async function loadBridgeImageInput(
	options: LoadImageInputOptions,
	resolvedPath: string,
	maxBytes: number,
): Promise<LoadedImageInput | null> {
	const clientBridge = options.clientBridge;
	if (!clientBridge?.capabilities.readBinaryFile || !clientBridge.readBinaryFile) return null;

	const result = await clientBridge.readBinaryFile({ path: clientReadPath(options.path, resolvedPath), maxBytes });
	const inputBuffer = Buffer.from(result.dataBase64, "base64");
	if (inputBuffer.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	const metadata = parseImageMetadata(inputBuffer);
	if (!metadata?.mimeType) return null;

	return normalizeLoadedImageInput({
		resolvedPath,
		inputBuffer,
		mimeType: metadata.mimeType,
		autoResize: options.autoResize,
	});
}

async function normalizeLoadedImageInput(input: {
	resolvedPath: string;
	inputBuffer: Buffer;
	mimeType: string;
	autoResize: boolean;
}): Promise<LoadedImageInput> {
	const { resolvedPath, inputBuffer, mimeType } = input;
	let outputData = Buffer.from(inputBuffer).toBase64();
	let outputMimeType = mimeType;
	let outputBytes = inputBuffer.byteLength;
	let dimensionNote: string | undefined;
	if (input.autoResize) {
		try {
			const resized = await resizeImage({ type: "image", data: outputData, mimeType });
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} catch {
			// keep original image when resize fails
		}
	}

	let textNote = `Read image file [${outputMimeType}]`;
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}

export async function loadImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);

	try {
		const local = await loadLocalImageInput(options, resolvedPath, maxBytes);
		if (local) return local;
	} catch (err) {
		if (err instanceof ImageInputTooLargeError) throw err;
		// fall back to an explicit client-side read when the server path is absent or not readable
	}

	return loadBridgeImageInput(options, resolvedPath, maxBytes);
}
