#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'ref-durability-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/engine/tasks/tasks.js')
const { agentAdapter } = await import('../../src/integrations/resources/adapters/agent.js')
const { boundedTextView, parseMercuryRef } = await import('../../src/integrations/resources/contracts.js')
const { getCrewmateTranscriptPath } = await import('../../src/sessions/transcripts/paths.js')
const { asAgentId } = await import('../../src/sessions/transcripts/ids.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ctx = { getAppState: () => ({ tasks: {} }) } as never
type Resolved = {
  state: string
  note?: string
  resource?: {
    text?: string
    summary?: string
    structured?: { page?: { cursor: number; hasMore: boolean; total: number }; status?: string }
  }
}
const resolve = async (refText: string): Promise<Resolved> =>
  (await agentAdapter.resolve(parseMercuryRef(refText)!, ctx)) as Resolved

section('§A a settled agent outlives the registry (disk probe on miss)')
{
  const id = 'aref-durable-1'
  const file = getCrewmateTranscriptPath(asAgentId(id))
  mkdirSync(dirname(file), { recursive: true })
  const rows = Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      message: { content: [{ type: 'text', text: `line-${i + 1}` }] },
    }),
  )
  writeFileSync(file, rows.join('\n'))

  const hit = await resolve(`mercury://agent/${id}`)
  check('registry miss + record on disk resolves OK (never absent)', hit.state === 'ok', JSON.stringify(hit).slice(0, 120) + ' · resolve in src/integrations/resources/adapters/agent.ts must read the transcript on disk when the registry has no task')
  check("the summary reads the transcript on disk for the end — a file of raw lines the codec cannot read says so, never a fabricated live status",
    /^no readable rows \(transcript on disk\)/.test(hit.resource?.summary ?? ''), (hit.resource?.summary ?? '') + ' · fix the summary text of the disk-transcript branch in src/integrations/resources/adapters/agent.ts')

  const missing = await resolve('mercury://agent/aref-nosuch')
  check('a genuinely recordless id still answers absent', missing.state === 'absent', 'got state ' + missing.state + ' · resolve in src/integrations/resources/adapters/agent.ts must answer absent when neither the registry nor the disk has the id')
}

section('§B tail-by-default + the page is always reachable')
{
  const id = 'aref-durable-1'
  const hit = await resolve(`mercury://agent/${id}`)
  const text = hit.resource?.text ?? ''
  check('the default window is the TAIL (last line present)', /line-300/.test(text), 'resolve in src/integrations/resources/adapters/agent.ts must pass defaultToTail to boundedTextView in src/integrations/resources/contracts.ts')
  check('…and the head is NOT in the default window', !/"line-1"/.test(text) && !/line-1\b/.test(text.split('\n')[0] ?? 'x'), 'the default window must start at total minus limit; see boundedTextView in src/integrations/resources/contracts.ts')
  const page = hit.resource?.structured?.page
  check('structured carries the page', page !== undefined && page.total === 300, JSON.stringify(page) + ' · the agent adapter in src/integrations/resources/adapters/agent.ts must put boundedTextView page into structured.page')
  check('the tail window is anchored at total−limit', page?.cursor === 200, String(page?.cursor) + ' · boundedTextView in src/integrations/resources/contracts.ts must anchor the tail window at total minus limit')
  check('an explicit hint line names the window and how to page',
    /\[lines 201–300 of 300 — page with \?cursor=<n>&limit=<n>\]/.test(text),
    String(text.split('\n').slice(-1)[0]) + ' · the paging hint line is written from the boundedTextView page in src/integrations/resources/contracts.ts')

  const paged = await resolve(`mercury://agent/${id}?cursor=0&limit=5`)
  const pagedText = paged.resource?.text ?? ''
  check('an explicit cursor pages from the head deterministically',
    /line-1\b/.test(pagedText) && /line-5\b/.test(pagedText) && !/line-6\b/.test(pagedText), 'an explicit cursor and limit must page from the head; see boundedTextView in src/integrations/resources/contracts.ts')
  check('the paged view reports hasMore', paged.resource?.structured?.page?.hasMore === true, 'boundedTextView in src/integrations/resources/contracts.ts must set page.hasMore when lines remain after the window')
}

section('§C the shared view law')
{
  const long = Array.from({ length: 50 }, (_, i) => `row-${i + 1}`).join('\n')
  const tail = boundedTextView(long, {}, 10, { defaultToTail: true })
  check('boundedTextView defaultToTail serves the last window',
    tail.text.startsWith('row-41') && tail.page.cursor === 40 && tail.page.hasMore === false, JSON.stringify(tail.page) + ' · defaultToTail in boundedTextView, src/integrations/resources/contracts.ts, must serve the last window')
  const head = boundedTextView(long, {}, 10)
  check('without the option the historical head behavior is untouched',
    head.text.startsWith('row-1') && head.page.cursor === 0 && head.page.hasMore === true, JSON.stringify(head.page) + ' · boundedTextView in src/integrations/resources/contracts.ts must keep the head window when defaultToTail is not set')
  const explicit = boundedTextView(long, { cursor: 20, limit: 10 } as never, 10, { defaultToTail: true })
  check('an explicit cursor beats the tail default', explicit.text.startsWith('row-21'), explicit.text.slice(0, 40) + ' · boundedTextView in src/integrations/resources/contracts.ts must let an explicit cursor win over defaultToTail')
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} REF-DURABILITY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL REF-DURABILITY PROOFS PASS')
process.exit(0)
