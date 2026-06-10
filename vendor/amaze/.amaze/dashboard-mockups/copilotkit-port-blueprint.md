# CopilotKit UI Port Blueprint for Amaze Dashboard

## 1. Product direction

Amaze Dashboard should be CopilotKit React V2 chat UI reused unchanged, wrapped by an Amaze shell that exposes mission, subagent, verification, checkpoint, and runtime state from the Amaze runtime.

## 2. CopilotKit components to reuse unchanged

Reuse the CopilotKit React V2 UIUX as-is; do not redesign or fork chat, thread rail, input, messages, suggestions, popup/sidebar, or tool rendering. Import from `@copilotkit/react-core/v2` and load V2 CSS from `@copilotkit/react-core/v2/styles.css` or, when working against source, `@copilotkit/react-ui/src/v2/styles.css`.

Exact components and APIs to keep as the CopilotKit-owned UI surface:

- `CopilotKitProvider` for runtime wiring, tool renderers, frontend tools, suggestions, and provider-level configuration.
- `CopilotChat` as the primary embedded chat surface.
- `CopilotChatView` only when the dashboard shell needs lower-level placement while preserving CopilotKit internals.
- `CopilotSidebarView` and `CopilotPopupView` for sidebar/popup layouts without replacing their internals.
- `CopilotChatInput` unchanged for text entry, attachments, transcription state, submit behavior, and tool menu affordances.
- `CopilotChatMessageView` unchanged for message layout and streaming/cursor behavior.
- `CopilotChatToolCallsView` unchanged for default tool-call display, with Amaze renderers registered through CopilotKit renderer APIs rather than replacing the view.
- `CopilotChatSuggestionView` unchanged for suggestion display.
- `useThreads` for CopilotKit thread listing/selection if the dashboard exposes a thread rail.
- `defineToolCallRenderer` for Amaze mission/subagent/checkpoint/verification tool cards.
- `useConfigureSuggestions` for contextual Amaze suggestions such as “show current mission”, “open verification evidence”, or “summarize subagent contracts”.
- `useFrontendTool` for browser-side dashboard actions such as selecting a mission, focusing a panel, or opening a checkpoint diff.

Theming rule: only map Amaze tokens into CopilotKit-supported CSS variables/slots needed for Amaze surfaces. Do not create a custom futuristic dashboard clone and do not restyle CopilotKit internals beyond token/slot integration required for visual fit.

## 3. Amaze-only components to build

Build only the surfaces that represent Amaze runtime state or dashboard shell layout:

- `AmazeDashboardApp`: route entry for `amaze dashboard` / `bun run dev -- dashboard`, responsible for bootstrapping the web app and runtime adapter.
- `AmazeShell`: dashboard layout that places CopilotKit chat unchanged beside Amaze-owned panels.
- `MissionControlPanel`: read-only/live view over MissionRuntime/MissionStore state, mission phases, plan/proposal state, and current deterministic verification status.
- `SubagentOrchestraPanel`: visualizes MissionTaskDispatcher/MissionTaskRunner activity, subagent contracts, task assignment, completion, failure, blocked/escalated states, and active tool handoffs.
- `VerificationReviewPanel`: shows verification records, runtime critic results, review findings, failed/uncertain counts, and evidence references.
- `CheckpointPanel`: shows rollback/checkpoint snapshots and safe restore context without owning mutation policy.
- `RuntimeStatusPanel`: shows AgentSession state, RPC connection, active model/session metadata, queue/running/aborted state, and health warnings.
- `AmazeToolRenderers`: `defineToolCallRenderer` registrations for mission, subagent, verification, checkpoint, and runtime-status tool calls.
- `AmazeFrontendTools`: `useFrontendTool` registrations for dashboard-local UI actions only; mutations still go through Amaze runtime policy and deterministic verification.

These components are adjacent shell panels or CopilotKit generative UI/tool renderers. They are not replacements for CopilotKit chat UI.

## 4. Runtime adapter shape

Amaze remains the source of truth. CopilotKit is the presentation/runtime bridge for chat and renderers, not the authority for mission state.

High-level adapter:

- Command entry:
  - `amaze dashboard` starts the dashboard server and opens the local app.
  - `bun run dev -- dashboard` runs the same dashboard route in development.
- HTTP endpoints:
  - `POST /api/copilotkit` bridges CopilotKit chat requests to an `AgentSession` or RPC-backed session.
  - `GET /api/amaze/session` returns session metadata and current runtime status.
  - `GET /api/amaze/missions` lists MissionStore missions.
  - `GET /api/amaze/missions/:missionId` returns MissionRuntime/MissionStore mission detail.
  - `GET /api/amaze/missions/:missionId/events` returns historical mission events.
  - `GET /api/amaze/subagents` returns current MissionTaskDispatcher/MissionTaskRunner task and subagent state.
  - `GET /api/amaze/verification` returns deterministic verification/review/checkpoint summaries.
- Streaming events:
  - `GET /api/amaze/events` as SSE or WebSocket stream.
  - Emits `AgentSession` events and extension/session events including `mission_updated`.
  - Emits MissionRuntime/MissionStore event types such as `mission.created`, `mission.planned`, `mission.task.created`, `mission.task.completed`, `mission.task.failed`, `mission.tool.requested`, `mission.tool.completed`, `mission.evidence.added`, `mission.critic.completed`, `mission.verification.completed`, `mission.phase.declared`, `mission.phase.verified`, `mission.phase.closed`, `mission.completed`, `mission.blocked`, `mission.cancelled`, and rollback/checkpoint events.
- Adapter responsibilities:
  - Normalize runtime state into dashboard view models.
  - Keep `AgentSession`, MissionRuntime/MissionStore, MissionTaskDispatcher/MissionTaskRunner, subagent contracts, RPC mode, and deterministic verification as the authoritative sources.
  - Register CopilotKit tool renderers and frontend tools that call adapter endpoints.
  - Never treat CopilotKit Cloud/Intelligence as mission truth.

## 5. UI composition example

```tsx
"use client";

import {
  CopilotChat,
  CopilotKitProvider,
  defineToolCallRenderer,
  useConfigureSuggestions,
  useFrontendTool,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";

function AmazeDashboard() {
  const renderMission = defineToolCallRenderer({
    name: "amaze_mission_status",
    render: ({ args, status }) => (
      <MissionControlPanel missionId={args.missionId} toolStatus={status} compact />
    ),
  });

  return (
    <CopilotKitProvider
      runtimeUrl="/api/copilotkit"
      renderToolCalls={[renderMission]}
      properties={{ product: "amaze-dashboard" }}
    >
      <AmazeShell>
        <AmazeShell.Main>
          <CopilotChat agentId="amaze" className="h-full" />
        </AmazeShell.Main>

        <AmazeShell.Sidebar>
          <MissionControlPanel />
          <SubagentOrchestraPanel />
          <VerificationReviewPanel />
          <CheckpointPanel />
          <RuntimeStatusPanel />
        </AmazeShell.Sidebar>
      </AmazeShell>
    </CopilotKitProvider>
  );
}

function AmazeDashboardBindings() {
  useConfigureSuggestions({
    instructions:
      "Suggest Amaze dashboard actions grounded in the current mission, verification state, and active subagent contracts.",
  });

  useFrontendTool({
    name: "selectMission",
    description: "Select a mission in the Amaze dashboard shell.",
    parameters: [{ name: "missionId", type: "string", required: true }],
    handler: ({ missionId }) => selectMissionInShell(missionId),
  });

  return null;
}
```

This composition keeps CopilotKit internals intact: `CopilotChat` owns chat, input, messages, suggestions, tool-call display, and streaming presentation; `AmazeShell` only adds adjacent runtime panels and renderer-backed mission cards.

## 6. Non-goals

- No custom futuristic dashboard clone.
- No replacing CopilotKit UI.
- No redesigning CopilotKit chat, thread rail, input, messages, suggestions, popup/sidebar, or tool rendering.
- No using CopilotKit Cloud/Intelligence as the source of truth for Amaze mission or runtime state.
- No rewriting Amaze runtime, MissionRuntime/MissionStore, AgentSession, RPC mode, MissionTaskDispatcher/MissionTaskRunner, subagent contracts, or deterministic verification.
- No parallel chat component library.
- No dashboard-only mutation path that bypasses existing policy, verification, or checkpoint behavior.

## 7. Acceptance criteria for first implementation slice

- `amaze dashboard` and `bun run dev -- dashboard` launch a local dashboard route.
- The route imports `@copilotkit/react-core/v2/styles.css` and renders `CopilotKitProvider` with `CopilotChat` unchanged.
- The first shell layout places `CopilotChat` in the main pane and at least one Amaze-owned adjacent panel, starting with `MissionControlPanel` or `RuntimeStatusPanel`.
- The CopilotKit UI components named in this blueprint remain imported/reused rather than reimplemented or restyled as custom clones.
- The adapter exposes a CopilotKit runtime endpoint and a separate Amaze runtime-state endpoint backed by `AgentSession` plus MissionRuntime/MissionStore or RPC state.
- The dashboard consumes live `mission_updated` or mission event stream updates and reflects them in an Amaze-owned panel.
- At least one `defineToolCallRenderer` renders an Amaze mission/subagent/verification card inside CopilotKit tool rendering without replacing `CopilotChatToolCallsView`.
- The implementation includes a guardrail test or focused manual verification that proves CopilotKit chat still renders with V2 CSS and Amaze mission/runtime state appears only in adjacent panels or renderer slots.
