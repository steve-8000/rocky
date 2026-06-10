import { describe, expect, it } from "vitest";

import { extractGithubRefs, normalizeGithubRemote, parseGithubRef } from "./github-refs";

const httpsRemote = "https://github.com/getrocky/rocky.git";
const sshRemote = "git@github.com:getrocky/rocky.git";

describe("normalizeGithubRemote", () => {
  it.each([
    ["https://github.com/getrocky/rocky", { owner: "getrocky", repo: "rocky", host: "github.com" }],
    [
      "https://github.com/getrocky/rocky.git",
      { owner: "getrocky", repo: "rocky", host: "github.com" },
    ],
    ["git@github.com:getrocky/rocky.git", { owner: "getrocky", repo: "rocky", host: "github.com" }],
    [
      "ssh://git@github.com/getrocky/rocky.git",
      { owner: "getrocky", repo: "rocky", host: "github.com" },
    ],
  ])("extracts GitHub identity from %s", (remoteUrl, expected) => {
    expect(normalizeGithubRemote(remoteUrl)).toEqual(expected);
  });

  it("returns null for non-GitHub remotes and empty input", () => {
    expect(normalizeGithubRemote("git@gitlab.com:getrocky/rocky.git")).toBeNull();
    expect(normalizeGithubRemote(null)).toBeNull();
  });
});

describe("parseGithubRef", () => {
  it.each([
    "https://github.com/getrocky/rocky/pull/994",
    "https://github.com/getrocky/rocky/pull/994/",
    "https://github.com/getrocky/rocky/pull/994/files",
    "https://github.com/getrocky/rocky/pull/994?diff=split",
    "https://github.com/getrocky/rocky/pull/994#discussion_r123",
  ])("parses a matching pull request URL: %s", (text) => {
    expect(parseGithubRef(text, httpsRemote)).toEqual({
      kind: "pull",
      number: 994,
      owner: "getrocky",
      repo: "rocky",
      url: "https://github.com/getrocky/rocky/pull/994",
    });
  });

  it("parses a matching issue URL", () => {
    expect(parseGithubRef("https://github.com/getrocky/rocky/issues/456", httpsRemote)).toEqual({
      kind: "issues",
      number: 456,
      owner: "getrocky",
      repo: "rocky",
      url: "https://github.com/getrocky/rocky/issues/456",
    });
  });

  it("matches HTTPS pasted URLs against an SSH remote", () => {
    expect(parseGithubRef("https://github.com/getrocky/rocky/pull/994", sshRemote)).toEqual({
      kind: "pull",
      number: 994,
      owner: "getrocky",
      repo: "rocky",
      url: "https://github.com/getrocky/rocky/pull/994",
    });
  });

  it("ignores URLs for another owner or repo", () => {
    expect(parseGithubRef("https://github.com/other/rocky/pull/994", httpsRemote)).toBeNull();
    expect(parseGithubRef("https://github.com/getrocky/other/pull/994", httpsRemote)).toBeNull();
  });

  it("returns null for non-GitHub remotes and empty text", () => {
    expect(
      parseGithubRef(
        "https://github.com/getrocky/rocky/pull/994",
        "git@gitlab.com:getrocky/rocky.git",
      ),
    ).toBeNull();
    expect(parseGithubRef("", httpsRemote)).toBeNull();
    expect(parseGithubRef("https://github.com/getrocky/rocky/pull/994", null)).toBeNull();
  });

  it("finds URLs embedded in text and markdown links", () => {
    expect(
      parseGithubRef(
        "See:\n[the PR](https://github.com/getrocky/rocky/pull/994/files).",
        httpsRemote,
      ),
    ).toEqual({
      kind: "pull",
      number: 994,
      owner: "getrocky",
      repo: "rocky",
      url: "https://github.com/getrocky/rocky/pull/994",
    });
  });
});

describe("extractGithubRefs", () => {
  it("returns every matching ref deduped by kind and number", () => {
    const text = [
      "https://github.com/getrocky/rocky/pull/994",
      "https://github.com/getrocky/rocky/issues/456#issuecomment-1",
      "https://github.com/getrocky/rocky/pull/994/files",
      "https://github.com/other/rocky/issues/1",
    ].join("\n");

    expect(extractGithubRefs(text, httpsRemote)).toEqual([
      {
        kind: "pull",
        number: 994,
        owner: "getrocky",
        repo: "rocky",
        url: "https://github.com/getrocky/rocky/pull/994",
      },
      {
        kind: "issues",
        number: 456,
        owner: "getrocky",
        repo: "rocky",
        url: "https://github.com/getrocky/rocky/issues/456",
      },
    ]);
  });

  it("returns an empty array for empty text or null remote", () => {
    expect(extractGithubRefs("", httpsRemote)).toEqual([]);
    expect(extractGithubRefs("https://github.com/getrocky/rocky/pull/994", null)).toEqual([]);
  });
});
