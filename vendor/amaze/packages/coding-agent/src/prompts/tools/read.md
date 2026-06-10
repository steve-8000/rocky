Read files, directories, archives, SQLite, images, documents, internal URIs, and web URLs through a single `path`.

<instruction>
- You SHOULD parallelize independent reads when exploring related files.
- You SHOULD reach for `read` — not a browser tool — for fetching web content.
</instruction>

## Parameters

- `path` — required. Exactly one local path, internal URI, or URL per call. Append `:<sel>` for line ranges, raw mode, or special modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).

## Selectors

Append `:<sel>` to `path`. Bare path falls back to the default mode.

- _(none)_ — parseable code → structural summary; other files → start of file (up to {{DEFAULT_LIMIT}} lines).
- `:50` / `:50-` — from line 50 onward.
- `:50-200` — lines 50–200 inclusive.
- `:50+150` — 150 lines starting at line 50.
- `:5-16,960-973` — multiple ranges in one call (sorted, overlaps merged).
- `:raw` — verbatim text; no anchors, no summary, no line prefixes.
- `:2-4:raw` / `:raw:2-4` — range + verbatim, composable in either order.
- `:conflicts` — index of every unresolved git merge conflict.

## Files

- Directory path → depth-limited dirent listing.
{{#if IS_HL_MODE}}
- File + selector → lines prefixed with `line+hash` anchors: `41th|def alpha():`. The 2-char hash is a content fingerprint that `edit` / `apply_patch` consume — copy verbatim, NEVER fabricate. The `|` is a separator, not file content.
{{else}}{{#if IS_LINE_NUMBER_MODE}}
- File + selector → lines prefixed with line numbers: `41|def alpha():`.
{{/if}}{{/if}}
- Parseable code without a selector → **structural summary** (declarations kept, bodies collapsed to `..` / `…`). Footer names the exact selector to recover an elided body — re-issue it verbatim; NEVER guess what's inside the markers.

## Other modes

- **Documents** (`.pdf`/`.doc`/`.docx`/`.ppt`/`.pptx`/`.xls`/`.xlsx`/`.rtf`/`.epub`): extracted to markdown.
- **Notebooks** (`.ipynb`): editable `# %% [type] cell:N` text; edits round-trip to JSON. `:raw` reads the raw JSON.
- **Images**: metadata only (mime, bytes, dimensions). For visual analysis call `inspect_image`.
- **Archives** (`.tar`/`.tar.gz`/`.tgz`/`.zip`): `archive.ext:path/inside[:lines]`.
- **SQLite** (`.sqlite`/`.sqlite3`/`.db`/`.db3`): `file.db` lists tables; `:table` schema+samples; `:table:key` single row; `:table?limit=&offset=&where=&order=` filtered; `?q=SELECT…` raw query.
- **URLs**: reader-mode by default (HTML/PR/issue/SO/wiki/RSS/JSON/PDF → markdown). `:raw` returns raw HTML; line selectors paginate cached output. For `host:port` URLs add a trailing slash before the selector: `https://example.com/:80`.
- **Internal URIs** (`skill://`, `agent://`, `artifact://`, `rule://`, `local://`, `mcp://`): same selectors as filesystem paths. `artifact://<id>` recovers truncated tool output.

<critical>
- You MUST use `read` for every file/dir/archive/URL inspection. `cat`, `head`, `tail`, `less`, `more`, `ls`, `tar`, `unzip`, `curl`, `wget` are FORBIDDEN.
- You MUST always include `path`. NEVER call `read` with `{}`.
- For line ranges, append the selector to `path` (e.g. `"src/foo.ts:50-200"`). NEVER substitute `sed -n`, `awk NR`, or `head`/`tail` pipelines.
- `read` accepts exactly one target per call. Semicolon/comma/newline-separated path lists are invalid; one call per target.
- Summary footer says `read <path>:raw …`? Re-issue the exact selector. NEVER guess what's inside `..` / `…` markers.
</critical>
