
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getTeamsDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import * as lockfile from '../lockfile.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { sanitizePathComponent } from '../tasks.js'
import { getTeamName } from '../teammate.js'

const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

export const HANDOFF_STATUSES = ['done', 'blocked', 'needs-review'] as const
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number]

export type EvidenceRef = {
  kind?: 'file' | 'command' | 'commit' | string
  ref: string
  note?: string
}

export type HandoffVerdict = {
  verified: boolean
  reason?: string
  isSuccessClaim: boolean
}

export type Handoff = {
  id: string
  from: string
  to: string
  status: HandoffStatus
  summary: string
  evidenceRefs: EvidenceRef[]
  verified: boolean
  unverifiedReason?: string
  sentAt: string
  acknowledgedAt?: string
}

export function isSuccessClaim(status: HandoffStatus): boolean {
  return status === 'done'
}

export function validateHandoff(input: {
  status: HandoffStatus
  evidenceRefs?: EvidenceRef[]
}): HandoffVerdict {
  const successClaim = isSuccessClaim(input.status)
  const evidence = Array.isArray(input.evidenceRefs)
    ? input.evidenceRefs.filter(
        e => !!e && typeof e.ref === 'string' && e.ref.trim().length > 0,
      )
    : []

  if (successClaim && evidence.length === 0) {
    return {
      verified: false,
      isSuccessClaim: true,
      reason:
        'success claim ("done") with NO evidenceRefs — unverified. The recipient sees this handoff flagged as an unbacked claim; attach files/commands/commits that back the success, or downgrade the status to "needs-review".',
    }
  }

  return { verified: true, isSuccessClaim: successClaim }
}


function getHandoffsPath(teamName?: string): string {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  return join(getTeamsDir(), safeTeam, 'handoffs.json')
}

async function readHandoffs(teamName?: string): Promise<Handoff[]> {
  const path = getHandoffsPath(teamName)
  try {
    const content = await readFile(path, 'utf-8')
    const parsed = jsonParse(content)
    return Array.isArray(parsed) ? (parsed as Handoff[]) : []
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') return []
    logForDebugging(`[Handoff] readHandoffs failed: ${error}`)
    return []
  }
}

async function mutateHandoffs(
  teamName: string | undefined,
  mutate: (handoffs: Handoff[]) => Handoff[],
): Promise<void> {
  const path = getHandoffsPath(teamName)
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const dir = join(getTeamsDir(), safeTeam)
  await mkdir(dir, { recursive: true })

  try {
    await writeFile(path, '[]', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      logForDebugging(`[Handoff] could not create handoffs file: ${error}`)
      return
    }
  }

  const lockFilePath = `${path}.lock`
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(path, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })
    const current = await readHandoffs(teamName)
    const next = mutate(current)
    await writeFile(path, jsonStringify(next, null, 2), 'utf-8')
  } catch (error) {
    logForDebugging(`[Handoff] mutateHandoffs failed: ${error}`)
    logError(error)
  } finally {
    if (release) {
      try {
        await release()
      } catch {
      }
    }
  }
}

export async function recordHandoff(
  h: {
    id: string
    from: string
    to: string
    status: HandoffStatus
    summary: string
    evidenceRefs?: EvidenceRef[]
  },
  teamName?: string,
): Promise<HandoffVerdict> {
  const verdict = validateHandoff({
    status: h.status,
    evidenceRefs: h.evidenceRefs,
  })
  const evidenceRefs = Array.isArray(h.evidenceRefs)
    ? h.evidenceRefs.filter(
        e => !!e && typeof e.ref === 'string' && e.ref.trim().length > 0,
      )
    : []

  await mutateHandoffs(teamName, handoffs => {
    const filtered = handoffs.filter(x => x.id !== h.id)
    filtered.push({
      id: h.id,
      from: h.from,
      to: h.to,
      status: h.status,
      summary: h.summary,
      evidenceRefs,
      verified: verdict.verified,
      unverifiedReason: verdict.verified ? undefined : verdict.reason,
      sentAt: new Date().toISOString(),
    })
    return filtered.length > 200 ? filtered.slice(filtered.length - 200) : filtered
  })

  return verdict
}

export async function listIncomingHandoffs(
  agentName: string,
  teamName?: string,
): Promise<Handoff[]> {
  const handoffs = await readHandoffs(teamName)
  const me = (agentName ?? '').trim().toLowerCase()
  return handoffs.filter(
    h => (h.to ?? '').trim().toLowerCase() === me && !h.acknowledgedAt,
  )
}

export async function listAllOpenHandoffs(
  teamName?: string,
): Promise<Handoff[]> {
  const handoffs = await readHandoffs(teamName)
  return handoffs.filter(h => !h.acknowledgedAt)
}
