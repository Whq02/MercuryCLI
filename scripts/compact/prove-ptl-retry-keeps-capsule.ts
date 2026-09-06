#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ptl-capsule-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'ptl-capsule-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { truncateHeadForPTLRetry } = await import(join(SRC, 'services/compact/compact.ts'))
const { createUserMessage, createAssistantMessage, createAssistantAPIErrorMessage, createCompactBoundaryMessage, isCompactBoundaryMessage } =
  await import(join(SRC, 'utils/messages.ts'))
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import(join(SRC, 'services/api/errors.ts'))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Msg = { type: string; uuid: string; isCompactSummary?: boolean; isMeta?: boolean; message?: { content?: unknown } }

const isCapsule = (m: Msg): boolean => isCompactBoundaryMessage(m as never) || (m.type === 'user' && m.isCompactSummary === true)
const isMarker = (m: Msg): boolean => m.type === 'user' && m.isMeta === true && typeof m.message?.content === 'string' && m.message.content.includes('folded for the compaction retry')
const uuids = (list: Msg[]): string[] => list.map(m => m.uuid)
const working = (list: Msg[]): number => list.filter(m => !isCapsule(m) && !isMarker(m)).length

function round(n: number): Msg[] {
  const filler = `round ${n}: ${'the work of this turn, spelled long enough to weigh some tokens. '.repeat(8)}`
  return [
    createUserMessage({ content: `prompt ${n}: ${filler}` }) as unknown as Msg,
    createAssistantMessage({ content: `answer ${n}: ${filler}` }) as unknown as Msg,
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: `result ${n}: ${filler}` }] as never }) as unknown as Msg,
  ]
}

function capsule(label: string): { boundary: Msg; summary: Msg } {
  const boundary = createCompactBoundaryMessage('auto', 120_000) as unknown as Msg
  const summary = createUserMessage({
    content: `${label}: the summary of everything folded before this point — decisions, file state, the task.`,
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  }) as unknown as Msg
  return { boundary, summary }
}

function onceCompacted(rounds: number): { boundary: Msg; summary: Msg; messages: Msg[] } {
  const { boundary, summary } = capsule('SUMMARY-1')
  const messages: Msg[] = [boundary, summary]
  for (let n = 1; n <= rounds; n++) messages.push(...round(n))
  return { boundary, summary, messages }
}

function ptl(gap: number): Msg {
  const limit = 100_000
  return createAssistantAPIErrorMessage({
    content: `${PROMPT_TOO_LONG_ERROR_MESSAGE}: ${limit + gap} tokens > ${limit} maximum`,
    error: 'invalid_request',
    errorDetails: `prompt is too long: ${limit + gap} tokens > ${limit} maximum`,
  }) as unknown as Msg
}

function ptlUnknownGap(): Msg {
  return createAssistantAPIErrorMessage({ content: PROMPT_TOO_LONG_ERROR_MESSAGE, error: 'invalid_request' }) as unknown as Msg
}

function truncate(messages: Msg[], response: Msg): Msg[] | null {
  return truncateHeadForPTLRetry(messages as never, response as never) as Msg[] | null
}

console.log('L1 a once-compacted conversation: the drop sheds the head working prompt, never the capsule')
{
  const { boundary, summary, messages } = onceCompacted(6)
  const out = truncate(messages, ptl(150))
  check('the retry makes progress', out !== null && working(out) < working(messages), `${out ? working(out) : 'null'}/${working(messages)}`)
  if (out !== null) {
    const ids = uuids(out)
    check('the boundary survives the drop', ids.includes(boundary.uuid))
    check('the previous compact summary survives the drop', ids.includes(summary.uuid))
    check('the capsule rides ahead of the survivors, in order', ids[0] === boundary.uuid && ids[1] === summary.uuid, ids.slice(0, 3).join(','))
    const headPrompt = messages[2] as Msg
    check('the head working prompt is the one shed', !ids.includes(headPrompt.uuid))
    check('every survivor is a working row or the capsule or the marker', out.every(m => isCapsule(m) || isMarker(m) || messages.some(x => x.uuid === m.uuid)))
  }
}

console.log('L2 three retries in a row: the capsule rides every one, each strictly shrinks, one marker')
{
  const { boundary, summary, messages } = onceCompacted(8)
  let current: Msg[] = messages
  let step = 0
  for (; step < 3; step++) {
    const next = truncate(current, ptl(150))
    check(`retry ${step + 1}: progress`, next !== null && working(next) < working(current), `${next ? working(next) : 'null'}/${working(current)}`)
    if (next === null) break
    const ids = uuids(next)
    check(`retry ${step + 1}: boundary + summary retained, in front`, ids[0] === boundary.uuid && ids[1] === summary.uuid, ids.slice(0, 2).join(','))
    const markers = next.filter(isMarker)
    check(`retry ${step + 1}: exactly one fold marker, seated after the capsule`, markers.length === 1 && ids.indexOf(markers[0]!.uuid) === 2, `markers=${markers.length} at ${markers[0] ? ids.indexOf(markers[0].uuid) : -1}`)
    current = next
  }
  check('three retries ran', step === 3)
}

console.log('L3 an unknown gap: the proportional drop keeps the capsule and sheds the head round')
{
  const { boundary, summary, messages } = onceCompacted(6)
  const out = truncate(messages, ptlUnknownGap())
  check('progress', out !== null && working(out) < working(messages), `${out ? working(out) : 'null'}/${working(messages)}`)
  if (out !== null) {
    const ids = uuids(out)
    check('capsule retained in front', ids[0] === boundary.uuid && ids[1] === summary.uuid)
    check('the head working prompt is gone', !ids.includes((messages[2] as Msg).uuid))
  }
}

console.log('L4 two capsules (older pair kept by a from-direction partial): both retained, in order')
{
  const older = capsule('SUMMARY-OLD')
  const newer = capsule('SUMMARY-NEW')
  const messages: Msg[] = [older.boundary, older.summary, ...round(1), ...round(2), newer.boundary, newer.summary, ...round(3), ...round(4), ...round(5)]
  const out = truncate(messages, ptl(700))
  check('progress', out !== null && working(out) < working(messages), `${out ? working(out) : 'null'}/${working(messages)}`)
  if (out !== null) {
    const ids = uuids(out)
    const order = [older.boundary, older.summary, newer.boundary, newer.summary].map(m => ids.indexOf(m.uuid))
    check('all four capsule rows retained', order.every(i => i >= 0), order.join(','))
    check('in their original order', order.every((i, k) => k === 0 || i > (order[k - 1] as number)), order.join(','))
    check('the older working rounds are shed', !ids.includes((messages[2] as Msg).uuid) && !ids.includes((messages[5] as Msg).uuid))
  }
}

console.log('L5 controls')
{
  const plain: Msg[] = [...round(1), ...round(2), ...round(3), ...round(4)]
  const out = truncate(plain, ptl(150))
  check('capsule-free: the head round is gone', out !== null && !uuids(out).includes((plain[0] as Msg).uuid))
  check('capsule-free: the marker leads when the survivors open on an assistant', out !== null && (isMarker(out[0] as Msg) || (out[0] as Msg).type === 'user'), out ? (out[0] as Msg).type : 'null')

  const { messages } = onceCompacted(1)
  const first = truncate(messages, ptl(150))
  check('capsule + one round: the prompt is shed once', first !== null && working(first) === working(messages) - 1, `${first ? working(first) : 'null'}/${working(messages)}`)
  const second = first === null ? null : truncate(first, ptl(150))
  check('…then the retry answers null rather than shed the capsule', second === null, second === null ? '' : `got ${second.length} rows`)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
