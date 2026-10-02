import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { crewStoreRoot } from '../../services/crew/identity.js'
import { defineStore } from '../../substrate/fileStore.js'
import { logForDebugging } from '../debug.js'
import { getCrewsDir, getRetiredCrewsDir } from '../envUtils.js'
import { CREW_LEAD_NAME } from '../swarm/constants.js'

export const CREW_RECORD_SCHEMA = 1 as const

export interface CrewmateRecordV1 {
  name: string
  kind: 'lead' | 'crewmate'
  agentId: string
  model?: string
  cwd: string
  worktree?: string
  agentType?: string
  role?: string
  color?: string
  prompt?: string
  joinedAt: number
  backendType?: string
  state: 'stopped'
  mode?: string
  subscriptions: string[]
  sessionId?: string
}

export interface CrewHistoryMessageV1 {
  inbox: string
  [field: string]: unknown
}

export interface CrewRecordV1 {
  schema: typeof CREW_RECORD_SCHEMA
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  charter?: unknown
  governance?: unknown
  allowedPaths?: unknown
  hiddenPaneIds?: unknown
  members: CrewmateRecordV1[]
  history: {
    handoffs: unknown[]
    messages: CrewHistoryMessageV1[]
    questions: unknown[]
    leases: unknown | null
  }
  source: {
    dir: string
    files: Record<string, string>
  }
  convertedAt: number
}

export interface CrewConversionReceiptV1 {
  schema: typeof CREW_RECORD_SCHEMA
  crewsDir: string
  crews: string[]
  convertedAt: number
}

interface CrewsFileV1 {
  schema: typeof CREW_RECORD_SCHEMA
  crews: Record<string, CrewRecordV1>
  conversion?: CrewConversionReceiptV1
}

export interface ConvertSavedCrewsOutcome {
  crewsDir: string
  converted: string[]
  unchanged: string[]
  skipped: string[]
}

const crewsStore = defineStore<CrewsFileV1, [dir?: string]>({
  name: 'crews',
  path: (dir?: string) => join(crewStoreRoot(dir), 'crews.json'),
  schemaVersion: CREW_RECORD_SCHEMA,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<CrewsFileV1>
    const out: CrewsFileV1 = { schema: CREW_RECORD_SCHEMA, crews: {} }
    if (r.crews && typeof r.crews === 'object' && !Array.isArray(r.crews)) {
      for (const [name, crew] of Object.entries(r.crews)) {
        if (crew && typeof crew === 'object' && typeof (crew as CrewRecordV1).name === 'string' && Array.isArray((crew as CrewRecordV1).members)) {
          out.crews[name] = crew as CrewRecordV1
        }
      }
    }
    if (r.conversion && typeof r.conversion === 'object') out.conversion = r.conversion as CrewConversionReceiptV1
    return out
  },
  empty: () => ({ schema: CREW_RECORD_SCHEMA, crews: {} }),
  onReadFailure: 'empty',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  let names: string[]
  try {
    names = (await readdir(dir)).sort()
  } catch {
    return out
  }
  for (const name of names) {
    const path = join(dir, name)
    let isDir = false
    try {
      isDir = (await stat(path)).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...(await filesUnder(path, `${prefix}${name}/`)))
    else out.push(`${prefix}${name}`)
  }
  return out
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

function crewmateOf(member: Record<string, unknown>, leadAgentId: string): CrewmateRecordV1 {
  const name = String(member.name ?? '')
  const agentId = String(member.agentId ?? '')
  const kind: CrewmateRecordV1['kind'] = agentId === leadAgentId || name === CREW_LEAD_NAME ? 'lead' : 'crewmate'
  const pick = <T>(key: string, holds: (value: unknown) => value is T): T | undefined => (holds(member[key]) ? (member[key] as T) : undefined)
  const isString = (value: unknown): value is string => typeof value === 'string'
  const isNumber = (value: unknown): value is number => typeof value === 'number'
  const model = pick('model', isString)
  const worktree = pick('worktreePath', isString)
  const agentType = pick('agentType', isString)
  const role = pick('role', isString)
  const color = pick('color', isString)
  const prompt = pick('prompt', isString)
  const backendType = pick('backendType', isString)
  const mode = pick('mode', isString)
  const sessionId = pick('sessionId', isString)
  return {
    name,
    kind,
    agentId,
    ...(model !== undefined ? { model } : {}),
    cwd: pick('cwd', isString) ?? '',
    ...(worktree !== undefined ? { worktree } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    joinedAt: pick('joinedAt', isNumber) ?? 0,
    ...(backendType !== undefined ? { backendType } : {}),
    state: 'stopped',
    ...(mode !== undefined ? { mode } : {}),
    subscriptions: Array.isArray(member.subscriptions) ? member.subscriptions.filter(isString) : [],
    ...(sessionId !== undefined ? { sessionId } : {}),
  }
}

export async function readSavedCrew(crewsDir: string, name: string): Promise<Omit<CrewRecordV1, 'convertedAt'> | null> {
  const dir = join(crewsDir, name)
  const files = await filesUnder(dir)
  if (files.length === 0) return null
  const bytes = new Map<string, Buffer>()
  const checksums: Record<string, string> = {}
  for (const rel of files) {
    const data = await readFile(join(dir, rel))
    bytes.set(rel, data)
    checksums[rel] = createHash('sha256').update(data).digest('hex')
  }
  const config = bytes.has('config.json') ? parseJson(bytes.get('config.json')!) : undefined
  const roster = isRecord(config) ? config : {}
  const leadAgentId = typeof roster.leadAgentId === 'string' ? roster.leadAgentId : `${CREW_LEAD_NAME}@${name}`
  const members = Array.isArray(roster.members) ? roster.members.filter(isRecord).map(member => crewmateOf(member, leadAgentId)) : []
  const handoffsRaw = bytes.has('handoffs.json') ? parseJson(bytes.get('handoffs.json')!) : undefined
  const questionsRaw = bytes.has('questions.json') ? parseJson(bytes.get('questions.json')!) : undefined
  const leasesRaw = bytes.has('leases/leases.json') ? parseJson(bytes.get('leases/leases.json')!) : undefined
  const messages: CrewHistoryMessageV1[] = []
  for (const rel of files) {
    if (!rel.startsWith('inboxes/') || !rel.endsWith('.json')) continue
    const inbox = rel.slice('inboxes/'.length, -'.json'.length)
    const rows = parseJson(bytes.get(rel)!)
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (isRecord(row)) messages.push({ ...row, inbox })
    }
  }
  return {
    schema: CREW_RECORD_SCHEMA,
    name: typeof roster.name === 'string' ? roster.name : name,
    ...(typeof roster.description === 'string' ? { description: roster.description } : {}),
    createdAt: typeof roster.createdAt === 'number' ? roster.createdAt : 0,
    leadAgentId,
    ...(typeof roster.leadSessionId === 'string' ? { leadSessionId: roster.leadSessionId } : {}),
    ...(roster.charter !== undefined ? { charter: roster.charter } : {}),
    ...(roster.governance !== undefined ? { governance: roster.governance } : {}),
    ...(roster.allowedPaths !== undefined ? { allowedPaths: roster.allowedPaths } : {}),
    ...(roster.hiddenPaneIds !== undefined ? { hiddenPaneIds: roster.hiddenPaneIds } : {}),
    members,
    history: {
      handoffs: Array.isArray(handoffsRaw) ? handoffsRaw : [],
      messages,
      questions: Array.isArray(questionsRaw) ? questionsRaw : [],
      leases: leasesRaw === undefined ? null : leasesRaw,
    },
    source: { dir, files: checksums },
  }
}

function sameSource(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()
  return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && a[key] === b[key])
}

export async function convertSavedCrews(opts?: { crewsDir?: string; crewDir?: string }): Promise<ConvertSavedCrewsOutcome> {
  const crewsDir = opts?.crewsDir ?? getCrewsDir()
  const outcome: ConvertSavedCrewsOutcome = { crewsDir, converted: [], unchanged: [], skipped: [] }
  const retired = opts?.crewsDir === undefined ? getRetiredCrewsDir() : null
  const folders = retired === null ? [crewsDir] : [retired, crewsDir]
  const read: Array<Omit<CrewRecordV1, 'convertedAt'>> = []
  const seen = new Set<string>()
  for (const folder of folders) {
    let names: string[]
    try {
      names = (await readdir(folder)).filter(name => !name.startsWith('.')).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (seen.has(name)) continue
      let isDir = false
      try {
        isDir = (await stat(join(folder, name))).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) {
        outcome.skipped.push(name)
        continue
      }
      const record = await readSavedCrew(folder, name)
      if (record === null) {
        outcome.skipped.push(name)
        continue
      }
      seen.add(name)
      read.push(record)
    }
  }
  const store = crewsStore(opts?.crewDir)
  await store.update(current => {
    const crews = { ...current.crews }
    let changed = false
    const now = Date.now()
    for (const record of read) {
      const standing = crews[record.name]
      if (standing !== undefined && sameSource(standing.source.files, record.source.files)) {
        outcome.unchanged.push(record.name)
        continue
      }
      crews[record.name] = { ...record, convertedAt: now }
      outcome.converted.push(record.name)
      changed = true
    }
    if (!changed) return { next: current, result: undefined }
    const conversion: CrewConversionReceiptV1 = { schema: CREW_RECORD_SCHEMA, crewsDir, crews: read.map(record => record.name), convertedAt: now }
    return { next: { ...current, crews, conversion }, result: undefined }
  })
  return outcome
}

export async function listConvertedCrews(opts?: { crewDir?: string }): Promise<CrewRecordV1[]> {
  const state = await crewsStore(opts?.crewDir).read()
  return Object.values(state.crews)
}

export async function readConversionReceipt(opts?: { crewDir?: string }): Promise<CrewConversionReceiptV1 | null> {
  const state = await crewsStore(opts?.crewDir).read()
  return state.conversion ?? null
}

let bootConversion: Promise<void> | null = null

export function bootCrewConversion(): Promise<void> {
  if (bootConversion !== null) return bootConversion
  bootConversion = convertSavedCrews()
    .then(outcome => {
      if (outcome.converted.length > 0) logForDebugging(`[crew] ${outcome.converted.length} saved crew(s) carried into the crew store: ${outcome.converted.join(', ')}`)
    })
    .catch(error => {
      logForDebugging(`[crew] saved-crew conversion failed (non-blocking, retried on the next boot): ${error instanceof Error ? error.message : String(error)}`)
      bootConversion = null
    })
  return bootConversion
}
