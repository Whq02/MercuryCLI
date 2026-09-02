import { logForDebugging } from '../utils/debug.js'
import { flagEnv } from '../substrate/flagRegistry.js'

export const SEAT_RECON_ALLOW: readonly string[] = [
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git rev-parse:*)',
  'Bash(git blame:*)',
  'Bash(ls:*)',
  'Bash(rg:*)',
  'Bash(grep:*)',
  'Bash(wc:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(echo:*)',
  'Bash(pwd)',
  'Bash(which:*)',
]

export function isValidReconAllowRule(rule: string): boolean {
  if (!/^[A-Z][A-Za-z0-9_]*\([^()]{1,200}\)$/.test(rule)) return false
  const spec = rule.slice(rule.indexOf('(') + 1, -1).trim()
  return spec !== '*' && spec !== ':*' && spec.length > 0
}

export function resolveWorkerReconAllow(): readonly string[] {
  const raw = (flagEnv('MERCURY_WORKER_RECON_ALLOW') ?? '').trim()
  if (!raw) return SEAT_RECON_ALLOW
  if (raw === '0') return []
  const extras: string[] = []
  for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    if (isValidReconAllowRule(part)) {
      extras.push(part)
    } else {
      logForDebugging(
        `[daemon] MERCURY_WORKER_RECON_ALLOW entry ${JSON.stringify(part)} is not a Tool(specifier) rule — dropped (bare tool names and wildcard specifiers are refused)`,
      )
    }
  }
  return [...SEAT_RECON_ALLOW, ...extras]
}
