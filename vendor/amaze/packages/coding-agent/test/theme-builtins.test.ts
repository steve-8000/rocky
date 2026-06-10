import { describe, expect, it } from "bun:test";
import {
	getAvailableThemes,
	getResolvedThemeColors,
	getThemeByName,
	getThemeExportColors,
} from "@amaze/coding-agent/modes/theme/theme";
import eridThemeJson from "../src/modes/theme/defaults/erid.json" with { type: "json" };

describe("built-in themes", () => {
	it("includes the erid theme in the built-in roster", async () => {
		const themes = await getAvailableThemes();
		expect(themes).toContain("erid");
	});

	it("keeps erid semantic roles on named palette variables", () => {
		const vars = new Set(Object.keys(eridThemeJson.vars));
		const checkedSections = { colors: eridThemeJson.colors, export: eridThemeJson.export };
		const inlineHexRefs: string[] = [];
		const unknownVarRefs: string[] = [];

		for (const [sectionName, section] of Object.entries(checkedSections)) {
			for (const [key, value] of Object.entries(section)) {
				if (typeof value !== "string" || value === "") continue;
				if (value.startsWith("#")) {
					inlineHexRefs.push(`${sectionName}.${key}`);
				} else if (!vars.has(value)) {
					unknownVarRefs.push(`${sectionName}.${key}:${value}`);
				}
			}
		}

		expect(inlineHexRefs).toEqual([]);
		expect(unknownVarRefs).toEqual([]);
	});

	it("uses language-specific file icons without the Rust crab emoji", async () => {
		const theme = await getThemeByName("erid");
		expect(theme).toBeDefined();
		if (!theme) throw new Error("Expected erid theme instance");

		expect(theme.getLangIcon("typescript")).toBe("TS");
		expect(theme.getLangIcon("rust")).toBe("rs");
		expect(theme.getLangIcon("json")).toBe("{}");
		expect(theme.getLangIcon("toml")).toBe("⚙");
	});

	it("loads erid with the expected Rocky-inspired palette and updated branding symbols", async () => {
		const theme = await getThemeByName("erid");
		expect(theme).toBeDefined();
		if (!theme) throw new Error("Expected erid theme instance");

		const colors = await getResolvedThemeColors("erid");
		expect(colors.accent).toBe("#6CC7D8");
		expect(colors.statusLineModel).toBe("#D9A24B");
		expect(colors.statusLineSubagents).toBe("#8ED9E8");
		expect(colors.userMessageBg).toBe("#121821");
		expect(colors.border).toBe("#465770");
		expect(colors.borderMuted).toBe("#263243");
		expect(colors.muted).toBe("#8A96A6");
		expect(colors.dim).toBe("#5A6575");
		expect(colors.toolOutput).toBe("#8A96A6");
		expect(colors.toolSuccessBg).toBe("#121821");
		expect(colors.toolErrorBg).toBe("#121821");
		expect(colors.toolSuccessBg).toBe(colors.toolErrorBg);

		expect(theme.icon.pi).toBe("✦");
		expect(theme.icon.model).toBe("◈");
		expect(theme.thinking.high).toBe("◕ deep");
		expect(theme.thinking.xhigh).toBe("◉ max");

		const exportColors = await getThemeExportColors("erid");
		expect(exportColors.pageBg).toBe("#091017");
		expect(exportColors.cardBg).toBe("#121821");
		expect(exportColors.infoBg).toBe("#18212D");
	});
});
