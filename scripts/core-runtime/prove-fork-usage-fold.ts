#!/usr/bin/env bun
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
  const single = settleForkUsageFold(foldAll([
    start({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
    delta({ input_tokens: 1234, cache_creation_input_tokens: 0, cache_read_input_tokens: 300, output_tokens: 56 }),
    stop,
  ]))
  check('the single-delta lanes fold their complete final delta', single.input_tokens === 1234 && single.cache_read_input_tokens === 300 && single.output_tokens === 56, JSON.stringify(single))
}

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
