// ============================================================================
//  crewSpawn — daemon-side spawn specs for CREW TEAMMATES (/teammates).
//
//  Mercury's own, non-beta take on "agent teams": each teammate is a NAMED,
//  long-lived daemon worker (registerLongLived → buildStreamJsonInvocation)
//  the operator CHATS with from the
//  /teammates board — instanced, color-coded chats in ONE repo, managed
//  horizontally. No upstream beta gates; the backend is the proven Mercury
//  bus: operator messages ride writeToMailbox(teams/crew/inboxes/<name>) and
//  the seat drain delivers them as attributed frames; teammate replies ride
//  the child's SendMessage → teams/crew/inboxes/team-lead.json.
//
//  Teammates spawn ON DEMAND over the AUTHED control socket (op 'crewSpawn' —
//  the daemon owns the FLOOR server-side; the RPC carries only intent:
//  name + model choice). There is no eager boot spawn: every teammate is an
//  explicit, billed operator act in the TUI.
//
//  HARDENING FLOOR (every teammate, non-negotiable, enforced HERE not in the
//  client): validated never-Haiku model table · permissionMode 'flow'
//  (classifier-adjudicated asks; operator MERCURY_DAEMON_PERMISSION_MODE still
//  wins) · read-only recon --allowedTools (classifier-fault immune — the same
//  resolveWorkerReconAllow set every daemon worker rides) ·
//  MERCURY_WORKFLOWS='0' extraEnv (a teammate can never fan out agent DAGs)
//  · name allowlist regex (the name reaches file paths + env — [a-z0-9-]
//  only).
// ============================================================================
import { logForDebugging } from '../utils/debug.js'
import { flagEnv, flagPair, flagSpellings } from '../substrate/flagRegistry.js'
import {
  appendTeamMember,
  readTeamFileAsync,
  writeTeamFileAsync,
  type TeamFile,
} from '../utils/swarm/teamHelpers.js'
import { resolveWorkerReconAllow } from './workerRecon.js'
import { isolationAwarenessNote } from './isolationNote.js'
import type { StreamJsonChildSpec } from './headlessRun.js'

export const CREW_TEAM = 'crew' as const
export const CREW_LEAD_AGENT_ID = 'team-lead@crew' as const

/** Daemon-side SPEND GUARD (non-beta hardening): a key-authed client bug can
 *  never fan out unbounded billed workers — the cap is enforced where the
 *  spawn happens, not in the UI. Six live teammates is already beyond any
 *  realistic horizontal-chat use; raise deliberately, never implicitly. */
export const MAX_CREW_TEAMMATES = 6

/** /teammates surface + crew spawns. Fork-opt-out: `MERCURY_CREW=0` hides the
 *  board and refuses spawns (byte-identical); spawning itself is ALWAYS an
 *  explicit operator act (the 'n' wizard), never automatic. */
export function crewEnabled(): boolean {
  if (flagEnv('MERCURY_CREW') === '0') return false
  return true
}

/**
 * The CLOSED model table — the ask-the-operator rule as data: the spawn wizard
 * makes the operator pick one of exactly these four; there is no fifth key,
 * so Haiku (or junk) is unrepresentable rather than merely rejected. Efforts
 * ride the ratified daemon-worker convention (high — the executor tier).
 */
export const CREW_MODEL_CHOICES = {
  opus: { model: 'claude-opus-5', effort: 'high' },
  sonnet: { model: 'claude-sonnet-5', effort: 'high' },
  fable: { model: 'claude-fable-5', effort: 'high' },
  // Claude Fable 5.1 by its exact-generation key; the family key keeps
  // the family default. Same effort convention.
  fable51: { model: 'claude-fable-5-1', effort: 'high' },
} as const
export type CrewModelKey = keyof typeof CREW_MODEL_CHOICES

export function isCrewModelKey(k: string): k is CrewModelKey {
  return Object.prototype.hasOwnProperty.call(CREW_MODEL_CHOICES, k)
}

/** Teammate names reach inbox paths, env values, and agent ids — allowlist
 *  hard: lowercase alnum + hyphen, 2-16 chars, letter-first. Reserved names
 *  refused (they collide with existing roster/bus identities). */
const CREW_NAME_RE = /^[a-z][a-z0-9-]{1,15}$/
// Reserved: the lead's own name, the daemon and crew words, and the retired
// seat identities — old records and the role-env sweep still name them, so a
// teammate must never take one.
const RESERVED_NAMES = new Set(['team-lead', 'implementer', 'scribe', 'tank', 'healer', 'dps1', 'dps2', 'dps3', 'crew', 'daemon'])
export function isValidCrewName(name: string): boolean {
  return CREW_NAME_RE.test(name) && !RESERVED_NAMES.has(name)
}

/**
 * The teammate's authored collaborator pack — SHORT by design (a teammate is
 * a conversational peer, not a routed executor; no dispatch contract, no
 * stop-hook teeth). Rides the spec's appendSystemPrompt so supervisor
 * respawns keep it verbatim.
 *
 * BOARD CONTROLS item 6: the pack OPENS with the ground note from the ONE
 * composer — a teammate always works the shared repo folder (no worktree,
 * no isolation), and is told so plainly before anything else.
 */
export function buildCrewPack(name: string, dir?: string): string {
  return [
    ...(dir !== undefined ? [isolationAwarenessNote({ isolation: 'exclusive', workspaceId: dir }), ''] : []),
    `You are @${name}, a Mercury crew teammate — a named, persistent collaborator instance working in this repository alongside the operator and other teammates.`,
    '',
    'CONTRACT:',
    `- You converse with the OPERATOR. Messages arrive on stdin as attributed frames; reply by calling SendMessage to "team-lead" — that is the operator's inbox. Never print a reply only to stdout; if it is not sent via SendMessage, the operator never sees it.`,
    '- Do real work in the repo when asked (read, edit, run) — you are a full agent, not a chat bot. Report what you actually did, with file:line refs; never claim unverified results.',
    '- Blocked (a denied permission, a missing credential, an ambiguous ask)? Say so in your reply and ask — one concise question. Never bypass a permission, approval, capability, or refusal gate.',
    '- Stay in your lane: no daemons, no agent fan-out, no engaging other Mercury modes. Other teammates may be working in this same repo — keep your edits scoped to what the operator asked YOU for, and say if you see a conflict.',
    '- Tone: a competent peer — direct, concrete, brief. Lead with the outcome.',
  ].join('\n')
}

/**
 * Ensure the crew team file exists and carries this teammate as a member —
 * SendMessage refuses recipients that are not team members ("its inbox would
 * never be read"), so membership is a spawn precondition, not an afterthought.
 *
 * The team file is the DURABLE CHAT IDENTITY: members persist across daemon
 * restarts and teammate kills (the /teammates board shows a roster-absent
 * member as offline with its transcript intact; respawning the same name
 * re-attaches to the same chat). Governance hardening: broadcasts are OFF for
 * the crew team — teammates are operator-pair chats, and a single teammate
 * must never be able to spam every inbox on the bus.
 */
export async function ensureCrewTeamMember(
  name: string,
  modelKey: CrewModelKey,
  projectDir: string,
): Promise<void> {
  const member = {
    agentId: `${name}@${CREW_TEAM}`,
    name,
    model: CREW_MODEL_CHOICES[modelKey].model,
    role: 'teammate',
    joinedAt: Date.now(),
    tmuxPaneId: '',
    cwd: projectDir,
    subscriptions: [] as string[],
  }
  const existing = await readTeamFileAsync(CREW_TEAM)
  if (!existing) {
    const teamFile: TeamFile = {
      name: CREW_TEAM,
      description:
        'Mercury crew teammates — /teammates instanced chats (daemon-bridged, no tmux panes; members are durable chat identities)',
      createdAt: Date.now(),
      leadAgentId: CREW_LEAD_AGENT_ID,
      governance: { broadcastEnabled: false },
      members: [
        {
          agentId: CREW_LEAD_AGENT_ID,
          name: 'team-lead',
          role: 'lead',
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: projectDir,
          subscriptions: [],
        },
        member,
      ],
    }
    await writeTeamFileAsync(CREW_TEAM, teamFile)
    return
  }
  if (existing.members.some(m => m.name === name)) return
  try {
    await appendTeamMember(CREW_TEAM, member)
  } catch (e) {
    // appendTeamMember enforces its own locked roster cap — surface, don't mask.
    logForDebugging(`[crew] appendTeamMember(${name}) failed: ${e}`)
    throw e
  }
}

/** The roster surface the crew spawn policy needs — a structural subset of the
 *  daemon roster, so the real handler is drivable in a proof with a fake. */
export interface CrewRosterPort {
  has(short: string): { present: boolean }
  list(): ReadonlyArray<{ short: string; outcome?: unknown }>
  registerLongLived(
    short: string,
    spec: StreamJsonChildSpec,
  ): { ok: boolean; pid?: number; error?: string }
}

export interface CrewSpawnDeps {
  /** Live roster accessor (undefined while the daemon is still booting). */
  roster: () => CrewRosterPort | undefined
  /** Project dir teammates run in (the daemon's own dir). */
  dir: string
  /** Post-spawn wiring hook (main.ts arms the dispatch drain + idle nudge). */
  onSpawned: (name: string, spec: StreamJsonChildSpec, pid: number | undefined) => void
}

/**
 * The complete crewSpawn RPC policy — gate → name allowlist → model table →
 * roster-ready → dupe → SPEND GUARD → durable team member → registerLongLived.
 * Lives HERE (not main.ts) so the whole floor is one drivable function; main.ts
 * contributes only the drain/nudge wiring via onSpawned. Every refusal is a
 * plain string the /teammates board surfaces verbatim (failure ≠ silence).
 */
export function makeCrewSpawnHandler(
  deps: CrewSpawnDeps,
): (name: string, modelKey: string) => Promise<{ ok: boolean; pid?: number; error?: string }> {
  // Live crew-teammate shorts — the spend guard counts against THIS set, so
  // other daemon workers never eat the crew cap (and vice versa). Per-handler
  // state: one handler per daemon run.
  const crewShorts = new Set<string>()
  return async (name, modelKey) => {
    if (!crewEnabled()) {
      return { ok: false, error: 'crew teammates are disabled on this daemon (MERCURY_CREW=0)' }
    }
    if (!isValidCrewName(name)) {
      return { ok: false, error: `invalid teammate name ${JSON.stringify(name)} — [a-z][a-z0-9-]{1,15}, reserved names refused` }
    }
    if (!isCrewModelKey(modelKey)) {
      return { ok: false, error: `model must be 'opus' | 'sonnet' | 'fable' | 'fable51' (got ${JSON.stringify(modelKey)}) — the operator picks per spawn, never a raw model id` }
    }
    const r = deps.roster()
    if (!r) return { ok: false, error: 'daemon roster not ready' }
    if (r.has(name).present) {
      return { ok: false, error: `'${name}' is already live on this daemon — kill it first or pick another name` }
    }
    // SPEND GUARD (daemon-side, non-beta hardening): count LIVE crew workers,
    // not team-file members (durable chat identities persist offline by
    // design) — a key-authed client bug can never fan out unbounded billed
    // workers.
    const liveCrew = r.list().filter(j => !j.outcome && crewShorts.has(j.short)).length
    if (liveCrew >= MAX_CREW_TEAMMATES) {
      return { ok: false, error: `crew cap reached (${MAX_CREW_TEAMMATES} live teammates) — kill an idle teammate before spawning another` }
    }
    try {
      await ensureCrewTeamMember(name, modelKey, deps.dir)
    } catch (e) {
      return { ok: false, error: `team-file update failed: ${e}` }
    }
    const spec = buildCrewSpec(name, modelKey, deps.dir)
    const reg = r.registerLongLived(name, spec)
    if (!reg.ok) return { ok: false, error: reg.error ?? 'registerLongLived refused' }
    crewShorts.add(name)
    deps.onSpawned(name, spec, reg.pid)
    return { ok: true, pid: reg.pid }
  }
}

/**
 * Build the registerLongLived spec for a crew teammate. The FLOOR lives here:
 * a control-socket caller chooses only {name, model-key}; everything
 * security-relevant is stamped server-side.
 */
export function buildCrewSpec(
  name: string,
  modelKey: CrewModelKey,
  dir: string,
): StreamJsonChildSpec {
  const choice = CREW_MODEL_CHOICES[modelKey]
  return {
    model: choice.model,
    effort: choice.effort,
    appendSystemPrompt: buildCrewPack(name, dir),
    role: 'MERCURY_CREW',
    agentName: name,
    agentId: `${name}@${CREW_TEAM}`,
    teamName: CREW_TEAM,
    cwd: dir,
    // The daemon-worker capability floor: no seat-side agent DAGs, and the
    // teammate's own name in env so isCrewRole()/identity resolve child-side.
    extraEnv: {
      ...flagPair('MERCURY_WORKFLOWS', '0'),
      ...flagPair('MERCURY_CREW_AGENT', name),
    },
    // Permission posture: a `-p` child terminal-denies every un-ruled 'ask' —
    // flow routes asks through the classifier and
    // the read-only recon rules short-circuit BEFORE it, so a classifier
    // fault can never blind a teammate. MERCURY_DAEMON_PERMISSION_MODE wins.
    permissionMode: 'flow',
    allowedTools: resolveWorkerReconAllow(),
    // THE NON-SESSION INSULATION: a crew teammate is
    // NOT a kit-bearing session — a stray session-kit spelling in the
    // spawning process's env must never reach it (the kit narrows only the
    // session it was stamped on; buildConcourseWorkerSpec is the one stamp).
    stripEnv: flagSpellings('MERCURY_SESSION_KIT'),
  }
}
