
import { credentialEnvNames } from '../../../models/sign-in/account-ledger/providerSecrets.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

const SECRET_SUFFIX = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/i

const EXTRA_DENY = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'])

export function isDeniedKernelEnvName(name: string): boolean {
  if (EXTRA_DENY.has(name)) return true
  if (credentialEnvNames().includes(name)) return true
  if (name.startsWith('OTEL_')) return true
  return SECRET_SUFFIX.test(name)
}

export function buildKernelEnv(base: NodeJS.ProcessEnv = hostEnv()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (isDeniedKernelEnvName(name)) continue
    out[name] = value
  }
  out.PYTHONUNBUFFERED = '1'
  out.MPLBACKEND = 'Agg'
  out.MERCURY_EVAL_KERNEL = '1'
  return out
}
