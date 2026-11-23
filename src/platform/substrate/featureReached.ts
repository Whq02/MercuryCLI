import { appendFileSync } from 'node:fs'
import { flagEnv } from './flagRegistry.js'

export function featureReached(kind: 'command' | 'verb' | 'screen' | 'tool', name: string): void {
  const file = flagEnv('MERCURY_FEATURE_TRACE')
  if (!file) return
  const proof = flagEnv('MERCURY_FEATURE_TRACE_PROOF') || process.argv[1]
  if (!proof || /[\t\r\n]/.test(name) || /[\t\r\n]/.test(proof)) return
  const how = import.meta.url.endsWith('.ts') ? 'source' : process.stdout.isTTY ? 'terminal' : 'bundle'
  try {
    appendFileSync(file, `${kind}\t${name}\t${how}\t${proof}\n`)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error)) throw error
  }
}
