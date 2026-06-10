import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance } from "@amaze/coding-agent/modes/theme/theme";
import { WelcomeComponent } from "../src/modes/components/welcome";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

const LOGO_CHAR_PATTERN = /█/;

function extractLogoRows(rendered: string): string[] {
	return rendered
		.split("\n")
		.map(line => {
			const stripped = stripAnsi(line);
			if (!LOGO_CHAR_PATTERN.test(stripped)) return "";
			const firstBorder = stripped.indexOf("│");
			const lastBorder = stripped.lastIndexOf("│");
			const content =
				firstBorder >= 0 && lastBorder > firstBorder ? stripped.slice(firstBorder + 1, lastBorder) : stripped;
			return content.trim();
		})
		.filter(line => LOGO_CHAR_PATTERN.test(line));
}

beforeAll(async () => {
	const theme = await getThemeByName("erid");
	if (!theme) throw new Error("Failed to load erid theme for welcome branding tests");
	setThemeInstance(theme);
});

describe("welcome branding", () => {
	it("renders the Erid welcome title and planet-oriented copy", () => {
		const component = new WelcomeComponent("1.2.3", "Grok 4.3", "xai", [], []);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).toContain("AMAZE CLI · ERID ORBITAL INTERFACE · v1.2.3");
		expect(rendered).toContain("Erid in view");
		expect(rendered).toContain("Flight controls");
		expect(rendered).not.toContain("Welcome back!");
		expect(rendered).not.toContain("LSP Servers");
		expect(rendered).not.toContain("No LSP servers");
	});

	it("renders LSP servers only when startup servers exist", () => {
		const component = new WelcomeComponent(
			"1.2.3",
			"Grok 4.3",
			"xai",
			[],
			[{ name: "typescript-language-server", status: "ready", fileTypes: ["ts", "tsx", "js"] }],
		);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).toContain("LSP Servers");
		expect(rendered).toContain("typescript-language-server");
		expect(rendered).toContain("ts tsx js");
		expect(rendered).not.toContain("No LSP servers");
	});

	it("renders the Erid startup planet logo as a round disk", () => {
		const component = new WelcomeComponent("1.2.3", "Grok 4.3", "xai", [], []);
		const rendered = component.render(36).join("\n");

		const logoRows = extractLogoRows(rendered);
		expect(logoRows).toEqual([
			"████████",
			"████████████",
			"██████████████",
			"████████████████",
			"████████████████",
			"██████████████",
			"████████████",
			"████████",
		]);
		expect(Math.max(...logoRows.map(row => [...row].length))).toBe(logoRows.length * 2);
	});
});
