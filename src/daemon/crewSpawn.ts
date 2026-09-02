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

export const MAX_CREW_TEAMMATES = 6

export function crewEnabled(): boolean {
  if (flagEnv('MERCURY_CREW') === '0') return false
  return true
}

export const CREW_MODEL_CHOICES = {
  opus: { model: 'claude-opus-5', effort: 'high' },
  sonnet: { model: 'claude-sonnet-5', effort: 'high' },
  fable: { model: 'claude-fable-5', effort: 'high' },
  fable51: { model: 'claude-fable-5-1', effort: 'high' },
} as const
export type CrewModelKey = keyof typeof CREW_MODEL_CHOICES

export function isCrewModelKey(k: string): k is CrewModelKey {
  return Object.prototype.hasOwnProperty.call(CREW_MODEL_CHOICES, k)
}

const CREW_NAME_RE = /^[a-z][a-z0-9-]{1,15}$/
const RESERVED_NAMES = new Set(['team-lead', 'crew', 'daemon'])
export function isValidCrewName(name: string): boolean {
  return CREW_NAME_RE.test(name) && !RESERVED_NAMES.has(name)
}

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
    logForDebugging(`[crew] appendTeamMember(${name}) failed: ${e}`)
    throw e
  }
}

export interface CrewRosterPort {
  has(short: string): { present: boolean }
  list(): ReadonlyArray<{ short: string; outcome?: unknown }>
  registerLongLived(
    short: string,
    spec: StreamJsonChildSpec,
  ): { ok: boolean; pid?: number; error?: string }
}

export interface CrewSpawnDeps {
  roster: () => CrewRosterPort | undefined
  dir: string
  onSpawned: (name: string, spec: StreamJsonChildSpec, pid: number | undefined) => void
}

export function makeCrewSpawnHandler(
  deps: CrewSpawnDeps,
): (name: string, modelKey: string) => Promise<{ ok: boolean; pid?: number; error?: string }> {
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
    extraEnv: {
      ...flagPair('MERCURY_WORKFLOWS', '0'),
      ...flagPair('MERCURY_CREW_AGENT', name),
    },
    permissionMode: 'flow',
    allowedTools: resolveWorkerReconAllow(),
    stripEnv: flagSpellings('MERCURY_SESSION_KIT'),
  }
}
