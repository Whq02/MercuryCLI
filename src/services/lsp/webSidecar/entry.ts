// mercury-web sidecar entry — stdio bootstrap for `mercury --lsp-web-sidecar`
// (routed in entrypoints/cli.tsx) and for direct proof runs
// (`bun run src/services/lsp/webSidecar/entry.ts` from scripts/language-sidecars).
//
// Deliberately tiny and harness-free, mirroring tsSidecar/entry.ts: streams +
// the sidecar. Debug lines go to stderr only when MERCURY_LSP_DEBUG is truthy.

import { runWebLspSidecar } from './sidecar.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'

export async function runWebLspSidecarEntry(): Promise<never> {
  const debug =
    flagEnv('MERCURY_LSP_DEBUG') === '1' || flagEnv('MERCURY_LSP_DEBUG') === 'true'
  const code = await runWebLspSidecar(process.stdin, process.stdout, {
    log: debug ? line => process.stderr.write(`[mercury-web] ${line}\n`) : undefined,
  })
  process.exit(code)
}

// Direct execution (bun run …/entry.ts) — the cli.tsx route calls
// runWebLspSidecarEntry() itself, so this only fires for standalone runs.
const directArg = process.argv[1] ?? ''
if (
  directArg.endsWith('webSidecar/entry.ts') ||
  directArg.endsWith('webSidecar/entry.js')
) {
  void runWebLspSidecarEntry()
}
