#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-fork-usage-fold.ts — the forked agent folds
//  usage the way the engine folds the same wire (FN-018 rank 8: the fork
//  folded message_delta frames alone, so every /console ask on the
//  Anthropic lane reported 0 prompt tokens, 0 cache-read, 0 cache-write).
//
//  The input-side fields arrive REAL in message_start and reappear as an
//  explicit 0 in every message_delta (cacheAndUsage documents the wire
//  contract and updateUsage's greater-than-zero guard exists for exactly
//  that zero). runForkedAgent accumulated deltas with no guard and never
//  read message_start, so a console ask re-sending a 45,000-token parent
//  context printed a prompt side of 0 on the /console receipt and the Helm
//  telemetry rail, and the cache-hit badge could never light — cache
//  sharing with the parent prefix being the fork's stated purpose. The
//  non-Anthropic lanes emit one complete final delta and were right by
//  accident.
//
//   §1 the pure fold: start seeds · delta replaces under the guard · stop
//      accumulates — the Anthropic three-frame shape
//   §2 two responses in one fork add; the single-delta lanes still fold
//   §3 a response a lane never closed still counts at settlement
//   §4 the shape: runForkedAgent rides the fold and settles through it
//
//  Run:  ~/.bun/bin/bun run scripts/core-runtime/prove-fork-usage-fold.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-fork-fold-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const fork = await import('../../src/utils/forkedAgent.ts')
const { EMPTY_FORK_USAGE_FOLD, foldForkUsageEvent, settleForkUsageFold } = fork

const start = (usage: Record<string, number>) => ({ type: 'message_start', message: { usage } })
const delta = (usage: Record<string, number>) => ({ type: 'message_delta', usage })
const stop = { type: 'message_stop' }
const foldAll = (events: Array<Record<string, unknown>>) => events.reduce((f, e) => foldForkUsageEvent(f, e as never), EMPTY_FORK_USAGE_FOLD)

console.log('the fork folds usage like the engine — start seeds, delta replaces, stop accumulates')

// ── §1 the three-frame shape ────────────────────────────────────────────────
section('§1 the Anthropic three-frame shape: the prompt side survives the delta\'s explicit zeros')
{
  const events = [
    start({ input_tokens: 900, cache_creation_input_tokens: 8000, cache_read_input_tokens: 45000, output_tokens: 1 }),
    delta({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 120 }),
    stop,
  ]
  const total = settleForkUsageFold(foldAll(events))
  check('THE PROMPT SIDE IS THE START FRAME\'S (the base reported 0 in / 0 cache-read)', total.input_tokens === 900 && total.cache_read_input_tokens === 45000 && total.cache_creation_input_tokens === 8000, JSON.stringify(total))
  check("the output is the delta's cumulative count", total.output_tokens === 120)
  const midway = foldAll(events.slice(0, 2))
  check('before message_stop nothing has joined the total (a response settles once)', midway.total.input_tokens === 0 && midway.open?.input_tokens === 900)
}

// ── §2 two responses · the single-delta lanes ───────────────────────────────
section('§2 two responses in one fork ADD; the single-delta lanes still fold')
{
  const events = [
    start({ input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 1 }),
    delta({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }),
    stop,
    start({ input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 5100, output_tokens: 1 }),
    delta({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 60 }),
    stop,
  ]
  const total = settleForkUsageFold(foldAll(events))
  check('two responses add on every counter', total.input_tokens === 300 && total.cache_read_input_tokens === 10100 && total.output_tokens === 100, JSON.stringify(total))
  // The compat/openai/zai shape: a message_start with zeros, ONE complete delta.
  const single = settleForkUsageFold(foldAll([
    start({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
    delta({ input_tokens: 1234, cache_creation_input_tokens: 0, cache_read_input_tokens: 300, output_tokens: 56 }),
    stop,
  ]))
  check('the single-delta lanes fold their complete final delta', single.input_tokens === 1234 && single.cache_read_input_tokens === 300 && single.output_tokens === 56, JSON.stringify(single))
}

// ── §3 an unclosed response ─────────────────────────────────────────────────
section('§3 a response a lane never closed with message_stop still counts at settlement')
{
  const total = settleForkUsageFold(foldAll([
    start({ input_tokens: 700, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }),
    delta({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }),
  ]))
  check('the open response settles into the total', total.input_tokens === 700 && total.output_tokens === 9, JSON.stringify(total))
  check('an empty stream settles to the zero record', settleForkUsageFold(EMPTY_FORK_USAGE_FOLD).input_tokens === 0)
  check('an unrelated event leaves the fold untouched', foldForkUsageEvent(EMPTY_FORK_USAGE_FOLD, { type: 'content_block_delta' } as never) === EMPTY_FORK_USAGE_FOLD)
}

// ── §4 the shape ────────────────────────────────────────────────────────────
section('§4 the shape: runForkedAgent rides the fold')
{
  const src = readFileSync(join(ROOT, 'src/utils/forkedAgent.ts'), 'utf8')
  const run = src.slice(src.indexOf('export async function runForkedAgent'))
  check('the loop folds every stream event through foldForkUsageEvent', /fold = foldForkUsageEvent\(fold, item\.event/.test(run))
  check('the total is settled through settleForkUsageFold', /const usage = settleForkUsageFold\(fold\)/.test(run))
  check('the base\'s delta-only accumulation is gone', !/event\.type === 'message_delta'\)\s*\{\s*const delta = usageOf/.test(run))
  check('the fold imports the engine\'s own guard (updateUsage)', /import \{ accumulateUsage, updateUsage \} from '\.\.\/services\/providers\/anthropic\/cacheAndUsage\.js'/.test(src))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-fork-usage-fold${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
