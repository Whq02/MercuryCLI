
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvDefinedFalsy, getMercuryHome } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'

export const AGENT_IDENTITY_SCHEMA = 1 as const

export type CrewAgentId = string & { readonly __brand: 'CrewAgentId' }
export type CrewSessionId = string & { readonly __brand: 'CrewSessionId' }

export type ActorRefV1 =
  | { kind: 'agent'; agentId: CrewAgentId }
  | { kind: 'operator' | 'guest'; principalId: string }

export const AGENT_BINDING_KINDS = ['native', 'provider', 'adapter', 'principal'] as const
export type AgentBindingKind = (typeof AGENT_BINDING_KINDS)[number]

export const AGENT_ROLES = [
  'main',
  'party-seat',
  'workflow',
  'scribe',
  'implementer',
  'worker',
  'coordinator',
] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export interface AgentIdentityV1 {
  schema: typeof AGENT_IDENTITY_SCHEMA
  agentId: CrewAgentId
  displayName: string
  visualToken: string
  createdAt: number
  updatedAt: number
}

export interface AgentBindingV1 {
  agentId: CrewAgentId
  bindingKind: AgentBindingKind
  bindingId: string
  adapterKind?: string
  observedRevision?: string
  createdAt: number
}

export interface AgentRoleLinkV1 {
  agentId: CrewAgentId
  role: AgentRole
  ownerRef: string
  activeFrom: number
  activeUntil?: number
}

export interface AgentSessionV1 {
  schema: typeof AGENT_IDENTITY_SCHEMA
  sessionId: CrewSessionId
  agentId: CrewAgentId
  missionRef?: string
  worktreeRef?: string
  parentSessionId?: CrewSessionId
  startedAt: number
  endedAt?: number
}

export interface IdentityMigrationReceiptV1 {
  schema: typeof AGENT_IDENTITY_SCHEMA
  migratedAt: number
  sources: Record<string, number>
  notes: string[]
}

interface CrewIdentityFile {
  agents: Record<string, AgentIdentityV1>
  bindings: Record<string, AgentBindingV1>
  roles: AgentRoleLinkV1[]
  sessions: Record<string, AgentSessionV1>
  migration?: IdentityMigrationReceiptV1
}

const MAX_SESSIONS = 200
const MAX_ROLES = 500

function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

export function crewStoreRoot(dir?: string): string {
  if (dir !== undefined) return dir
  const override = flagEnv('MERCURY_CREW_DIR')
  if (override && override.trim() !== '') return override
  return join(getMercuryHome(), 'crew')
}

const crewIdentityStore = defineStore<CrewIdentityFile, [dir?: string]>({
  name: 'crew-identity',
  path: (dir?: string) => join(crewStoreRoot(dir), `${projectKey()}.json`),
  schemaVersion: AGENT_IDENTITY_SCHEMA,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<CrewIdentityFile>
    const out: CrewIdentityFile = {
      agents: {},
      bindings: {},
      roles: [],
      sessions: {},
    }
    if (r.agents && typeof r.agents === 'object' && !Array.isArray(r.agents)) {
      for (const [id, a] of Object.entries(r.agents)) {
        if (a && typeof a === 'object' && typeof (a as AgentIdentityV1).displayName === 'string') {
          out.agents[id] = a as AgentIdentityV1
        }
      }
    }
    if (r.bindings && typeof r.bindings === 'object' && !Array.isArray(r.bindings)) {
      for (const [key, b] of Object.entries(r.bindings)) {
        if (b && typeof b === 'object' && typeof (b as AgentBindingV1).agentId === 'string') {
          out.bindings[key] = b as AgentBindingV1
        }
      }
    }
    if (Array.isArray(r.roles)) {
      out.roles = r.roles.filter(
        (l): l is AgentRoleLinkV1 =>
          !!l && typeof l === 'object' && typeof l.agentId === 'string' && typeof l.role === 'string',
      )
    }
    if (r.sessions && typeof r.sessions === 'object' && !Array.isArray(r.sessions)) {
      for (const [id, s] of Object.entries(r.sessions)) {
        if (s && typeof s === 'object' && typeof (s as AgentSessionV1).agentId === 'string') {
          out.sessions[id] = s as AgentSessionV1
        }
      }
    }
    if (r.migration && typeof r.migration === 'object') {
      out.migration = r.migration as IdentityMigrationReceiptV1
    }
    return out
  },
  empty: () => ({ agents: {}, bindings: {}, roles: [], sessions: {} }),
  onReadFailure: 'empty',
})

export function crewDirectoryEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_CREW_DIRECTORY'))
}

const bindingKeyOf = (kind: AgentBindingKind, id: string): string => `${kind}:${id}`

function assertBindablePrincipal(kind: AgentBindingKind, bindingId: string): void {
  if (kind === 'principal' && !bindingId.startsWith('agent-')) {
    throw new Error(
      `crew/identity: principal binding '${bindingId}' is not an agent principal — humans stay ActorRefs, never registry rows`,
    )
  }
}

function mintAgentIdFor(bindingKind: AgentBindingKind, bindingId: string): CrewAgentId {
  const h = createHash('sha256').update(bindingKeyOf(bindingKind, bindingId)).digest('hex')
  return `cw-${h.slice(0, 12)}` as CrewAgentId
}

function visualTokenFor(agentId: CrewAgentId): string {
  const n = parseInt(agentId.slice(3, 8), 16) % 8
  return `crew-${n}`
}

export interface EnsureAgentArgs {
  displayName: string
  binding: {
    bindingKind: AgentBindingKind
    bindingId: string
    adapterKind?: string
    observedRevision?: string
  }
  visualToken?: string
  dir?: string
}

export async function ensureAgentIdentity(args: EnsureAgentArgs): Promise<AgentIdentityV1> {
  assertBindablePrincipal(args.binding.bindingKind, args.binding.bindingId)
  const store = crewIdentityStore(args.dir)
  return store.update(current => {
    const key = bindingKeyOf(args.binding.bindingKind, args.binding.bindingId)
    const bound = current.bindings[key]
    if (bound) {
      const existing = current.agents[bound.agentId]
      if (existing) return { next: current, result: existing }
      const repaired: AgentIdentityV1 = {
        schema: AGENT_IDENTITY_SCHEMA,
        agentId: bound.agentId as CrewAgentId,
        displayName: args.displayName,
        visualToken: args.visualToken ?? visualTokenFor(bound.agentId as CrewAgentId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      return {
        next: { ...current, agents: { ...current.agents, [repaired.agentId]: repaired } },
        result: repaired,
      }
    }
    const agentId = mintAgentIdFor(args.binding.bindingKind, args.binding.bindingId)
    const now = Date.now()
    const identity: AgentIdentityV1 = {
      schema: AGENT_IDENTITY_SCHEMA,
      agentId,
      displayName: args.displayName,
      visualToken: args.visualToken ?? visualTokenFor(agentId),
      createdAt: now,
      updatedAt: now,
    }
    const binding: AgentBindingV1 = {
      agentId,
      bindingKind: args.binding.bindingKind,
      bindingId: args.binding.bindingId,
      ...(args.binding.adapterKind !== undefined ? { adapterKind: args.binding.adapterKind } : {}),
      ...(args.binding.observedRevision !== undefined
        ? { observedRevision: args.binding.observedRevision }
        : {}),
      createdAt: now,
    }
    return {
      next: {
        ...current,
        agents: { ...current.agents, [agentId]: identity },
        bindings: { ...current.bindings, [key]: binding },
      },
      result: identity,
    }
  })
}

export async function resolveAgent(
  ref: string | { bindingKind: AgentBindingKind; bindingId: string },
  opts?: { dir?: string },
): Promise<CrewAgentId | null> {
  let key: string
  if (typeof ref === 'string') {
    const sep = ref.indexOf(':')
    if (sep <= 0) return null
    const kind = ref.slice(0, sep)
    if (!(AGENT_BINDING_KINDS as readonly string[]).includes(kind)) return null
    key = ref
  } else {
    key = bindingKeyOf(ref.bindingKind, ref.bindingId)
  }
  const state = await crewIdentityStore(opts?.dir).read()
  const bound = state.bindings[key]
  return bound ? (bound.agentId as CrewAgentId) : null
}

export type BindReceipt =
  | { ok: true; binding: AgentBindingV1 }
  | { ok: false; reason: 'unknown-agent' | 'bound-to-other'; boundTo?: CrewAgentId }

export async function bindAgent(
  agentId: CrewAgentId,
  binding: {
    bindingKind: AgentBindingKind
    bindingId: string
    adapterKind?: string
    observedRevision?: string
  },
  opts?: { dir?: string },
): Promise<BindReceipt> {
  assertBindablePrincipal(binding.bindingKind, binding.bindingId)
  const store = crewIdentityStore(opts?.dir)
  return store.update<BindReceipt>(current => {
    if (!current.agents[agentId]) {
      return { next: current, result: { ok: false as const, reason: 'unknown-agent' as const } }
    }
    const key = bindingKeyOf(binding.bindingKind, binding.bindingId)
    const bound = current.bindings[key]
    if (bound && bound.agentId !== agentId) {
      return {
        next: current,
        result: {
          ok: false as const,
          reason: 'bound-to-other' as const,
          boundTo: bound.agentId as CrewAgentId,
        },
      }
    }
    const record: AgentBindingV1 = {
      agentId,
      bindingKind: binding.bindingKind,
      bindingId: binding.bindingId,
      ...(binding.adapterKind !== undefined ? { adapterKind: binding.adapterKind } : {}),
      ...(binding.observedRevision !== undefined
        ? { observedRevision: binding.observedRevision }
        : {}),
      createdAt: bound?.createdAt ?? Date.now(),
    }
    return {
      next: { ...current, bindings: { ...current.bindings, [key]: record } },
      result: { ok: true as const, binding: record },
    }
  })
}

export async function renameAgent(
  agentId: CrewAgentId,
  displayName: string,
  opts?: { dir?: string },
): Promise<AgentIdentityV1 | null> {
  const store = crewIdentityStore(opts?.dir)
  return store.update<AgentIdentityV1 | null>(current => {
    const existing = current.agents[agentId]
    if (!existing) return { next: current, result: null }
    const renamed: AgentIdentityV1 = { ...existing, displayName, updatedAt: Date.now() }
    return {
      next: { ...current, agents: { ...current.agents, [agentId]: renamed } },
      result: renamed,
    }
  })
}

export async function linkAgentRole(
  agentId: CrewAgentId,
  role: AgentRole,
  ownerRef: string,
  opts?: { dir?: string },
): Promise<AgentRoleLinkV1> {
  const store = crewIdentityStore(opts?.dir)
  return store.update(current => {
    const active = current.roles.find(
      l => l.agentId === agentId && l.role === role && l.ownerRef === ownerRef && l.activeUntil === undefined,
    )
    if (active) return { next: current, result: active }
    const link: AgentRoleLinkV1 = { agentId, role, ownerRef, activeFrom: Date.now() }
    let roles = [...current.roles, link]
    if (roles.length > MAX_ROLES) {
      let toDrop = roles.length - MAX_ROLES
      const dropSet = new Set<AgentRoleLinkV1>()
      for (const l of roles) {
        if (toDrop === 0) break
        if (l.activeUntil !== undefined) {
          dropSet.add(l)
          toDrop--
        }
      }
      for (const l of roles) {
        if (toDrop === 0) break
        if (!dropSet.has(l)) {
          dropSet.add(l)
          toDrop--
        }
      }
      roles = roles.filter(l => !dropSet.has(l))
    }
    return { next: { ...current, roles }, result: link }
  })
}

export async function endAgentRole(
  agentId: CrewAgentId,
  role: AgentRole,
  ownerRef: string,
  opts?: { dir?: string },
): Promise<void> {
  const store = crewIdentityStore(opts?.dir)
  await store.mutate(current => {
    const ix = current.roles.findIndex(
      l => l.agentId === agentId && l.role === role && l.ownerRef === ownerRef && l.activeUntil === undefined,
    )
    if (ix < 0) return current
    const roles = [...current.roles]
    roles[ix] = { ...roles[ix]!, activeUntil: Date.now() }
    return { ...current, roles }
  })
}

export async function registerAgentSession(
  args: {
    sessionId: string
    agentId: CrewAgentId
    missionRef?: string
    worktreeRef?: string
    parentSessionId?: string
  },
  opts?: { dir?: string },
): Promise<AgentSessionV1> {
  const store = crewIdentityStore(opts?.dir)
  return store.update(current => {
    const existing = current.sessions[args.sessionId]
    if (existing) {
      if (existing.endedAt === undefined) return { next: current, result: existing }
      const { endedAt: _closed, ...reopened } = existing
      return {
        next: { ...current, sessions: { ...current.sessions, [args.sessionId]: reopened } },
        result: reopened,
      }
    }
    const session: AgentSessionV1 = {
      schema: AGENT_IDENTITY_SCHEMA,
      sessionId: args.sessionId as CrewSessionId,
      agentId: args.agentId,
      ...(args.missionRef !== undefined ? { missionRef: args.missionRef } : {}),
      ...(args.worktreeRef !== undefined ? { worktreeRef: args.worktreeRef } : {}),
      ...(args.parentSessionId !== undefined
        ? { parentSessionId: args.parentSessionId as CrewSessionId }
        : {}),
      startedAt: Date.now(),
    }
    const ids = Object.keys(current.sessions)
    let sessions = { ...current.sessions, [args.sessionId]: session }
    if (ids.length + 1 > MAX_SESSIONS) {
      const byAge = Object.values(sessions).sort((a, b) => a.startedAt - b.startedAt)
      let toDrop = byAge.length - MAX_SESSIONS
      const dropSet = new Set<AgentSessionV1>()
      for (const s of byAge) {
        if (toDrop === 0) break
        if (s.endedAt !== undefined) {
          dropSet.add(s)
          toDrop--
        }
      }
      for (const s of byAge) {
        if (toDrop === 0) break
        if (!dropSet.has(s)) {
          dropSet.add(s)
          toDrop--
        }
      }
      sessions = {}
      for (const s of byAge) {
        if (!dropSet.has(s)) sessions[s.sessionId] = s
      }
    }
    return { next: { ...current, sessions }, result: session }
  })
}

export async function endAgentSession(sessionId: string, opts?: { dir?: string }): Promise<void> {
  const store = crewIdentityStore(opts?.dir)
  await store.mutate(current => {
    const s = current.sessions[sessionId]
    if (!s || s.endedAt !== undefined) return current
    return {
      ...current,
      sessions: { ...current.sessions, [sessionId]: { ...s, endedAt: Date.now() } },
    }
  })
}

export async function agentOf(
  agentId: CrewAgentId,
  opts?: { dir?: string },
): Promise<AgentIdentityV1 | null> {
  const state = await crewIdentityStore(opts?.dir).read()
  return state.agents[agentId] ?? null
}

export async function listAgents(opts?: { dir?: string }): Promise<AgentIdentityV1[]> {
  const state = await crewIdentityStore(opts?.dir).read()
  return Object.values(state.agents)
}

export async function listAgentBindings(
  agentId: CrewAgentId,
  opts?: { dir?: string },
): Promise<AgentBindingV1[]> {
  const state = await crewIdentityStore(opts?.dir).read()
  return Object.values(state.bindings).filter(b => b.agentId === agentId)
}

export async function listAgentRoles(
  agentId: CrewAgentId,
  opts?: { dir?: string },
): Promise<AgentRoleLinkV1[]> {
  const state = await crewIdentityStore(opts?.dir).read()
  return state.roles.filter(l => l.agentId === agentId)
}

export async function listAgentSessions(opts?: { dir?: string }): Promise<AgentSessionV1[]> {
  const state = await crewIdentityStore(opts?.dir).read()
  return Object.values(state.sessions)
}

export function displayLabelsOf(agents: readonly AgentIdentityV1[]): Map<CrewAgentId, string> {
  const byName = new Map<string, AgentIdentityV1[]>()
  for (const a of agents) {
    const list = byName.get(a.displayName) ?? []
    list.push(a)
    byName.set(a.displayName, list)
  }
  const out = new Map<CrewAgentId, string>()
  for (const [name, list] of byName) {
    if (list.length === 1) {
      out.set(list[0]!.agentId, name)
    } else {
      for (const a of list) out.set(a.agentId, `${name} · ${a.agentId.slice(3, 7)}`)
    }
  }
  return out
}


export async function migrateLegacyIdentities(opts?: {
  dir?: string
}): Promise<IdentityMigrationReceiptV1> {
  const sources: Record<string, number> = {}
  const notes: string[] = []

  const { assistantPrincipal } = await import('../../substrate/identity/identity.js')
  const assistant = assistantPrincipal()
  const main = await ensureAgentIdentity({
    displayName: assistant.name ?? 'Mercury',
    binding: { bindingKind: 'principal', bindingId: assistant.id },
    ...(opts?.dir !== undefined ? { dir: opts.dir } : {}),
  })
  await linkAgentRole(main.agentId, 'main', 'session:main', opts)
  sources['assistant-principal'] = 1

  notes.push(
    'process-scoped operational identities (roster shorts, crew mailboxes, live subagents) bind at their own seams via ensureAgentIdentity — deliberately not swept here',
  )

  const receipt: IdentityMigrationReceiptV1 = {
    schema: AGENT_IDENTITY_SCHEMA,
    migratedAt: Date.now(),
    sources,
    notes,
  }
  await crewIdentityStore(opts?.dir).mutate(current => ({ ...current, migration: receipt }))
  return receipt
}

export async function readIdentityMigrationReceipt(opts?: {
  dir?: string
}): Promise<IdentityMigrationReceiptV1 | null> {
  const state = await crewIdentityStore(opts?.dir).read()
  return state.migration ?? null
}


let bootPromise: Promise<void> | null = null

async function refreshCrewSessionRegistration(args: {
  sessionId: string
  worktreeRef?: string
  endedSessionId?: string
}): Promise<{ agentId: CrewAgentId } | null> {
  if (!crewDirectoryEnabled()) return null
  const { assistantPrincipal } = await import('../../substrate/identity/identity.js')
  const assistant = assistantPrincipal()
  const main = await ensureAgentIdentity({
    displayName: assistant.name ?? 'Mercury',
    binding: { bindingKind: 'principal', bindingId: assistant.id },
  })
  if (args.endedSessionId !== undefined && args.endedSessionId !== args.sessionId) {
    await endAgentSession(args.endedSessionId)
  }
  await registerAgentSession({
    sessionId: args.sessionId,
    agentId: main.agentId,
    ...(args.worktreeRef !== undefined ? { worktreeRef: args.worktreeRef } : {}),
  })
  try {
    const { publishSessionDescriptor } = await import('./descriptor.js')
    await publishSessionDescriptor({
      agentId: main.agentId,
      sessionId: args.sessionId,
      ...(args.worktreeRef !== undefined ? { worktreeRef: args.worktreeRef } : {}),
    })
  } catch (e) {
    logForDebugging(`[crew/identity] descriptor publish failed (non-blocking): ${e}`)
  }
  return { agentId: main.agentId }
}

export async function bootCrewIdentity(args: {
  sessionId: string
  worktreeRef?: string
}): Promise<void> {
  if (!crewDirectoryEnabled()) return
  if (bootPromise) return bootPromise
  bootPromise = (async () => {
    const registered = await refreshCrewSessionRegistration({
      sessionId: args.sessionId,
      ...(args.worktreeRef !== undefined ? { worktreeRef: args.worktreeRef } : {}),
    })
    if (!registered) return
    const main = { agentId: registered.agentId }
    await migrateLegacyIdentities()
    try {
      const [{ rekeyOperatorRecords }, identityMod] = await Promise.all([
        import('./conversations.js'),
        import('../../substrate/identity/identity.js'),
      ])
      const moved = await rekeyOperatorRecords(
        identityMod.legacyOperatorPrincipalIds(),
        identityMod.operatorPrincipal().id,
      )
      if (moved > 0) logForDebugging(`[crew/identity] operator re-key moved ${moved} legacy-keyed positions`)
    } catch (e) {
      logForDebugging(`[crew/identity] operator re-key skipped (non-blocking): ${e}`)
    }
    try {
      const { mintConversation, MAIN_CONVERSATION_ID } = await import('./conversations.js')
      const { operatorPrincipal } = await import('../../substrate/identity/identity.js')
      await mintConversation({
        kind: 'main',
        title: 'Main session',
        participants: [
          { kind: 'operator', principalId: operatorPrincipal().id },
          { kind: 'agent', agentId: main.agentId },
        ],
        adoptId: MAIN_CONVERSATION_ID,
        sessionRefs: [args.sessionId],
      })
    } catch (e) {
      logForDebugging(`[crew/identity] main conversation mint failed (non-blocking): ${e}`)
    }
    const { registerCleanup } = await import('../../utils/cleanupRegistry.js')
    registerCleanup(async () => endAgentSession(args.sessionId))
  })().catch(e => {
    logForDebugging(`[crew/identity] boot registration failed (non-blocking, will retry on next boot call): ${e}`)
    bootPromise = null
  })
  return bootPromise
}

export function subscribeCrewIdentity(cb: () => void, opts?: { dir?: string }): () => void {
  return crewIdentityStore(opts?.dir).subscribe(() => cb(), { immediate: false })
}

export function _resetCrewIdentityBootForTesting(): void {
  bootPromise = null
}


export async function __identityLawsForProof(): Promise<{
  renamePreservesId: boolean
  sameNameDistinct: boolean
  reconnectNoDuplicate: boolean
  displayNeverRoutes: boolean
}> {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-lawprobe-')))
  const a = await ensureAgentIdentity({
    displayName: 'Atlas',
    binding: { bindingKind: 'adapter', bindingId: 'probe-seat-1', adapterKind: 'opencode' },
    dir,
  })
  const renamed = await renameAgent(a.agentId, 'Atlas Prime', { dir })
  const b = await ensureAgentIdentity({
    displayName: 'Atlas',
    binding: { bindingKind: 'adapter', bindingId: 'probe-seat-2', adapterKind: 'codex' },
    dir,
  })
  const reconnect = await ensureAgentIdentity({
    displayName: 'Atlas Prime',
    binding: { bindingKind: 'adapter', bindingId: 'probe-seat-1', adapterKind: 'opencode' },
    dir,
  })
  const byBinding = await resolveAgent('adapter:probe-seat-1', { dir })
  const byBareName = await resolveAgent('Atlas', { dir })
  const byNameShapedBinding = await resolveAgent('native:Atlas', { dir })
  return {
    renamePreservesId: renamed !== null && renamed.agentId === a.agentId,
    sameNameDistinct: b.agentId !== a.agentId,
    reconnectNoDuplicate: reconnect.agentId === a.agentId,
    displayNeverRoutes: byBinding === a.agentId && byBareName === null && byNameShapedBinding === null,
  }
}
