// mercury-ts sidecar entry — stdio bootstrap for `mercury --lsp-ts-sidecar`
// (routed in entrypoints/cli.tsx) and for direct proof runs
// (`bun run src/services/lsp/tsSidecar/entry.ts` from scripts/lsp).
//
// Deliberately tiny and harness-free: streams + the sidecar. Debug lines go
// to stderr only when MERCURY_LSP_DEBUG is truthy (stderr is captured by the
// host's LSPClient logging, never mixed into the protocol stream on stdout).

import { runTsLspSidecar } from './sidecar.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'

export async function runLspSidecarEntry(): Promise<never> {
  const debug =
    flagEnv('MERCURY_LSP_DEBUG') === '1' || flagEnv('MERCURY_LSP_DEBUG') === 'true'
  const code = await runTsLspSidecar(process.stdin, process.stdout, {
    log: debug ? line => process.stderr.write(`[mercury-ts] ${line}\n`) : undefined,
  })
  process.exit(code)
}

// Direct execution (bun run …/entry.ts) — the cli.tsx route calls
// runLspSidecarEntry() itself, so this only fires for standalone runs.
const directArg = process.argv[1] ?? ''
if (
  directArg.endsWith('tsSidecar/entry.ts') ||
  directArg.endsWith('tsSidecar/entry.js')
) {
  void runLspSidecarEntry()
}
