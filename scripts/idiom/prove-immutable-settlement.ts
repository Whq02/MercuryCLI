#!/usr/bin/env bun
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'idiom-settlement-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/tasks.js')
const { recordTranscript, settleTranscriptMessage, getProject, setSessionFileForTesting } = await import(
  '../../src/utils/sessionStorage/writer.js'
)
const { createAssistantMessage } = await import('../../src/utils/messages/factories.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.js')
const readLines = (p: string): Array<Record<string, unknown>> =>
  existsSync(p)
    ? decodeTranscriptBuffer<Record<string, unknown>>(readFileSync(p)).entries
    : []

const lastByUuid = (lines: Array<Record<string, unknown>>, uuid: string): Record<string, unknown> | undefined =>
  lines.filter(l => l.uuid === uuid).at(-1)

section('§A immutability — the drain persists the record AS PUBLISHED')
{
  const file = join(HOME, 'a-session.jsonl')
  setSessionFileForTesting(file)

  const msg = createAssistantMessage({ content: 'settled text' })
  const publishedOutputTokens = (msg.message.usage as { output_tokens: number }).output_tokens

  await recordTranscript([msg] as never)

  ;(msg.message.usage as { output_tokens: number }).output_tokens = 424242
  ;(msg.message as { stop_reason: string }).stop_reason = 'end_turn'

  await getProject().flush()

  const first = readLines(file).find(l => l.type === 'assistant') as
    | { message?: { usage?: { output_tokens?: number } } }
    | undefined
  check(
    'the as-published line carries publication-time usage (mutation not observed)',
    first?.message?.usage?.output_tokens === publishedOutputTokens,
    `published=${publishedOutputTokens} persisted=${first?.message?.usage?.output_tokens}`,
  )

  await settleTranscriptMessage(msg as never)
  await getProject().flush()
  const lines = readLines(file)
  const finalView = lastByUuid(lines, msg.uuid) as { message?: { usage?: { output_tokens?: number }; stop_reason?: string } }
  check(
    'explicit settlement supersedes: reader last-wins view shows final usage/stop',
    finalView?.message?.usage?.output_tokens === 424242 && finalView?.message?.stop_reason === 'end_turn',
    JSON.stringify(finalView?.message?.usage),
  )
  const countBefore = lines.filter(l => l.uuid === msg.uuid).length
  await settleTranscriptMessage(msg as never)
  await getProject().flush()
  const countAfter = readLines(file).filter(l => l.uuid === msg.uuid).length
  check('byte-identical settlement is skipped (no wasted lines)', countAfter === countBefore, `${countBefore} → ${countAfter}`)
}

section('§C atomic receipt — late-attached continuation receipt becomes durable with settlement')
{
  const file = join(HOME, 'c-session.jsonl')
  setSessionFileForTesting(file)

  const msg = createAssistantMessage({ content: 'gpt turn' })

  await recordTranscript([msg] as never)
  await getProject().flush()

  ;(msg as { apexProviderTurn?: unknown }).apexProviderTurn = {
    responseId: 'resp_er2_receipt',
    encryptedReasoning: 'opaque-continuation-material',
  }
  await settleTranscriptMessage(msg as never)
  await getProject().flush()

  const finalView = lastByUuid(readLines(file), msg.uuid) as { apexProviderTurn?: { responseId?: string } } | undefined
  check(
    'the reader last-wins view carries the continuation receipt (settlement+receipt atomic)',
    finalView?.apexProviderTurn?.responseId === 'resp_er2_receipt',
    'receipt missing from the settled line',
  )
}

console.log(failures === 0 ? '\n ✅ IMMUTABLE SETTLEMENT PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
