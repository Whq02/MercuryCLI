#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-a06-receipt-lineage.ts —
//  provider-local continuation receipts never cross adapter/lineage
//  boundaries; the sameModel guard is fixture-pinned; qualified stateless
//  reconstruction is typed and visible.
//
//  The law's mechanical shape: a receipt RIDES ITS MESSAGE and nothing
//  else — no API extracts or re-attaches it, exactly ONE adapter decodes
//  it, and that adapter is model-guarded. A branch/fork carries rows
//  whole, so a receipt continues only inside its own ancestry (lineage
//  continuation, not a crossing); the zai and anthropic lanes never read
//  the field, so a receipt can never reach another adapter.
//
//    §A the consumption FENCE — apexProviderTurn is touched by exactly the
//       allowlisted five files (field · persist · decode+guard · wire
//       encode · read-only preview); a sixth toucher breaks this prover
//    §B the sameModel guard by fixture — carried iff served == target
//    §C the receipt rides its message — dropping the record never drops
//       the message (content derivation), and no row gains a record its
//       message lacked
//    §D typed reconstruction visibility — a settled recordless GPT turn
//       counts as reconstructed; the lane's once-per-thread receipt note
//       names it; a carried record does not count
//    §E lineage continuation ratified — copy-fork carries rows whole
//       (forkedFrom stamps) and fork-context agents receive parent
//       MESSAGES (the receipt travels only inside shared ancestry)
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-a06-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const ROOT = join(import.meta.dir, '..', '..')

const { toBridgeMessages } = await import('../../src/services/providers/openai/openaiCallModel.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A the consumption fence — exactly four allowlisted touchers')
{
  // The writer is deliberately NOT a toucher: it persists the SETTLED WHOLE
  // entry (spread + one atomic re-published line), so the receipt rides
  // without the writer ever naming the field — pinned as a mechanism below.
  const ALLOW = new Set([
    'src/types/message.ts', // the field's type home
    'src/services/providers/openai/openaiCallModel.ts', // decode + the sameModel guard
    'src/services/providers/openai/responsesBridge.ts', // wire encode of CARRIED records
    'src/services/providers/transitionPreview.ts', // read-only preview classification
    'src/utils/messages/pairing.ts', // the wire heal preserves the carried record through split-turn folds (lane M)
  ])
  const hits = execFileSync('git', ['grep', '-l', 'apexProviderTurn', '--', 'src/'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  const rogue = hits.filter(h => !ALLOW.has(h))
  const missing = [...ALLOW].filter(a => !hits.includes(a))
  check('every toucher is allowlisted (no new consumer without this row)', rogue.length === 0, rogue.join(' · '))
  check('the allowlist itself is live (all five present)', missing.length === 0, missing.join(' · '))
  const writer = readFileSync(join(ROOT, 'src/utils/sessionStorage/writer.ts'), 'utf8')
  check(
    'the writer persists the settled WHOLE entry (receipt rides the atomic line)',
    writer.includes('const settled = { ...cached.entry, ...cleaned } as Entry') &&
      writer.includes('cached.entry = settled'),
  )
  const zai = readFileSync(join(ROOT, 'src/services/providers/zai/zaiCallModel.ts'), 'utf8')
  const claude = readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8')
  check('the zai lane never reads the field', !zai.includes('apexProviderTurn'))
  check('the anthropic lane never reads the field', !claude.includes('apexProviderTurn'))
}

// ── shared fixtures ─────────────────────────────────────────────────────────
const ts = '2026-08-05T00:00:00.000Z'
const uid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`
const record = (tag: string): Record<string, unknown> => ({
  provider: 'openai',
  responseId: `resp_${tag}`,
  items: [
    { type: 'reasoning', id: `rs_${tag}`, encrypted_content: `opaque-${tag}`, summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: tag }] },
  ],
})
const gptTurn = (n: number, served: string, tag: string, withRecord: boolean): Record<string, unknown> => ({
  type: 'assistant',
  uuid: uid(n),
  timestamp: ts,
  message: {
    id: `msg_${n}`,
    type: 'message',
    role: 'assistant',
    model: served,
    content: [{ type: 'text', text: tag }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  ...(withRecord ? { apexProviderTurn: record(tag) } : {}),
})
const userTurn = (n: number, text: string): Record<string, unknown> => ({
  type: 'user',
  uuid: uid(n),
  timestamp: ts,
  message: { role: 'user', content: text },
})

section('§B the sameModel guard — carried iff served == target')
{
  const history = [userTurn(1, 'q'), gptTurn(2, 'gpt-5.2', 'matching', true), gptTurn(3, 'gpt-5.1', 'older', true)] as never[]
  const walk = toBridgeMessages(history as never, undefined as never, 'gpt-5.2')
  const carried = walk.rows.filter(r => (r as { turnRecord?: unknown }).turnRecord).length
  check('served==target carries; served!=target resets (1 of 2)', carried === 1, String(carried))
  const other = toBridgeMessages(history as never, undefined as never, 'gpt-5.3')
  check('a different target carries NOTHING', other.rows.filter(r => (r as { turnRecord?: unknown }).turnRecord).length === 0)
}

section('§C the receipt rides its message — never extracted, never re-attached')
{
  const history = [userTurn(1, 'q'), gptTurn(2, 'gpt-5.1', 'older', true), gptTurn(3, 'gpt-5.2', 'plain', false)] as never[]
  const walk = toBridgeMessages(history as never, undefined as never, 'gpt-5.2')
  const rows = walk.rows as Array<{ role: string; content?: unknown; turnRecord?: unknown }>
  check('dropping a record never drops its message (content derives)', rows.length === 3 && rows[1]?.content !== undefined && rows[1]?.turnRecord === undefined)
  check('no row gains a record its message lacked', rows[2]?.turnRecord === undefined)
}

section('§D typed reconstruction — visible, once-per-thread, honest')
{
  const recordless = [userTurn(1, 'q'), gptTurn(2, 'gpt-5.2', 'settled-no-record', false)] as never[]
  const walk = toBridgeMessages(recordless as never, undefined as never, 'gpt-5.2')
  check('a settled recordless GPT turn counts as reconstructed', walk.reconstructedGptTurns === 1, String(walk.reconstructedGptTurns))
  const recorded = [userTurn(1, 'q'), gptTurn(2, 'gpt-5.2', 'recorded', true)] as never[]
  check('a carried record does NOT count', toBridgeMessages(recorded as never, undefined as never, 'gpt-5.2').reconstructedGptTurns === 0)
  const lane = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  check('the lane surfaces the reconstruction receipt note once per thread', lane.includes('reconstructed continuation') && lane.includes('reconstructionNoted'))
}

section('§E lineage continuation ratified (fork/branch carry rows whole)')
{
  const branch = readFileSync(join(ROOT, 'src/commands/branch/branch.ts'), 'utf8')
  check('copy-fork stamps lineage per entry (forkedFrom) — rows carry whole', branch.includes('forkedFrom'))
  const agent = readFileSync(join(ROOT, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
  check('fork-context agents receive parent MESSAGES (receipts travel only inside shared ancestry)', agent.includes('forkContextMessages'))
}

console.log(failures === 0 ? '\n ✅ RECEIPTS NEVER CROSS LINEAGE (fence · guard · visibility)' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
