import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JevAnswer, JevQuestion, JevRoad, JevUsage, JevWireFailure } from '../../../src/services/jev/jevContract.js'
import type { JevEvalInput } from '../../../src/tools/JevEvalTool/jevEvalSchema.js'

const ROOT = join(import.meta.dir, '..', '..', '..')

export type JevAskQuestions = JevEvalInput['questions']
export type JevAskEvidence = Record<string, string>
export type JevAsk =
  | { ok: true; road: JevRoad; model: string; answers: Record<string, JevAnswer>; nouls: Record<string, number>; usage: JevUsage; chargeUsd: number; requestId?: string }
  | { ok: false; kind: string; words: string }
export type JevBatchItem = { id: string; evidence: JevAskEvidence }
export type JevBatchRow = { id: string; ask: JevAsk }
export const JEV_ASK_WIDTH = 8

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
const contract = await import('../../../src/services/jev/jevContract.js')
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

function wireQuestions(questions: JevAskQuestions): { questions: Record<string, JevQuestion>; tokens: number; longestId: string; longestTokens: number } {
  const wired: Record<string, JevQuestion> = {}
  let tokens = 0
  let longestId = ''
  let longestTokens = -1
  for (const question of questions) {
    wired[question.id] = assembly.jevEvalWireQuestion(question)
    const size = assembly.jevEvalTokenEstimate(JSON.stringify(wired[question.id]))
    tokens += size
    if (size > longestTokens) {
      longestTokens = size
      longestId = question.id
    }
  }
  return { questions: wired, tokens, longestId, longestTokens }
}

function oversize(evidence: JevAskEvidence, wired: ReturnType<typeof wireQuestions>, road: JevRoad): string | undefined {
  const stateTokens = assembly.jevEvalTokenEstimate(JSON.stringify(evidence))
  if (stateTokens + wired.longestTokens > contract.JEV_MAX_STATE_PLUS_QUESTION_TOKENS) return `the evidence plus question "${wired.longestId}" is about ${stateTokens + wired.longestTokens} tokens; the provider takes at most ${contract.JEV_MAX_STATE_PLUS_QUESTION_TOKENS} for the evidence plus the longest question; nothing was sent`
  const max = contract.jevMaxRequestTokens(road)
  if (stateTokens + wired.tokens > max) return `the evidence plus all questions is about ${stateTokens + wired.tokens} tokens; the provider takes at most ${max} a request; nothing was sent`
  return undefined
}

function failureWords(failure: JevWireFailure): string {
  const head = status.JEV_STATUS_HEADWORDS[failure.kind as keyof typeof status.JEV_STATUS_HEADWORDS] ?? failure.kind
  return `${head} — HTTP ${failure.status ?? 'unreported'}: ${failure.detail}${failure.requestId ? ` | id=${failure.requestId}` : ''}`
}

export async function askJevBatch(items: readonly JevBatchItem[], questions: JevAskQuestions, width = JEV_ASK_WIDTH): Promise<JevBatchRow[]> {
  const settings = setting.readJevSettings()
  const road = settings.road
  const wired = wireQuestions(questions)
  const rows: JevBatchRow[] = items.map(item => ({ id: item.id, ask: { ok: false, kind: 'pending', words: 'not yet asked' } }))
  const key = keys.resolveJevApiKey(process.env, road)
  const failures: JevWireFailure[] = []
  const failed = new Set<number>()
  for (let at = 0; at < items.length; at += Math.max(1, width)) {
    const flights: Promise<void>[] = []
    for (let index = at; index < Math.min(items.length, at + Math.max(1, width)); index++) {
      const item = items[index]!
      const row = rows[index]!
      const admission = status.jevStatus(undefined, Date.now(), settings)
      if (admission.kind !== 'ready' || key === undefined) {
        row.ask = { ok: false, kind: admission.kind, words: admission.words }
        continue
      }
      const reason = oversize(item.evidence, wired, road)
      if (reason !== undefined) {
        row.ask = { ok: false, kind: 'refused', words: reason }
        continue
      }
      ledger.noteJevAttempt(Date.now(), undefined, road)
      flights.push(
        client.jevSystemOne({ state: item.evidence, questions: wired.questions }, key.key, { road }).then(outcome => {
          if (outcome.ok) {
            const chargeUsd = ledger.settleJevCall(outcome.response.usage, outcome.response.model, Date.now(), road, outcome.requestId)
            const nouls: Record<string, number> = {}
            for (const [id, answer] of Object.entries(outcome.response.answers)) if (answer.type === 'noul') nouls[id] = answer.noul
            row.ask = { ok: true, road, model: outcome.response.model, answers: outcome.response.answers, nouls, usage: outcome.response.usage, chargeUsd, ...(outcome.requestId !== undefined ? { requestId: outcome.requestId } : {}) }
            return
          }
          failures.push(outcome.failure)
          failed.add(index)
          row.ask = { ok: false, kind: outcome.failure.kind, words: failureWords(outcome.failure) }
        }),
      )
    }
    await Promise.all(flights)
    const noted = new Set<string>()
    for (const failure of failures.splice(0)) {
      if (failure.kind !== 'parse-failed' && failure.kind !== 'aborted' && noted.has(failure.kind)) continue
      noted.add(failure.kind)
      ledger.noteJevWireFailure(failure, Date.now(), Math.random, road)
    }
  }
  const after = status.jevStatus(undefined, Date.now(), settings)
  if (after.kind !== 'ready') {
    for (const index of failed) {
      const row = rows[index]!
      if (!row.ask.ok && row.ask.kind !== 'bad-request') row.ask = { ok: false, kind: after.kind, words: `${after.words} | ${row.ask.words}` }
    }
  }
  return rows
}

export async function askJev(evidence: JevAskEvidence, questions: JevAskQuestions): Promise<JevAsk> {
  const [row] = await askJevBatch([{ id: 'one', evidence }], questions, 1)
  return row!.ask
}
