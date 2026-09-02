#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-ref-durability.ts — agent-ref durability + honest
//  paging.
//
//  What the code did vs the invariant it missed: mercury://agent/<id> is
//  advertised in every result envelope, but the detail view resolved ONLY
//  from the in-memory task registry — ~30s after settlement (panel grace →
//  eviction) the advertised ref answered absent while the durable record sat
//  readable on disk. And the model-facing transcript views served the HEAD
//  of the raw JSONL while their variable was literally named a tail, then
//  discarded the page metadata that would let a reader reach the end.
//
//  The invariant: a registry miss probes disk before answering absent; a
//  stream view defaults to the TAIL (the verdict lives at the end) while an
//  explicit cursor pages deterministically; and the page is always returned
//  — in structured AND as an explicit hint line.
//
//  Seams: the real agentAdapter.resolve + the real boundedTextView.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'ref-durability-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/tasks.js')
const { agentAdapter } = await import('../../src/services/resources/adapters/agent.js')
const { boundedTextView, parseMercuryRef } = await import('../../src/services/resources/contracts.js')
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.js')
const { asAgentId } = await import('../../src/types/ids.js')

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
  const file = getAgentTranscriptPath(asAgentId(id))
  mkdirSync(dirname(file), { recursive: true })
  const rows = Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      message: { content: [{ type: 'text', text: `line-${i + 1}` }] },
    }),
  )
  // no trailing newline — the splitter counts a trailing empty line as a row
  // (historical behavior shared by every consumer), which would shift the
  // fixture's expected page arithmetic by one.
  writeFileSync(file, rows.join('\n'))

  const hit = await resolve(`mercury://agent/${id}`)
  check('registry miss + record on disk resolves OK (never absent)', hit.state === 'ok', JSON.stringify(hit).slice(0, 120))
  check("the summary says settled-on-disk, not a fabricated live status",
    /settled \(record on disk\)/.test(hit.resource?.summary ?? ''), hit.resource?.summary)

  const missing = await resolve('mercury://agent/aref-nosuch')
  check('a genuinely recordless id still answers absent', missing.state === 'absent')
}

section('§B tail-by-default + the page is always reachable')
{
  const id = 'aref-durable-1'
  const hit = await resolve(`mercury://agent/${id}`)
  const text = hit.resource?.text ?? ''
  check('the default window is the TAIL (last line present)', /line-300/.test(text))
  check('…and the head is NOT in the default window', !/"line-1"/.test(text) && !/line-1\b/.test(text.split('\n')[0] ?? 'x'))
  const page = hit.resource?.structured?.page
  check('structured carries the page', page !== undefined && page.total === 300, JSON.stringify(page))
  check('the tail window is anchored at total−limit', page?.cursor === 200, String(page?.cursor))
  check('an explicit hint line names the window and how to page',
    /\[lines 201–300 of 300 — page with \?cursor=<n>&limit=<n>\]/.test(text),
    text.split('\n').slice(-1)[0])

  const paged = await resolve(`mercury://agent/${id}?cursor=0&limit=5`)
  const pagedText = paged.resource?.text ?? ''
  check('an explicit cursor pages from the head deterministically',
    /line-1\b/.test(pagedText) && /line-5\b/.test(pagedText) && !/line-6\b/.test(pagedText))
  check('the paged view reports hasMore', paged.resource?.structured?.page?.hasMore === true)
}

section('§C the shared view law + the second consumer')
{
  const long = Array.from({ length: 50 }, (_, i) => `row-${i + 1}`).join('\n')
  const tail = boundedTextView(long, {}, 10, { defaultToTail: true })
  check('boundedTextView defaultToTail serves the last window',
    tail.text.startsWith('row-41') && tail.page.cursor === 40 && tail.page.hasMore === false)
  const head = boundedTextView(long, {}, 10)
  check('without the option the historical head behavior is untouched',
    head.text.startsWith('row-1') && head.page.cursor === 0 && head.page.hasMore === true)
  const explicit = boundedTextView(long, { cursor: 20, limit: 10 } as never, 10, { defaultToTail: true })
  check('an explicit cursor beats the tail default', explicit.text.startsWith('row-21'))

  const wf = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'resources', 'adapters', 'workflow.ts'),
    'utf8',
  )
  check('the workflow raw-stream view is tail-by-default with the page surfaced',
    wf.includes('defaultToTail: true') && wf.includes('pageHint(view.page, shown)'))
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} REF-DURABILITY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL REF-DURABILITY PROOFS PASS')
process.exit(0)
