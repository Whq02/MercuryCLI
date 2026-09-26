import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JevAnswer, JevRoad, JevUsage } from '../../../src/services/jev/jevContract.js'
import type { JevEvalInput } from '../../../src/tools/JevEvalTool/jevEvalSchema.js'

const ROOT = join(import.meta.dir, '..', '..', '..')

export type JevAsk =
  | { ok: true; road: JevRoad; model: string; answers: Record<string, JevAnswer>; nouls: Record<string, number>; usage: JevUsage; chargeUsd: number; requestId?: string }
  | { ok: false; kind: string; words: string }

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

if (!('MACRO' in globalThis)) (globalThis as Record<string, unknown>).MACRO = { VERSION: packageVersion() }

const config = await import('../../../src/utils/config.js')
const client = await import('../../../src/services/jev/jevClient.js')
const keys = await import('../../../src/services/jev/jevKey.js')
const ledger = await import('../../../src/services/jev/jevLedger.js')
const setting = await import('../../../src/services/jev/jevSetting.js')
const status = await import('../../../src/services/jev/jevStatus.js')
const assembly = await import('../../../src/tools/JevEvalTool/jevEvalRequest.js')

config.enableConfigs()

export function jevRoadWordsNow(): string {
  const settings = setting.readJevSettings()
  return `${settings.enabled ? 'on' : 'off'} · ${settings.road}`
}

export async function askJev(input: JevEvalInput): Promise<JevAsk> {
  const settings = setting.readJevSettings()
  const road = settings.road
  const before = status.jevStatus(undefined, Date.now(), settings)
  if (before.kind !== 'ready') return { ok: false, kind: before.kind, words: before.words }
  const assembled = assembly.assembleJevEvalRequest(input, road)
  if (!assembled.ok) return { ok: false, kind: 'refused', words: assembled.reason }
  const key = keys.resolveJevApiKey(process.env, road)
  if (key === undefined) {
    const now = status.jevStatus(undefined, Date.now(), settings)
    return { ok: false, kind: now.kind, words: now.words }
  }
  ledger.noteJevAttempt(Date.now(), undefined, road)
  const outcome = await client.jevSystemOne(assembled.request, key.key, { road })
  const now = Date.now()
  if (outcome.ok) {
    const chargeUsd = ledger.settleJevCall(outcome.response.usage, outcome.response.model, now, road, outcome.requestId)
    const nouls: Record<string, number> = {}
    for (const [id, answer] of Object.entries(outcome.response.answers)) if (answer.type === 'noul') nouls[id] = answer.noul
    return { ok: true, road, model: outcome.response.model, answers: outcome.response.answers, nouls, usage: outcome.response.usage, chargeUsd, ...(outcome.requestId !== undefined ? { requestId: outcome.requestId } : {}) }
  }
  ledger.noteJevWireFailure(outcome.failure, now, Math.random, road)
  const after = status.jevStatus(undefined, now, settings)
  const detail = `HTTP ${outcome.failure.status ?? 'unreported'}: ${outcome.failure.detail}${outcome.failure.requestId ? ` | id=${outcome.failure.requestId}` : ''}`
  if (after.kind === 'ready') return { ok: false, kind: outcome.failure.kind, words: `${status.JEV_STATUS_HEADWORDS[outcome.failure.kind as keyof typeof status.JEV_STATUS_HEADWORDS] ?? outcome.failure.kind} — ${detail}` }
  return { ok: false, kind: after.kind, words: `${after.words} | ${detail}` }
}

export type JevBatchItem = { id: string; evidence: Record<string, string> }
export type JevBatchRow = { id: string; ask: JevAsk }

export async function askJevBatch(items: readonly JevBatchItem[], questions: JevEvalInput['questions'], goal: string, width = 4): Promise<JevBatchRow[]> {
  const rows: JevBatchRow[] = []
  let stop: JevAsk | undefined
  for (let at = 0; at < items.length; at += width) {
    if (stop !== undefined) {
      for (const item of items.slice(at)) rows.push({ id: item.id, ask: stop })
      break
    }
    const slice = items.slice(at, at + width)
    const answers = await Promise.all(slice.map(item => askJev({ goal, evidence: item.evidence, questions })))
    slice.forEach((item, index) => {
      const ask = answers[index]!
      rows.push({ id: item.id, ask })
      if (!ask.ok && stop === undefined && ask.kind !== 'bad-request' && ask.kind !== 'refused') stop = ask
    })
  }
  return rows
}
