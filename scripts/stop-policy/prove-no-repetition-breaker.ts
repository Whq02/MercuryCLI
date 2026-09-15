#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  bootRunner,
  bound,
  childEnv,
  isInit,
  isResult,
  j,
  makeTally,
  removeWorld,
  REPO,
  SCRATCH_ROOT,
  seedHome,
  user,
} from '../daemon/dupline-world.ts'
import { REREAD_ASK, REREAD_END, REREAD_ROUNDS, startRereadFixture, type Hit } from './prove-no-stagnation-governor.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { check, section, finish, failed } = makeTally('prove-no-repetition-breaker')

const BREAKER_NAMES =
  /identicalFailureGuard|repetition_breaker|error_repetition_breaker|IDENTICAL_FAILURES_TO|IDENTICAL_RESULTS_TO|IDENTICAL_RETRY_NUDGE|IDENTICAL_RESULT_NUDGE|takeRepetitionStop|repetitionStopNotice|consultRepetitionGuard|consultRoundRepetitionGuard|REPETITION_STOP_WORDS|repetition-stop|Stopped this turn/
const RELEASE_NOTES = ['src/constants/changelog.ts']
const THIS = 'scripts/stop-policy/prove-no-repetition-breaker.ts'

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (/\.(tsx?|md|txt|sh|json)$/.test(entry)) yield path
  }
}
function offenders(dir: string, pattern: RegExp, except: string[] = []): string[] {
  const hits: string[] = []
  for (const file of sourceFiles(dir)) {
    const rel = file.slice(REPO.length + 1)
    if (except.includes(rel) || rel === THIS) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${rel}:${index + 1}`)
    })
  }
  return hits
}
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

if (import.meta.main) {
  section('§1 the repetition breaker is gone from the tree')
  check('the guard module is gone', !existsSync(join(REPO, 'src/services/tools/identicalFailureGuard.ts')))
  const named = offenders(join(REPO, 'src'), BREAKER_NAMES, RELEASE_NOTES)
  check('nothing under src names the breaker, its bounds, its nudges, its stop or its result subtype', named.length === 0, named.slice(0, 12).join(' · '))
  const orchestration = src('src/services/tools/toolOrchestration.ts')
  check('the tool orchestration consults no guard and refuses no call for repeating', !/Guard|refus/i.test(orchestration))
  const schema = src('src/entrypoints/sdk/coreSchemas.ts')
  check('the SDK result schema carries no repetition subtype', !schema.includes('repetition'))
  const agent = src('src/tools/AgentTool/agentToolUtils.ts')
  check('a sub-agent outcome has no repetition-stop reason', !agent.includes('repetition'))
  const scriptsNamed = offenders(join(REPO, 'scripts'), BREAKER_NAMES)
  check('no proof pins the breaker', scriptsNamed.length === 0, scriptsNamed.slice(0, 12).join(' · '))
  const durability = src('docs/DURABILITY.md').replace(/\s+/g, ' ')
  check('the durability page says no call is refused for repeating and no repeated result ends a turn', durability.includes('no call is refused for repeating an earlier one') && durability.includes('no watcher ends a turn on a repeated call or a repeated result'))

  section('§2 on the built product, twenty identical reads of an unchanged file run to the model’s own end')
  const home = join(SCRATCH_ROOT, `mercury-no-breaker-${process.pid}`)
  const cwd = join(home, 'repo')
  seedHome(home, cwd)
  const notes = join(cwd, 'notes.md')
  const fixture = await startRereadFixture(notes, REREAD_ROUNDS, false)
  const failedAtOpen = failed()
  const runner = bootRunner({ cwd, env: childEnv(home, fixture.port), extraArgv: ['--allowed-tools', 'Write,Read'] })
  runner.send(user(REREAD_ASK, '00000000-0000-4000-8000-000000000000'))
  const init = await runner.waitFor('the init frame', isInit, bound(90_000))
  const result = await runner.waitFor('the turn result', isResult, bound(240_000))
  await runner.stop(bound(8_000))
  await fixture.close()
  const hits = fixture.hits
  const arms = (arm: string): Hit[] => hits.filter(h => h.arm === arm)
  const resultText = String(result?.result ?? '')
  check('the runner booted and the turn settled', init !== null && result !== null, runner.stderr().split('\n').slice(-6).join(' | '))
  check('the file never changed: one line written, nothing appended', existsSync(notes) && readFileSync(notes, 'utf8') === 'line 0\n')
  check(`the model read the unchanged file ${REREAD_ROUNDS} times and every read ran`, arms('read').length === REREAD_ROUNDS && arms('write').length === 1, j(hits.map(h => [h.n, h.arm, h.step, h.refused])))
  check('no read was refused: every tool result the model saw was the file itself, never an error', hits.filter(h => h.arm !== 'svc').every(h => !h.refused), j(hits.filter(h => h.refused).map(h => h.n)))
  check('no nudge rode the wire (no "in a row" correction in any request)', hits.every(h => !h.nudged), j(hits.filter(h => h.nudged).map(h => h.n)))
  check('the turn ended only when the model ended it: the result is the model’s own last words, not a stop', result?.subtype === 'success' && resultText === REREAD_END, `${String(result?.subtype)}: ${resultText.slice(0, 160)}`)
  if (failed() === failedAtOpen) await removeWorld(home)
  else console.log(`  [forensics] the world stays at ${home}\n${runner.stderr().split('\n').slice(-12).join('\n')}`)

  finish()
}
