
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { decodeManagerAsk, decodeManagerPlan, type ManagerAskV1, type ManagerPlanV1 } from './managerMode.js'

export interface CoordinatorConversationReceiptV1 {
  verb: string
  outcome: string
  label: string
}

export interface CoordinatorConversationEntryV1 {
  id: string
  role: 'operator' | 'coordinator'
  text: string
  ts: number
  receipts?: CoordinatorConversationReceiptV1[]
  harness?: true
  summary?: true
  ask?: ManagerAskV1
  plan?: ManagerPlanV1
}

export interface CoordinatorContextGaugeV1 {
  contextTokens: number
  modelId: string
  ts: number
}

interface CoordinatorConversationFileV1 {
  entries: CoordinatorConversationEntryV1[]
  gauge?: CoordinatorContextGaugeV1
}

export const CONVERSATION_CAP = 200

const decodeEntry = (raw: unknown): CoordinatorConversationEntryV1 | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<CoordinatorConversationEntryV1>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (r.role !== 'operator' && r.role !== 'coordinator') return null
  if (typeof r.text !== 'string') return null
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null
  const receipts = Array.isArray(r.receipts)
    ? r.receipts
        .filter(
          (x): x is CoordinatorConversationReceiptV1 =>
            !!x &&
            typeof x === 'object' &&
            typeof (x as CoordinatorConversationReceiptV1).verb === 'string' &&
            typeof (x as CoordinatorConversationReceiptV1).outcome === 'string' &&
            typeof (x as CoordinatorConversationReceiptV1).label === 'string',
        )
        .slice(0, 24)
    : undefined
  const ask = r.ask !== undefined ? decodeManagerAsk(r.ask) : null
  const plan = r.plan !== undefined ? decodeManagerPlan(r.plan) : null
  return {
    id: r.id.slice(0, 128),
    role: r.role,
    text: r.text.slice(0, 8000),
    ts: r.ts,
    ...(receipts !== undefined && receipts.length > 0 ? { receipts } : {}),
    ...(r.harness === true ? { harness: true as const } : {}),
    ...(r.summary === true ? { summary: true as const } : {}),
    ...(ask !== null ? { ask } : {}),
    ...(plan !== null ? { plan } : {}),
  }
}

const decodeGauge = (raw: unknown): CoordinatorContextGaugeV1 | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const g = raw as Partial<CoordinatorContextGaugeV1>
  if (typeof g.contextTokens !== 'number' || !Number.isFinite(g.contextTokens) || g.contextTokens < 0) return undefined
  if (typeof g.modelId !== 'string' || g.modelId.length === 0) return undefined
  if (typeof g.ts !== 'number' || !Number.isFinite(g.ts)) return undefined
  return { contextTokens: Math.floor(g.contextTokens), modelId: g.modelId.slice(0, 128), ts: g.ts }
}

const conversationStore = defineStore<CoordinatorConversationFileV1, [dir?: string]>({
  name: 'coordinator-conversation',
  path: (dir?: string) => join(dir ?? getMercuryHome(), 'coordinator-conversation.json'),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<CoordinatorConversationFileV1>
    const entries = Array.isArray(r.entries)
      ? r.entries.map(decodeEntry).filter((e): e is CoordinatorConversationEntryV1 => e !== null)
      : []
    const gauge = decodeGauge(r.gauge)
    return { entries: entries.slice(-CONVERSATION_CAP), ...(gauge !== undefined ? { gauge } : {}) }
  },
  empty: () => ({ entries: [] }),
  onReadFailure: 'empty',
})

export async function readCoordinatorConversation(dir?: string): Promise<CoordinatorConversationEntryV1[]> {
  return (await conversationStore(dir).read()).entries
}

export async function appendCoordinatorConversation(
  entry: CoordinatorConversationEntryV1,
  dir?: string,
): Promise<void> {
  await conversationStore(dir).mutate(prev => ({
    ...prev,
    entries: [...prev.entries.filter(e => e.id !== entry.id), entry].slice(-CONVERSATION_CAP),
  }))
}

export async function stampCoordinatorGauge(gauge: CoordinatorContextGaugeV1, dir?: string): Promise<void> {
  await conversationStore(dir).mutate(prev => ({ ...prev, gauge }))
}

export async function readCoordinatorGauge(dir?: string): Promise<CoordinatorContextGaugeV1 | undefined> {
  return (await conversationStore(dir).read()).gauge
}

export async function clearCoordinatorConversation(dir?: string): Promise<void> {
  const store = conversationStore(dir)
  await store.update(() => ({ next: { entries: [] }, result: undefined }))
}

export async function applyCoordinatorFold(
  marker: CoordinatorConversationEntryV1,
  foldedIds: ReadonlySet<string>,
  dir?: string,
): Promise<void> {
  const store = conversationStore(dir)
  await store.mutate(current => ({
    entries: [marker, ...current.entries.filter(e => !foldedIds.has(e.id))].slice(-CONVERSATION_CAP),
  }))
}

export function subscribeCoordinatorConversation(cb: () => void, dir?: string): () => void {
  return conversationStore(dir).subscribe(() => cb(), { immediate: false })
}
