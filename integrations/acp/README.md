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
Mercury session by reading its transcript — a reconnect never replays a
prompt or re-runs a tool. Closing an ACP session reaps only its own work.

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
JSON-RPC over stdio.

## Capability matrix (as implemented)

| Surface | Status |
|---|---|
| initialize (v1 negotiation) | yes |
| session/new · session/list · session/load (resume) · session/close | yes |
| session/prompt (text · resource_link · embedded resource · image) | yes (content lands in ComposerDocumentV2 — the one input vocabulary) |
| session/cancel (interrupt) | yes |
| session/update: agent_message_chunk · tool_call · tool_call_update | yes |
| session/update: plan (the task owner's rows, id-ordered) | yes |
| session/update: usage_update (context occupancy + window + cost) | yes |
| session/update: current_mode_update · config_option_update | yes |
| session/request_permission (adapts Mercury's can_use_tool) | yes |
| session/set_mode (default · implement · strategy · flow; retired external spellings decode at the boundary) | yes |
| session/set_config_option (`permission-mode` selector, category `mode`) | yes |
| _mercury/workbench (incl. the versioned attention + relationship wire) · _mercury/artifacts · _mercury/artifact | yes (extension methods — the VS Code bridge's read surface) |
| fs/terminal client capabilities | not used (Mercury executes locally) |

Conformance: `scripts/editor-bridge/prove-acp-server.ts` (deterministic fixture
model, zero paid calls).
