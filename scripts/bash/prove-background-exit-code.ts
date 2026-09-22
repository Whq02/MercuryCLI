#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isResult, makeTally, sleep, user } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-background-exit-code')
const HOME = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'background-exit-code-pure-')))
process.env.MERCURY_CONFIG_DIR = HOME

tally.section('§1 pure: the folded row reads the notice word as it read the old one')
{
  const { foldedSummary } = await import('../../src/utils/collapseBackgroundBashNotifications.ts')
  type Notice = Parameters<typeof foldedSummary>[0][number]
  const notice = (status: Notice['status'], detail: string): Notice => ({ message: {} as Notice['message'], shape: 'attachment', status, detail, queued: false })
  const withNewWord = foldedSummary([notice('completed', '"lint" completed (exit code 0)'), notice('failed', '"grep" ended (exit code 1)'), notice('completed', '"unit tests" completed (exit code 0)')])
  tally.check('a non-zero exit told as "ended (exit code N)" folds to the title and the code', withNewWord === '3 background commands · 2 done · 1 failed — "grep" (exit code 1)', withNewWord)
  const withOldWord = foldedSummary([notice('completed', '"lint" completed (exit code 0)'), notice('failed', '"grep" failed (exit code 1)'), notice('completed', '"unit tests" completed (exit code 0)')])
  tally.check("an older record's \"failed (exit code N)\" folds the same way", withOldWord === '3 background commands · 2 done · 1 failed — "grep" (exit code 1)', withOldWord)
}
rmSync(HOME, { recursive: true, force: true })

tally.section('§2 the built product: a benign non-zero exit is told to the model by its code, not as a failure')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  tally.finish()
}
console.log(`  build under proof: ${DIST}`)
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'background-exit-code-')))
const runHome = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(runHome, cwd)
writeFileSync(join(cwd, 'haystack.txt'), 'needle\n')
const DESCRIPTION = 'benign grep with no match'
const script: Script = req => {
  if (req.allTexts.some(t => t.includes('Background command'))) return [{ type: 'text', text: 'notice read' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -c zzz haystack.txt', description: DESCRIPTION, run_in_background: true } }]
  return [{ type: 'text', text: 'launched' }]
}
const fixture = await startScriptedFixture(script)
const port = Number(new URL(fixture.base).port)
const runner = bootRunner({ cwd, env: childEnv(runHome, port) })
runner.send(user('background exit probe', randomUUID()))
const first = await runner.waitFor('first result', isResult, bound(60_000))
tally.check('the launching turn settled', first !== null && first.subtype === 'success', JSON.stringify(first).slice(0, 120))
await sleep(3_000)
const after = runner.frames.length
runner.send(user('what happened to the background command?', randomUUID()))
const second = await runner.waitFor('the notice-carrying turn', isResult, bound(60_000), after)
tally.check('the next input line settled a second turn', second !== null, JSON.stringify(second).slice(0, 120))
await runner.stop(bound(5_000))
for (const r of fixture.requests) console.log(`  request ${r.n} step ${r.step} · results ${JSON.stringify(r.results.map(x => ({ isError: x.isError, text: x.text.slice(0, 160) })))} · texts ${JSON.stringify(r.allTexts.map(t => t.slice(0, 120)))}`)
const notices = fixture.requests.flatMap(r => r.allTexts.filter(t => t.includes('Background command')))
const summaries = notices.map(n => /<summary>([^<]*)<\/summary>/.exec(n)?.[1] ?? n.split('\n')[0] ?? '')
console.log(`  notices seen by the model: ${JSON.stringify(summaries)}`)
tally.check('the model was told about the finished command', notices.length > 0)
tally.check('the notice names the exit code', summaries.some(s => s.includes('exit code 1')), summaries[0] ?? 'no notice')
tally.check('a benign non-zero exit (grep with no match, exit 1) is not told as a failure', notices.length > 0 && !summaries.some(s => /failed/.test(s)), summaries[0] ?? 'no notice')
tally.check('the status field keeps its word (the summary changes, the status does not)', notices.some(n => n.includes('<status>failed</status>')))
await fixture.close()
rmSync(root, { recursive: true, force: true })
tally.finish()
