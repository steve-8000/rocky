Searches X/Twitter through xAI's built-in x_search Responses API tool.

<instruction>
- Use `x_search` for current X posts, account-specific X information, or direct status URL lookups.
- Use `allowed_x_handles` when the answer must come from specific X accounts. Do not combine allowed and excluded handles.
- Set `return_full_text` when the complete original post text matters.
- Use `x_search_deep` when a long post must be reconstructed, when `x_search` returns a truncation marker, or when chunked retrieval is safer than a summarized answer.
- Prefer a direct X status URL for `x_search_deep` so count and chunk requests target one exact post.
</instruction>
