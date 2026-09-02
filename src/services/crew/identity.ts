// ============================================================================
//  crew/identity — the canonical agent-identity owner.
//
//  One durable versioned registry answering "which teammate is this?" for
//  native, workflow and externally attached agents. The M0 census
//  verdict: no existing owner is a
//  registry — the Principal is an envelope author stamp, the branded
//  types/ids.ts AgentId is a per-session subagent handle, roster rows
//  are process-scoped operational state. So this module is the SMALLEST
//  versioned owner, and every existing identity form binds INTO it:
//
//    binding 'principal'  — Caduceus agent principals (`agent-…`; operator/
//                           guest principals are HUMAN actors and NEVER
//                           become registry rows — ActorRefV1 carries them);
//    binding 'native'     — seat:<name> · roster:<short> · crew:<name> ·
//                           subagent:<branded id> (bound only when the
//                           subagent occupies a durable seat/role);
//    binding 'provider'   — provider-native session/agent identities;
//    binding 'adapter'    — external seats (codex/opencode/goose/…),
//                           keyed by the adapter's own stable id.
//
//  LAWS (proved by scripts/session-graph/prove-identity.ts; the repro lane
//  holds to them):
//    · CrewAgentId survives rename, restart, reconnect and session resume —
//      ids are content-derived from the FOUNDING binding (deterministic:
//      re-migration of the same legacy record can never mint a second id);
//    · display text is NEVER a routing key — resolveAgent() accepts binding
//      refs only, and two agents sharing one visible name stay distinct
//      (displayLabelsOf disambiguates for presentation);
//    · a binding maps to exactly ONE agent — bindAgent() refuses an alias
//      that would silently merge two agents (conflict receipt, no write);
//    · roles/topology are separate links, not identity: one agent may hold
//      several role links over time without becoming several agents;
//    · sessions link to agents; a deliberately new session gets a new
//      CrewSessionId but the same stable agent;
//    · legacy records migrate deterministically with an explicit receipt;
//      there is no permanent dual write — the legacy stores stay what they
//      are (operational state), and THIS registry is the identity truth.
//
//  Storage: one substrate fileStore per project (atomic publish, locking,
//  revisions, quarantine-on-corruption) under <config-home>/crew/. Proof
//  isolation rides the explicit `dir` seam (proof-hygiene: scratch-explicit
//  roots, never the calibration machine).
// ============================================================================

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

/** The canonical durable teammate id (`cw-<12hex>`, founding-binding-derived). */
export type CrewAgentId = string & { readonly __brand: 'CrewAgentId' }
/** One agent session (a lifecycle-scoped run of an agent). */
export type CrewSessionId = string & { readonly __brand: 'CrewSessionId' }

/** Who did something — humans stay principals, agents ride the registry. */
export type ActorRefV1 =
  | { kind: 'agent'; agentId: CrewAgentId }
  | { kind: 'operator' | 'guest'; principalId: string }

export const AGENT_BINDING_KINDS = ['native', 'provider', 'adapter', 'principal'] as const
export type AgentBindingKind = (typeof AGENT_BINDING_KINDS)[number]

export const AGENT_ROLES = [
  'main',
  // Written by the retired router party's seat sweep; kept so records that
  // carry it still read as their kind (recognition, never minted again).
  'party-seat',
  'workflow',
  // Written by the retired two-seat coordination estate; kept on the same
  // terms as 'party-seat' — old records still read, nothing mints them.
  'scribe',
  'implementer',
  'worker',
  // the ONE global Concourse coordinator seat.
  'coordinator',
] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export interface AgentIdentityV1 {
  schema: typeof AGENT_IDENTITY_SCHEMA
  agentId: CrewAgentId
  /** Presentation label — mutable, NEVER routed on. */
  displayName: string
  /** Stable glyph/accent key for renderers (derived at mint, mutable). */
  visualToken: string
  createdAt: number
  updatedAt: number
}

export interface AgentBindingV1 {
  agentId: CrewAgentId
  bindingKind: AgentBindingKind
  /** The bound system's OWN stable id (principal id, seat name, adapter
   *  session id …) — the routing key underneath readable labels. */
  bindingId: string
  adapterKind?: string
  observedRevision?: string
  createdAt: number
}

export interface AgentRoleLinkV1 {
  agentId: CrewAgentId
  role: AgentRole
  /** The owning surface's ref for the seat/topology slot. */
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
  /** Per-source row counts actually migrated (0 = source present but empty
   *  or source store absent — honest either way, named in `notes`). */
  sources: Record<string, number>
  notes: string[]
}

interface CrewIdentityFile {
  agents: Record<string, AgentIdentityV1>
  /** `${bindingKind}:${bindingId}` → agentId, plus the binding record. */
  bindings: Record<string, AgentBindingV1>
  roles: AgentRoleLinkV1[]
  sessions: Record<string, AgentSessionV1>
  migration?: IdentityMigrationReceiptV1
}

/** Bounded records: sessions/roles beyond the cap drop OLDEST-first. */
const MAX_SESSIONS = 200
const MAX_ROLES = 500

function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

/** The crew stores' ONE root resolution: an explicit dir wins; then the
 *  registered MERCURY_CREW_DIR override (the render/capture hermeticity seam
 *  — a PTY capture must never read or write the operator's real crew world;
 *  read LIVE per call, the authority-toggle law); then the config home.
 *  Every crew-family store (identity · conversations · descriptors ·
 *  receipts · staged refinements) rides this. */
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

/** The crew-directory gate (MERCURY_CREW_DIRECTORY in flagRegistry.ts,
 *  default-on; distinct from MERCURY_CREW, the crewSpawn/teammates kill). */
export function crewDirectoryEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_CREW_DIRECTORY'))
}

const bindingKeyOf = (kind: AgentBindingKind, id: string): string => `${kind}:${id}`

/**
 * Only an AGENT principal may bind into the registry — operator/guest
 * principals are canonical HUMAN actors (ActorRefV1 carries them) and a
 * human must never become addressable as a teammate row.
 */
function assertBindablePrincipal(kind: AgentBindingKind, bindingId: string): void {
  if (kind === 'principal' && !bindingId.startsWith('agent-')) {
    throw new Error(
      `crew/identity: principal binding '${bindingId}' is not an agent principal — humans stay ActorRefs, never registry rows`,
    )
  }
}

/** Founding-binding-derived id — deterministic, so re-migration of the same
 *  legacy record (or a reconnect racing a mint) converges on ONE agent. */
function mintAgentIdFor(bindingKind: AgentBindingKind, bindingId: string): CrewAgentId {
  const h = createHash('sha256').update(bindingKeyOf(bindingKind, bindingId)).digest('hex')
  return `cw-${h.slice(0, 12)}` as CrewAgentId
}

/** Derive a stable glyph/accent token from the agent id (renderers map it). */
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
  /** Proof seam — an explicit scratch root; production omits it. */
  dir?: string
}

/**
 * Resolve-or-mint by binding. Idempotent: the same binding always lands on
 * the same agent (existing row wins; the display name of an existing agent
 * is NOT overwritten — rename is an explicit verb).
 */
export async function ensureAgentIdentity(args: EnsureAgentArgs): Promise<AgentIdentityV1> {
  assertBindablePrincipal(args.binding.bindingKind, args.binding.bindingId)
  const store = crewIdentityStore(args.dir)
  return store.update(current => {
    const key = bindingKeyOf(args.binding.bindingKind, args.binding.bindingId)
    const bound = current.bindings[key]
    if (bound) {
      const existing = current.agents[bound.agentId]
      if (existing) return { next: current, result: existing }
      // A binding without its agent row is repairable damage: re-mint the row.
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

/**
 * THE one resolver. Accepts a binding ref — `{bindingKind, bindingId}` or the
 * string form `kind:id` — and returns the canonical agent, or null. Display
 * names deliberately do NOT resolve: text is presentation, never routing.
 */
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

/**
 * Add a binding to an existing agent. REFUSES an alias that would merge two
 * agents: a binding already held by a different agent is a conflict receipt,
 * never a silent rebind.
 */
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

/** Rename is label-only: the id, bindings, roles and sessions are untouched. */
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

/** Open a role/topology link (idempotent for an identical active link). */
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
      // Evict CLOSED links first (oldest first) — an ACTIVE topology link is
      // a live registry fact and drops only when no closed victim remains.
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

/** Close an active role link (no-op when none is open). */
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

/** Register (idempotently, by sessionId) one agent session. */
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
      // Re-registering an ENDED session is a resume — the session is running
      // again, so the record re-opens (startedAt and lineage preserved).
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
      // Evict ENDED sessions first (oldest first) — an OPEN session is a live
      // registry fact and drops only when no ended victim remains.
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

/** Close a session (no-op when unknown or already ended). */
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

/**
 * Collision-safe presentation labels (PURE): duplicate display names get a
 * short id suffix so two `Atlas` rows never read as one teammate. Routing
 * never touches these — they are for eyes only.
 */
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

// ── migration ────────────────────────────────────────────────────────

/**
 * Deterministic legacy → canonical migration. Sources (bounded reads of the
 * DURABLE legacy stores; process-scoped operational state binds live at its
 * own seams instead — the M0 adjudication):
 *   · the assistant principal (`agent-mercury`) → the main Mercury agent.
 * Idempotent by construction (founding-binding-derived ids + ensure
 * semantics); the receipt records what was actually read.
 */
export async function migrateLegacyIdentities(opts?: {
  dir?: string
}): Promise<IdentityMigrationReceiptV1> {
  const sources: Record<string, number> = {}
  const notes: string[] = []

  // 1. The assistant principal — every Mercury install has exactly one.
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

// ── the production boot seam ─────────────────────────────────────────────────

let bootPromise: Promise<void> | null = null

/**
 * Interactive-session boot (REPL mount): ensure the main Mercury identity,
 * register THIS session against it, run the legacy sweep (idempotent by
 * construction — every boot re-sweeps; the receipt records the latest
 * sweep), and close this session's record at graceful shutdown.
 * Fire-and-forget; boot never blocks on it; a failed boot resets the latch
 * so a later call can retry.
 */
/**
 * Register a session id against the main Mercury agent identity and publish
 * its descriptor — the re-runnable core bootCrewIdentity wraps once at boot.
 * A session's runner holds ONE session id for its whole life (a resume
 * continues the same id; /clear starts another runner), so the registration
 * runs once per process. When a previous id is on record, that row ends
 * here — idempotently (a re-end is a no-op; a re-registered ended row
 * re-opens as a resume by the registerAgentSession law). Returns null when
 * the crew directory is disabled.
 */
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
  // The out-of-band session descriptor: metadata only, coalesced
  // + revisioned — the cockpit, session list and editor wire all read it.
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
    // The one-shot operator re-key (ledger L27): conversation participants,
    // event actors and read-cursor keys minted under a LEGACY operator id
    // move to the keyed id BEFORE the main-conversation mint reads them.
    // Idempotent and cheap once clean; failure is non-blocking (the adoption
    // law still recognizes legacy-keyed records until the next boot retries).
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
    // The project's MAIN conversation (M5): one stable thread identity per
    // project — every surface (cockpit board, Console, editors) adopts the
    // same declared id, so read cursors and lineage agree cross-surface.
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
    // 'Open' keeps meaning open: this session's record closes with the REPL.
    const { registerCleanup } = await import('../../utils/cleanupRegistry.js')
    registerCleanup(async () => endAgentSession(args.sessionId))
  })().catch(e => {
    logForDebugging(`[crew/identity] boot registration failed (non-blocking, will retry on next boot call): ${e}`)
    bootPromise = null
  })
  return bootPromise
}

/** Subscription seam (single-owner store discipline: the handle stays
 *  module-internal; consumers observe changes, never write directly). */
export function subscribeCrewIdentity(cb: () => void, opts?: { dir?: string }): () => void {
  return crewIdentityStore(opts?.dir).subscribe(() => cb(), { immediate: false })
}

/** Test seam — resets the boot latch (never product-read). */
export function _resetCrewIdentityBootForTesting(): void {
  bootPromise = null
}

// ── the law probe (repro-identity's pin — runs in an OWN scratch root) ───────

/**
 * Exercise the identity laws in a throwaway store and report which hold.
 * Proof-hygiene: the probe never touches the real config home — it mints its
 * own mkdtemp root per call.
 */
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
