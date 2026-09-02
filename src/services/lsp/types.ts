import type { z } from 'zod/v4'
import type { LspServerConfigSchema } from './schema.js'

/**
 * Configuration for a single LSP server.
 *
 * This is the validated shape produced by {@link LspServerConfigSchema}
 * (`src/services/lsp/schema.ts`, the one schema every server source shares —
 * the operator's MERCURY_LSP_SERVERS JSON, the built-in lanes, an extension's
 * `contributes.language`). Deriving the type from the schema keeps it
 * byte-for-byte in lockstep with validation — the same pattern
 * `McpServerConfig` uses for `McpServerConfigSchema`.
 *
 * Fields (per the schema):
 * - `command`            — executable to spawn (required, no spaces unless absolute).
 * - `args?`              — argv passed to the server.
 * - `extensionToLanguage`— file-extension → LSP language-id map (required, ≥1 entry);
 *                          file extensions and languages are derived from this.
 * - `transport`          — 'stdio' | 'socket' (defaults to 'stdio').
 * - `env?`               — environment variables for the spawned process.
 * - `initializationOptions?` — server-specific `initialize` options (opaque).
 * - `settings?`          — server settings for `workspace/didChangeConfiguration` (opaque).
 * - `workspaceFolder?`   — workspace root to initialize the server with.
 * - `startupTimeout?`    — ms to wait for `initialize` before failing.
 * - `shutdownTimeout?`   — ms to wait for the graceful shutdown/exit handshake
 *                          before the child is force-killed (default 2000).
 * - `restartOnCrash?`    — whether a crashed server may lazily restart on next
 *                          use (default true; `false` ⇒ once crashed, requests
 *                          refuse with a named error until an explicit restart).
 * - `maxRestarts?`       — cap on (re)start attempts before giving up.
 */
export type LspServerConfig = z.infer<ReturnType<typeof LspServerConfigSchema>>

/**
 * An {@link LspServerConfig} after scoping.
 *
 * A scoped config carries the identity of whatever source provided it. An
 * extension's language servers arrive already named `ext:<name>:<server>`
 * with `source` = the extension's name; Mercury's own lanes stamp their own
 * source names.
 * - `scope`  — always `'dynamic'` (mirroring `ScopedMcpServerConfig.scope`).
 * - `source` — the providing source's name.
 */
export type ScopedLspServerConfig = LspServerConfig & {
  /** Config scope for dynamically provided servers — always `'dynamic'`. */
  scope: 'dynamic'
  /** Name of the source that provided this server. */
  source: string
}

/**
 * Lifecycle state of a single LSP server instance.
 *
 * State-machine transitions (see `createLSPServerInstance`):
 * - `stopped`  → `starting` → `running`
 * - `running`  → `stopping` → `stopped`
 * - any        → `error`    (on failure)
 * - `error`    → `starting` (on retry)
 */
export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'
