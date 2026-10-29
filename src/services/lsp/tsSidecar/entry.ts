
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

const directArg = process.argv[1] ?? ''
if (
  directArg.endsWith('tsSidecar/entry.ts') ||
  directArg.endsWith('tsSidecar/entry.js')
) {
  void runLspSidecarEntry()
}
