# Mercury ACP (Agent Client Protocol) integration

Mercury exposes its session machinery through the stable Agent Client
Protocol (v1) — SDK `@agentclientprotocol/sdk` 1.4.0 (Apache-2.0), stable
surface only. The exact supported profile is the capability matrix below.

## Entry point

```
mercury acp --stdio
```

stdout is the protocol channel (NDJSON JSON-RPC); diagnostics ride stderr.
Each ACP session maps 1:1 onto a real Mercury session (same transcripts,
same resume, same permission machinery). `session/load` resumes an existing
Mercury session by reading its transcript: the conversation it already holds
crosses as session updates before the response (the protocol's replay rule),
and nothing re-runs — a reconnect never replays a prompt or re-runs a tool.
Closing an ACP session reaps only its own work.

## Client configuration example (Zed)

```json
{
  "agent_servers": {
    "Mercury": {
      "command": "mercury",
      "args": ["acp", "--stdio"]
    }
  }
}
```

Any ACP v1 client works the same way: launch the command, speak NDJSON
JSON-RPC over stdio. The VS Code extension in `integrations/vscode` is one
such client.

## Capability matrix (as implemented)

| Surface | Status |
|---|---|
| initialize (v1 negotiation; `agentInfo` name + version; `mcpCapabilities` http + sse; `sessionCapabilities.list`) | yes |
| session/new · session/list · session/load (resume with replay) · session/close | yes |
| session/new · session/load `mcpServers` (stdio · http · sse) | yes — carried into the session as its own MCP config; an unsupported shape is named on stderr |
| session/prompt (text · resource_link · embedded resource · image) | yes (content lands in the composer document — the one input vocabulary) |
| session/prompt stop reasons | end_turn · max_tokens · refusal (the model's own) · max_turn_requests · cancelled; a failed turn is a JSON-RPC error naming the cause |
| session/cancel (interrupt) | yes |
| session/update: agent_message_chunk · agent_thought_chunk | yes |
| session/update: tool_call (`kind` · `locations` · `diff` content for Edit/Write) · tool_call_update (status + bounded text output) | yes |
| session/update: plan (the task owner's rows, id-ordered) | yes |
| session/update: usage_update (context occupancy + window + cost) | yes |
| session/update: current_mode_update · config_option_update | yes |
| session/update on load: user_message_chunk · agent_message_chunk · agent_thought_chunk · tool_call · tool_call_update | yes (the transcript, in order) |
| session/request_permission (adapts Mercury's can_use_tool; the tool_call's diff content is the preview) | yes |
| session/set_mode (default · implement · strategy · flow; retired external spellings decode at the boundary) | yes |
| session/set_config_option (`permission-mode` selector, category `mode`) | yes |
| _mercury/editor_context (client → agent notification: active file, selection, open files, diagnostics, workspace roots — rides the next prompt as an attached resource) | yes (extension notification) |
| _mercury/workbench (incl. the versioned attention + relationship wire) · _mercury/artifacts · _mercury/artifact · _mercury/crew · _mercury/run | yes (extension methods — the VS Code bridge's read surface) |
| fs/terminal client capabilities | not used (Mercury executes locally) |
| available_commands_update (slash commands) | not implemented |

Conformance: `scripts/editor-bridge/prove-acp-server.ts` (deterministic fixture
model, zero paid calls) drives the server end to end;
`scripts/editor-bridge/prove-acp-tool-wire.ts` pins the pure wire shapes.
