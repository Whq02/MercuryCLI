
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

const directArg = process.argv[1] ?? ''
if (
  directArg.endsWith('webSidecar/entry.ts') ||
  directArg.endsWith('webSidecar/entry.js')
) {
  void runWebLspSidecarEntry()
}
