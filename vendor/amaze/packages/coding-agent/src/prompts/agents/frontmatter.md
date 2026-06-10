---

name: {{jsonStringify name}}
description: {{jsonStringify description}}
{{#if tools}}tools: {{jsonStringify tools}}
{{/if}}
{{#if spawns}}spawns: {{jsonStringify spawns}}
{{/if}}{{#if model}}model: {{jsonStringify model}}
{{/if}}{{#if thinkingLevel}}thinking-level: {{jsonStringify thinkingLevel}}
{{/if}}{{#if blocking}}blocking: true
{{/if}}---
{{body}}
