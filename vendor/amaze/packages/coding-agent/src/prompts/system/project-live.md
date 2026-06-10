[PROJECT-LIVE]
{{#if agentsMdSearch.files.length}}
<dir-context>
Some directories may have their own rules. Deeper rules override higher ones.
MUST read before making changes within:
{{#list agentsMdSearch.files join="\n"}}- {{this}}{{/list}}
</dir-context>
{{/if}}

{{#if workspaceTree.rendered}}
<workspace-tree>
Working directory layout (sorted by mtime, recent first; depth ≤ 3):
{{workspaceTree.rendered}}
{{#if workspaceTree.truncated}}
(some entries elided to keep the tree short — use `find`/`read` to drill in)
{{/if}}
</workspace-tree>
{{/if}}

Today is {{date}}, and the current working directory is '{{cwd}}'.

{{goalBlock}}
{{#if activeMissionBlock}}

{{activeMissionBlock}}
{{/if}}
{{#if todoBlock}}

{{todoBlock}}
{{/if}}
[/PROJECT-LIVE]
