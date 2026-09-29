import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { generateRequestId } from '../../utils/agentId.js'
import { crewStoreRoot } from './identity.js'

export const LIVE_COMMS_SCHEMA = 1 as const

export const LIVE_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type LiveTaskStatus = (typeof LIVE_TASK_STATUSES)[number]

export interface LiveCommsMessageV1 {
  id: string
  seq: number
  to: string
  from: string
  text: string
  timestamp: string
  read?: boolean
  color?: string
  summary?: string
  delivery?: { id: string; sessionId: string }
}

export interface LiveCommsTaskV1 {
  id: string
  subject: string
  detail?: string
  status: LiveTaskStatus
  owner?: string
  blockedBy: string[]
  createdBy: string
  createdAt: number
  updatedAt: number
}

export interface LiveCommsBusyV1 {
  name: string
  busy: boolean
  doing?: string
  since: number
}

export interface LiveCommsFileV1 {
  schema: typeof LIVE_COMMS_SCHEMA
  crew: string
  seq: number
  messages: LiveCommsMessageV1[]
  tasks: Record<string, LiveCommsTaskV1>
  busy: Record<string, LiveCommsBusyV1>
}

const MESSAGES_PER_RECIPIENT_TRIGGER = 200
const MESSAGES_PER_RECIPIENT_READ_KEEP = 100
const MAX_COMPLETED_TASKS = 200

export function liveCommsKey(crew: string): string {
  return crew.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
}

export function liveCommsPath(crew: string, dir?: string): string {
  return join(crewStoreRoot(dir), 'livecomms', `${liveCommsKey(crew)}.json`)
}

function emptyFile(crew: string): LiveCommsFileV1 {
  return { schema: LIVE_COMMS_SCHEMA, crew, seq: 0, messages: [], tasks: {}, busy: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMessage(candidate: unknown): candidate is LiveCommsMessageV1 {
  if (!isRecord(candidate)) return false
  return (
    typeof candidate.to === 'string' &&
    typeof candidate.from === 'string' &&
    typeof candidate.text === 'string' &&
    typeof candidate.timestamp === 'string' &&
    typeof candidate.id === 'string' &&
    typeof candidate.seq === 'number'
  )
}

function validDelivery(message: LiveCommsMessageV1): LiveCommsMessageV1 {
  const delivery = message.delivery
  if (delivery === undefined) return message
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
  if (
    isRecord(delivery) &&
    typeof delivery.id === 'string' &&
    typeof delivery.sessionId === 'string' &&
    uuid.test(delivery.id) &&
    uuid.test(delivery.sessionId)
  ) {
    return message
  }
  const { delivery: _invalid, ...rest } = message
  return rest
}

function isTask(candidate: unknown): candidate is LiveCommsTaskV1 {
  if (!isRecord(candidate)) return false
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.subject === 'string' &&
    typeof candidate.status === 'string' &&
    (LIVE_TASK_STATUSES as readonly string[]).includes(candidate.status) &&
    Array.isArray(candidate.blockedBy) &&
    typeof candidate.createdBy === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number'
  )
}

function isBusy(candidate: unknown): candidate is LiveCommsBusyV1 {
  if (!isRecord(candidate)) return false
  return typeof candidate.name === 'string' && typeof candidate.busy === 'boolean' && typeof candidate.since === 'number'
}

const liveCommsStore = defineStore<LiveCommsFileV1, [string, (string | undefined)?]>({
  name: 'crew-livecomms',
  path: (crew: string, dir?: string) => liveCommsPath(crew, dir),
  schemaVersion: LIVE_COMMS_SCHEMA,
  decode: raw => {
    if (!isRecord(raw)) return null
    const crew = typeof raw.crew === 'string' ? raw.crew : ''
    const out = emptyFile(crew)
    out.seq = typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : 0
    if (Array.isArray(raw.messages)) out.messages = raw.messages.filter(isMessage).map(validDelivery)
    if (isRecord(raw.tasks)) {
      for (const [id, task] of Object.entries(raw.tasks)) if (isTask(task)) out.tasks[id] = task
    }
    if (isRecord(raw.busy)) {
      for (const [name, row] of Object.entries(raw.busy)) if (isBusy(row)) out.busy[name] = row
    }
    const maxSeq = out.messages.reduce((max, m) => Math.max(max, m.seq), 0)
    if (out.seq < maxSeq) out.seq = maxSeq
    return out
  },
  empty: () => emptyFile(''),
  onReadFailure: 'empty',
  pollFloorMs: 1000,
})

function withCrew(file: LiveCommsFileV1, crew: string): LiveCommsFileV1 {
  return file.crew === crew ? file : { ...file, crew }
}

function compactMessages(messages: LiveCommsMessageV1[]): LiveCommsMessageV1[] {
  const perRecipient = new Map<string, number>()
  for (const m of messages) perRecipient.set(m.to, (perRecipient.get(m.to) ?? 0) + 1)
  const crowded = [...perRecipient.entries()].filter(([, n]) => n > MESSAGES_PER_RECIPIENT_TRIGGER).map(([to]) => to)
  if (crowded.length === 0) return messages
  const excess = new Map<string, number>()
  for (const to of crowded) {
    const readCount = messages.reduce((n, m) => n + (m.to === to && m.read ? 1 : 0), 0)
    const over = readCount - MESSAGES_PER_RECIPIENT_READ_KEEP
    if (over > 0) excess.set(to, over)
  }
  if (excess.size === 0) return messages
  const kept: LiveCommsMessageV1[] = []
  for (const m of messages) {
    const over = excess.get(m.to) ?? 0
    if (over > 0 && m.read) {
      excess.set(m.to, over - 1)
      continue
    }
    kept.push(m)
  }
  return kept
}

function boundTasks(tasks: Record<string, LiveCommsTaskV1>): Record<string, LiveCommsTaskV1> {
  const completed = Object.values(tasks).filter(t => t.status === 'completed')
  if (completed.length <= MAX_COMPLETED_TASKS) return tasks
  const drop = new Set(
    completed
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, completed.length - MAX_COMPLETED_TASKS)
      .map(t => t.id),
  )
  return Object.fromEntries(Object.entries(tasks).filter(([id]) => !drop.has(id)))
}

export async function readLiveComms(crew: string, opts?: { dir?: string }): Promise<LiveCommsFileV1> {
  return withCrew(await liveCommsStore(crew, opts?.dir).read(), crew)
}

export interface PostLiveMessageArgs {
  to: string
  from: string
  text: string
  timestamp: string
  color?: string
  summary?: string
  id?: string
}

export async function postLiveMessage(
  crew: string,
  message: PostLiveMessageArgs,
  opts?: { dir?: string },
): Promise<LiveCommsMessageV1> {
  return liveCommsStore(crew, opts?.dir).update<LiveCommsMessageV1>(current => {
    const file = withCrew(current, crew)
    const seq = file.seq + 1
    const stamped: LiveCommsMessageV1 = {
      id: message.id ?? generateRequestId('msg', message.to),
      seq,
      to: message.to,
      from: message.from,
      text: message.text,
      timestamp: message.timestamp,
      read: false,
      ...(message.color !== undefined ? { color: message.color } : {}),
      ...(message.summary !== undefined ? { summary: message.summary } : {}),
    }
    return { next: { ...file, seq, messages: compactMessages([...file.messages, stamped]) }, result: stamped }
  })
}

export async function liveMessagesFor(crew: string, name: string, opts?: { dir?: string }): Promise<LiveCommsMessageV1[]> {
  const file = await liveCommsStore(crew, opts?.dir).read()
  return file.messages.filter(m => m.to === name)
}

export async function mutateLiveMessages<R>(
  crew: string,
  name: string,
  fn: (mine: LiveCommsMessageV1[]) => { next: LiveCommsMessageV1[]; result: R },
  opts?: { dir?: string },
): Promise<R> {
  return liveCommsStore(crew, opts?.dir).update<R>(current => {
    const file = withCrew(current, crew)
    const mine = file.messages.filter(m => m.to === name)
    const { next, result } = fn(mine)
    if (next === mine) return { next: current, result }
    const replaced = new Map(next.map(m => [m.id, m] as const))
    const kept = new Set(next.map(m => m.id))
    const messages = file.messages
      .filter(m => m.to !== name || kept.has(m.id))
      .map(m => (m.to === name ? (replaced.get(m.id) ?? m) : m))
    return { next: { ...file, messages }, result }
  })
}

export async function upsertLiveTask(
  crew: string,
  task: Partial<Omit<LiveCommsTaskV1, 'createdAt' | 'updatedAt' | 'createdBy'>> & { subject?: string; createdBy: string },
  opts?: { dir?: string },
): Promise<LiveCommsTaskV1 | null> {
  return liveCommsStore(crew, opts?.dir).update<LiveCommsTaskV1 | null>(current => {
    const file = withCrew(current, crew)
    const now = Date.now()
    const existing = task.id !== undefined ? file.tasks[task.id] : undefined
    if (existing === undefined && (task.subject === undefined || task.subject.trim() === '')) {
      return { next: current, result: null }
    }
    const id = task.id ?? generateRequestId('task', task.createdBy)
    const record: LiveCommsTaskV1 = {
      id,
      subject: task.subject ?? existing?.subject ?? '',
      ...((task.detail ?? existing?.detail) !== undefined ? { detail: task.detail ?? existing?.detail } : {}),
      status: task.status ?? existing?.status ?? 'pending',
      ...((task.owner ?? existing?.owner) !== undefined ? { owner: task.owner ?? existing?.owner } : {}),
      blockedBy: task.blockedBy ?? existing?.blockedBy ?? [],
      createdBy: existing?.createdBy ?? task.createdBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    return { next: { ...file, tasks: boundTasks({ ...file.tasks, [id]: record }) }, result: record }
  })
}

export async function listLiveTasks(crew: string, opts?: { dir?: string }): Promise<LiveCommsTaskV1[]> {
  const file = await liveCommsStore(crew, opts?.dir).read()
  return Object.values(file.tasks).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
}

export async function setLiveBusy(
  crew: string,
  name: string,
  busy: boolean,
  doing?: string,
  opts?: { dir?: string },
): Promise<LiveCommsBusyV1> {
  return liveCommsStore(crew, opts?.dir).update<LiveCommsBusyV1>(current => {
    const file = withCrew(current, crew)
    const existing = file.busy[name]
    if (existing !== undefined && existing.busy === busy && existing.doing === doing) {
      return { next: current, result: existing }
    }
    const row: LiveCommsBusyV1 = {
      name,
      busy,
      ...(busy && doing !== undefined ? { doing } : {}),
      since: Date.now(),
    }
    return { next: { ...file, busy: { ...file.busy, [name]: row } }, result: row }
  })
}

export async function listLiveBusy(crew: string, opts?: { dir?: string }): Promise<LiveCommsBusyV1[]> {
  const file = await liveCommsStore(crew, opts?.dir).read()
  return Object.values(file.busy).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function subscribeLiveComms(
  crew: string,
  listener: (file: LiveCommsFileV1) => void,
  opts?: { immediate?: boolean; dir?: string },
): () => void {
  return liveCommsStore(crew, opts?.dir).subscribe(listener, { immediate: opts?.immediate ?? true })
}

export function liveMessageKey(file: LiveCommsFileV1, name: string): string {
  let max = 0
  let unread = 0
  let count = 0
  for (const m of file.messages) {
    if (m.to !== name) continue
    count++
    if (m.seq > max) max = m.seq
    if (!m.read) unread++
  }
  return `${max}:${unread}:${count}`
}
