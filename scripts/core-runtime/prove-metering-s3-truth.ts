#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['MERCURY_EFFORT_LEVEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'MERCURY_AUTH_SCOPE_DIR']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-s3-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('the metering S3 rows, each at its owner')




section('§22 the compaction trace subtracts the true post figure')
{
  const t = await import('./turnScenarios.ts')
  const { makeRequest } = await import('../../src/engine/loop/turn/makeRequest.ts')
  const trace = await import('../../src/platform/observability/invocationTrace.ts')
  const freedByAFold = async (truePost: number | undefined): Promise<Array<number | undefined>> => {
    const landed = t.fixtures.folded()
    Object.assign(landed.compactionResult as object, { preCompactTokenCount: 900, postCompactTokenCount: 700, truePostCompactTokenCount: truePost })
    const planted = await t.plantRun({ env: { MERCURY_TRACE: '1' }, seed: [t.fixtures.ask('hello there rig'), t.fixtures.fat('old fat turn', 700)], autocompact: [landed], script: [] })
    const path = trace.getInvocationTracePath()
    const stood = existsSync(path) ? readFileSync(path, 'utf8').length : 0
    await t.drain(makeRequest(planted.run as never, planted.state as never, 1))
    const written = (): Array<number | undefined> =>
      (existsSync(path) ? readFileSync(path, 'utf8').slice(stood) : '')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as { kind?: string; event?: string; tokensFreed?: number })
        .filter(row => row.kind === 'compaction' && row.event === 'auto-compact')
        .map(row => row.tokensFreed)
    const deadline = Date.now() + 2_000
    while (written().length === 0 && Date.now() < deadline) {
      await trace.flushTraceNow()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    planted.close()
    return written()
  }
  const withTrueFigure = await freedByAFold(120)
  const withoutTrueFigure = await freedByAFold(undefined)
  check('tokensFreed = pre − (truePostCompactTokenCount ?? postCompactTokenCount)', JSON.stringify(withTrueFigure) === '[780]' && JSON.stringify(withoutTrueFigure) === '[200]', `a fold of 900 tokens whose summary call used 700 and whose true post figure is 120 traced ${JSON.stringify(withTrueFigure)} (780 is right); the same fold with no true figure traced ${JSON.stringify(withoutTrueFigure)} (200 is right) — the auto-compact trace of src/engine/loop/turn/makeRequest.ts subtracts the true post figure and falls back to the call's own only when there is none`)
  check('…never pre − the summarisation call\'s own usage', withTrueFigure.length === 1 && withTrueFigure[0] !== 900 - 700, `with a true post figure of 120 the trace reads ${JSON.stringify(withTrueFigure)}: 200 is pre − the summary call's own 700`)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-metering-s3-truth${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
