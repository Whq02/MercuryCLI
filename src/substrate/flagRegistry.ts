import { flagReadsOff } from './flagOff.js'
import { ACCOUNTS_FLAGS } from './flags/accounts.js'
import { API_FLAGS } from './flags/api.js'
import { BOOT_FLAGS } from './flags/boot.js'
import { COCKPIT_FLAGS } from './flags/cockpit.js'
import { CONTEXT_FLAGS } from './flags/context.js'
import { DAEMON_FLAGS } from './flags/daemon.js'
import { DESKTOP_FLAGS } from './flags/desktop.js'
import { HEALTH_FLAGS } from './flags/health.js'
import { IDE_FLAGS } from './flags/ide.js'
import { MCP_FLAGS } from './flags/mcp.js'
import { MODEL_FLAGS } from './flags/model.js'
import { PERMISSIONS_FLAGS } from './flags/permissions.js'
import { PROJECT_FLAGS } from './flags/project.js'
import { PROOFS_FLAGS } from './flags/proofs.js'
import { PROVIDERS_FLAGS } from './flags/providers.js'
import { SCREEN_FLAGS } from './flags/screen.js'
import { SESSION_FLAGS } from './flags/session.js'
import { TOOLS_FLAGS } from './flags/tools.js'
import type { FlagSpec } from './flags/spec.js'

export type { FlagKind, FlagSpec, FlagTier } from './flags/spec.js'

export const FLAG_REGISTRY: readonly FlagSpec[] = [
  ...ACCOUNTS_FLAGS,
  ...API_FLAGS,
  ...BOOT_FLAGS,
  ...COCKPIT_FLAGS,
  ...CONTEXT_FLAGS,
  ...DAEMON_FLAGS,
  ...DESKTOP_FLAGS,
  ...HEALTH_FLAGS,
  ...IDE_FLAGS,
  ...MCP_FLAGS,
  ...MODEL_FLAGS,
  ...PERMISSIONS_FLAGS,
  ...PROJECT_FLAGS,
  ...PROOFS_FLAGS,
  ...PROVIDERS_FLAGS,
  ...SCREEN_FLAGS,
  ...SESSION_FLAGS,
  ...TOOLS_FLAGS,
].sort((a, b) => (a.env < b.env ? -1 : a.env > b.env ? 1 : 0))

const byEnv = new Map<string, FlagSpec>()
for (const f of FLAG_REGISTRY) byEnv.set(f.env, f)

export function getFlagSpec(env: string): FlagSpec | undefined {
  return byEnv.get(env)
}

export function flagEnv(env: string): string | undefined {
  const spec = byEnv.get(env)
  if (!spec) throw new Error(`flagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)
  return process.env[spec.env]
}

export function flagEnvLoose(env: string): string | undefined {
  return byEnv.has(env) ? flagEnv(env) : process.env[env]
}

export function flagEnabled(env: string): boolean {
  const spec = byEnv.get(env)
  if (!spec) throw new Error(`flagEnabled: unregistered flag ${env} — add it to FLAG_REGISTRY`)
  switch (spec.kind) {
    case 'default-on':
      return !flagReadsOff(flagEnv(spec.env))
    case 'opt-in':
      return flagEnv(spec.env) === '1'
    default:
      throw new Error(`flagEnabled: ${env} is a ${spec.kind} flag — read its value at its consumer`)
  }
}

const selfWritten = new Map<string, string>()

export function setFlagEnv(env: string, value: string): void {
  const spec = byEnv.get(env)
  if (!spec) throw new Error(`setFlagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)
  process.env[spec.env] = value
  selfWritten.set(spec.env, value)
}

export function deleteFlagEnv(env: string): void {
  const spec = byEnv.get(env)
  if (!spec) throw new Error(`deleteFlagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)
  for (const spelling of flagSpellings(env)) delete process.env[spelling]
  selfWritten.delete(spec.env)
}

export function selfWrittenFlagEnv(): ReadonlyMap<string, string> {
  return selfWritten
}

export function flagSpellings(env: string): string[] {
  const spec = byEnv.get(env)
  if (!spec) throw new Error(`flagSpellings: unregistered flag ${env} — add it to FLAG_REGISTRY`)
  return [spec.env]
}

export function stampFlagOnEnv(
  env: Record<string, string | undefined>,
  name: string,
  value: string,
): void {
  for (const spelling of flagSpellings(name)) env[spelling] = value
}

export function flagPair(name: string, value: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spelling of flagSpellings(name)) out[spelling] = value
  return out
}
