import { describe, expect, test } from "bun:test";
import { GATES } from "./release-gate";

describe("release-gate", () => {
	const gateCommands = GATES.map((gate) => gate.cmd.join(" "));

	test("includes release-delta security and advisory gates", () => {
		expect(gateCommands).toContain("bun run security:unicode");
		expect(gateCommands).toContain("bun run security:ioc");
		expect(gateCommands).toContain("bun run security:doctor");
		expect(gateCommands).toContain("bun run check-spoofed-versions");
	});

	test("only spoofed-version drift is advisory", () => {
		const advisoryCommands = GATES.filter((gate) => gate.advisory).map((gate) => gate.cmd.join(" "));

		expect(advisoryCommands).toEqual(["bun run check-spoofed-versions"]);
	});
});
