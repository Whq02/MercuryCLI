// ============================================================================
//  services/eval/kernelEnv — the filtered environment kernels are born with.
//
//  The denylist DERIVES from the secrets owner's enumeration
//  (providerSecrets.credentialEnvNames — one owner per fact), widened by a
//  generic secret-suffix pattern so an unenumerated credential still errs
//  toward absence. Cells that genuinely need a secret read it through a
//  re-entered tool call under the permission floor, never from ambient env.
// ============================================================================

import { credentialEnvNames } from '../../utils/router/providerSecrets.js'

/** Generic secret-shaped suffixes stripped even when unenumerated. The
 *  filter errs toward absence: a var a cell legitimately needs can be
 *  passed explicitly by the operator through cell code, not ambiently. */
const SECRET_SUFFIX = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/i

/** Well-known credential names that dodge the suffix pattern. */
const EXTRA_DENY = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'])

/** True when this env NAME must not reach a kernel. */
export function isDeniedKernelEnvName(name: string): boolean {
  if (EXTRA_DENY.has(name)) return true
  if (credentialEnvNames().includes(name)) return true
  // The OTLP header variables are specified to carry bearer credentials,
  // and kernels never need exporter configuration — the whole family stays
  // out (the subprocessEnv precedent).
  if (name.startsWith('OTEL_')) return true
  return SECRET_SUFFIX.test(name)
}

/**
 * The environment a kernel process is spawned with: the host env minus
 * every denied name, plus the kernel's own operating pins (unbuffered
 * Python, an off-screen matplotlib backend, a kernel marker).
 */
export function buildKernelEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
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
