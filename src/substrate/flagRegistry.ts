import { flagReadsOff } from './flagOff.js'
import type { FlagSpec } from './flags/spec.js'

export type { FlagKind, FlagSpec, FlagTier } from './flags/spec.js'

function createFlagStore(): {
  registry: readonly FlagSpec[]
  get: (env: string) => FlagSpec | undefined
} {
  const loaders: ReadonlyArray<() => readonly FlagSpec[]> = [
    () => (require('./flags/session.js') as typeof import('./flags/session.js')).SESSION_FLAGS,
    () => (require('./flags/boot.js') as typeof import('./flags/boot.js')).BOOT_FLAGS,
    () => (require('./flags/accounts.js') as typeof import('./flags/accounts.js')).ACCOUNTS_FLAGS,
    () => (require('./flags/api.js') as typeof import('./flags/api.js')).API_FLAGS,
    () => (require('./flags/cockpit.js') as typeof import('./flags/cockpit.js')).COCKPIT_FLAGS,
    () => (require('./flags/context.js') as typeof import('./flags/context.js')).CONTEXT_FLAGS,
    () => (require('./flags/daemon.js') as typeof import('./flags/daemon.js')).DAEMON_FLAGS,
    () => (require('./flags/desktop.js') as typeof import('./flags/desktop.js')).DESKTOP_FLAGS,
    () => (require('./flags/health.js') as typeof import('./flags/health.js')).HEALTH_FLAGS,
    () => (require('./flags/ide.js') as typeof import('./flags/ide.js')).IDE_FLAGS,
    () => (require('./flags/mcp.js') as typeof import('./flags/mcp.js')).MCP_FLAGS,
    () => (require('./flags/model.js') as typeof import('./flags/model.js')).MODEL_FLAGS,
    () => (require('./flags/permissions.js') as typeof import('./flags/permissions.js')).PERMISSIONS_FLAGS,
    () => (require('./flags/project.js') as typeof import('./flags/project.js')).PROJECT_FLAGS,
    () => (require('./flags/proofs.js') as typeof import('./flags/proofs.js')).PROOFS_FLAGS,
    () => (require('./flags/providers.js') as typeof import('./flags/providers.js')).PROVIDERS_FLAGS,
    () => (require('./flags/screen.js') as typeof import('./flags/screen.js')).SCREEN_FLAGS,
    () => (require('./flags/tools.js') as typeof import('./flags/tools.js')).TOOLS_FLAGS,
  ]
  const map = new Map<string, FlagSpec>()
  let nextLoader = 0
  let materialized = false
  const backing: FlagSpec[] = []

  const loadNext = (): void => {
    const rows = loaders[nextLoader++]!()
    for (const f of rows) map.set(f.env, f)
  }

  const ensureAll = (): FlagSpec[] => {
    if (!materialized) {
      materialized = true
      while (nextLoader < loaders.length) loadNext()
      const rows = Array.from(map.values()).sort((a, b) => (a.env < b.env ? -1 : a.env > b.env ? 1 : 0))
      backing.push(...rows)
    }
    return backing
  }

  const get = (env: string): FlagSpec | undefined => {
    const hit = map.get(env)
    if (hit !== undefined) return hit
    while (nextLoader < loaders.length) {
      loadNext()
      const found = map.get(env)
      if (found !== undefined) return found
    }
    return undefined
  }

  const registry: readonly FlagSpec[] = new Proxy(backing, {
    get(target, prop, receiver) {
      ensureAll()
      return Reflect.get(target, prop, receiver)
    },
    has(target, prop) {
      ensureAll()
      return Reflect.has(target, prop)
    },
    ownKeys(target) {
      ensureAll()
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, prop) {
      ensureAll()
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
  })

  return { registry, get }
}

const byEnv = createFlagStore()

export const FLAG_REGISTRY: readonly FlagSpec[] = byEnv.registry

export function getFlagSpec(env: string): FlagSpec | undefined {
  return byEnv.get(env)
}

export function flagEnv(env: string, ...from: [] | [Readonly<Record<string, string | undefined>>]): string | undefined {
  const spec = byEnv.get(env)
  if (!spec) throw new Error(`flagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)
  if (from.length > 0) return from[0] === undefined ? undefined : from[0][spec.env]
  return process.env[spec.env]
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

export function stampFlagEnv(name: string, value: string): void {
  stampFlagOnEnv(process.env, name, value)
}

export function flagPair(name: string, value: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spelling of flagSpellings(name)) out[spelling] = value
  return out
}
