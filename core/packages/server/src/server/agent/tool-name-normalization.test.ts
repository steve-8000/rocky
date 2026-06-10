import { describe, expect, it } from "vitest";

import { getRockyToolLeafName, isRockyToolName } from "@getrocky/protocol/tool-name-normalization";

describe("isRockyToolName", () => {
  it("detects Claude Code format", () => {
    expect(isRockyToolName("mcp__rocky__create_agent")).toBe(true);
    expect(isRockyToolName("mcp__rocky__list_agents")).toBe(true);
  });

  it("detects rocky_voice variant", () => {
    expect(isRockyToolName("mcp__rocky_voice__create_agent")).toBe(true);
    expect(isRockyToolName("rocky_voice.create_agent")).toBe(true);
  });

  it("excludes speak tools", () => {
    expect(isRockyToolName("mcp__rocky_voice__speak")).toBe(false);
    expect(isRockyToolName("mcp__rocky__speak")).toBe(false);
    expect(isRockyToolName("rocky.speak")).toBe(false);
  });

  it("detects Codex dot format", () => {
    expect(isRockyToolName("rocky.create_agent")).toBe(true);
  });

  it("rejects non-rocky tools", () => {
    expect(isRockyToolName("Bash")).toBe(false);
    expect(isRockyToolName("Read")).toBe(false);
    expect(isRockyToolName("mcp__other_server__some_tool")).toBe(false);
  });
});

describe("getRockyToolLeafName", () => {
  it("extracts leaf from Claude Code format", () => {
    expect(getRockyToolLeafName("mcp__rocky__create_agent")).toBe("create_agent");
  });

  it("extracts leaf from Codex format", () => {
    expect(getRockyToolLeafName("rocky.create_agent")).toBe("create_agent");
    expect(getRockyToolLeafName("rocky.list_agents")).toBe("list_agents");
  });

  it("returns null for non-rocky tools", () => {
    expect(getRockyToolLeafName("Bash")).toBeNull();
  });
});
