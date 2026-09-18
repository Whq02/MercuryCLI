#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  BG_AGENT_NOTICE,
  BG_SHELL_NOTICE,
  BG_SHELL_SECONDS,
  BG_SLEEP_DONE,
  BG_SLEEP_TURN_ASK,
  BG_SUB_SLEEP_SECONDS,
  doneText,
} from './dupline-fixture-words.ts'
import {
  bootRunner,
  bound,
  carrying,
  childEnv,
  describeRequests,
  DIST,
  exportWorld,
  isInit,
  isResult,
  j,
  makeTally,
  removeWorld,
  requestsOf,
  SCRATCH_ROOT,
  seedHome,
  startFixture,
  user,
  waitWire,
  type Fixture,
  type Runner,
  type Wire,
} from './dupline-world.ts'

const { check, section, finish, failed } = makeTally('prove-dupline-subagent-sleep')

const U0 = '00000000-0000-4000-8000-000000000000'
const UT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
type World = { name: string; home: string; fx: Fixture; runner: Runner; failedAtOpen: number }

async function openWorld(name: string): Promise<World> {
  const failedAtOpen = failed()
  const home = join(SCRATCH_ROOT, `mercury-dupline-${name}-${process.pid}`)
  const cwd = join(home, 'repo')
  seedHome(home, cwd)
  const fx = await startFixture(join(home, 'wire.jsonl'), 10, 6, 0)
  const runner = bootRunner({ cwd, env: childEnv(home, fx.port) })
  runner.send(user('hello there', U0))
  const init = await runner.waitFor('the init frame', isInit, bound(90_000))
  const first = await runner.waitFor('the first turn', isResult, bound(90_000))
  check(`${name}: the runner is up and the first turn answered`, init !== null && first !== null, runner.stderr().split('\n').slice(-5).join(' | '))
  return { name, home, fx, runner, failedAtOpen }
}
async function closeWorld(w: World): Promise<void> {
  await w.runner.stop(bound(8_000))
  w.fx.kill()
  exportWorld(w.name, w.home, { 'frames.jsonl': w.runner.frames.map(l => JSON.stringify(l)).join('\n') + '\n', 'stderr.txt': w.runner.stderr() })
  if (failed() === w.failedAtOpen) await removeWorld(w.home)
  else console.log(`  [forensics] ${w.name} world kept: ${w.home}\n${w.runner.stderr().split('\n').slice(-12).join('\n')}`)
}
const wireOf = (arm: string, step: number): ((x: Wire) => boolean) => x => x.kind === 'request' && x.arm === arm && x.step === step
const resultText = (w: Wire | undefined): string => w?.lastToolResult?.text ?? ''

if (!existsSync(DIST)) {
  console.log(`\nFAIL ${DIST} missing — run \`bun run build.ts\` first (the arm boots the BUILT product)`)
  check('the built bundle is present', false, DIST)
} else {
  section("B1 a background sub-agent carries the Sleep tool, sleeps on the shell it launched, and takes the shell's completion at its Sleep boundary")
  {
    const w = await openWorld('bg-sleep')
    const before = w.runner.frames.length
    w.runner.send(user(BG_SLEEP_TURN_ASK, UT))
    const opened = await waitWire(w.fx.wire, "the background sub-agent's first request", wireOf('subbgsleep', 0), bound(60_000))
    check('the background sub-agent opened its own conversation', opened !== null, j(opened))
    check('its pool carries the Sleep tool', opened !== null && opened.hasSleepTool === true, j(opened?.toolNames ?? opened))
    check('its pool carries neither the Agent tool nor the Workflow tool', opened !== null && opened.hasAgentTool === false && opened.hasWorkflowTool === false, j(opened))
    const result = await w.runner.waitFor("the turn's result", isResult, bound(150_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.result ?? '').startsWith(doneText(BG_SLEEP_TURN_ASK)), j(result?.result))
    const requests = requestsOf(w.fx.wire)
    const afterShell = requests.find(wireOf('subbgsleep', 1))
    const afterSleep = requests.find(wireOf('subbgsleep', 2))
    check('the sub-agent launched its shell in the background (a launch receipt, not an error)', afterShell !== undefined && afterShell.lastToolResult?.isError === false && /background/i.test(resultText(afterShell)), j(afterShell?.lastToolResult))
    check("the sub-agent's Sleep ran without error", afterSleep !== undefined && afterSleep.lastToolResult?.isError === false, j(afterSleep?.lastToolResult))
    const waited = afterShell !== undefined && afterSleep !== undefined ? afterSleep.at - afterShell.at : -1
    check(`the wait ended when the owned shell settled — after about ${BG_SHELL_SECONDS} s, not the ${BG_SUB_SLEEP_SECONDS} s asked`, waited >= (BG_SHELL_SECONDS - 2) * 1000 && waited < (BG_SUB_SLEEP_SECONDS - 10) * 1000 && /tracked work you were waiting on finished/.test(resultText(afterSleep)), `${waited} ms; ${resultText(afterSleep).slice(0, 120)}`)
    check("the shell's completion notice rode the sub-agent's next request, once", afterSleep !== undefined && afterSleep.counts?.[BG_SHELL_NOTICE] === 1, describeRequests(requests, [BG_SHELL_NOTICE]))
    check("the sub-agent reached its last step and was answered its final text there", requests.filter(r => r.arm === 'subbgsleep').length === 3 && requests.some(r => r.arm === 'subbgsleep' && r.step === 2), `${BG_SLEEP_DONE}; ${describeRequests(requests.filter(r => r.arm === 'subbgsleep'), [])}`)
    check("no request of the session's own model carried the shell's notice", carrying(requests.filter(r => r.arm === 'agentbgsleep'), BG_SHELL_NOTICE).length === 0, describeRequests(requests, [BG_SHELL_NOTICE]))
    const mainAfterWait = requests.find(wireOf('agentbgsleep', 2))
    check("the session's own Sleep ended when the background sub-agent settled", mainAfterWait !== undefined && mainAfterWait.lastToolResult?.isError === false && /tracked work you were waiting on finished/.test(resultText(mainAfterWait)), j(mainAfterWait?.lastToolResult))
    check("and its next request carried the sub-agent's completion notice, once", mainAfterWait !== undefined && mainAfterWait.counts?.[BG_AGENT_NOTICE] === 1, describeRequests(requests, [BG_AGENT_NOTICE]))
    await closeWorld(w)
  }
}

finish()
