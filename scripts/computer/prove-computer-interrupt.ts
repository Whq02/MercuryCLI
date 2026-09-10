#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const claim = await import('../../src/services/desktop/desktopClaim.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const { readFakeActLog } = await import('../../src/services/desktop/fakeDesktopDriver.ts')
type FakeAct = import('../../src/services/desktop/fakeDesktopDriver.ts').FakeAct

const scratch = scratchDir('interrupt')
const LOG = join(scratch, 'acts.jsonl')
const scene = join(scratch, 'held.json')
writeFileSync(scene, JSON.stringify({ holdMs: 400 }))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
process.env.MERCURY_DESKTOP_FAKE_LOG = LOG
resetDesktopDriverForTest()

const log = (): FakeAct[] => readFakeActLog(LOG)
const tail = (from: number): string => log().slice(from).map(a => `${a.act}:${a.outcome}`).join(',')
const namesInterruption = (result: string): boolean => result.includes('interrupted by the operator') && result.includes('released')
const abortIn = (controller: AbortController, ms: number): void => {
  setTimeout(() => controller.abort(), ms)
}

async function act(input: Record<string, unknown>, abortAfterMs: number | null, pre = false): Promise<{ result: string; outcome: string; from: number }> {
  const controller = new AbortController()
  const base = toolContext({ controller })
  session.forgetDesktopOwner(ownerOf(base))
  const shot = await withScreenshot(ComputerTool as never, base, `toolu_shot_${Math.random().toString(36).slice(2)}`)
  const from = log().length
  if (pre) controller.abort()
  else if (abortAfterMs !== null) abortIn(controller, abortAfterMs)
  const out = resultOf(await ComputerTool.call(input as never, shot.context, allowEverything, toolUseTurn(`toolu_act_${Math.random().toString(36).slice(2)}`, 'Computer', input)))
  return { result: out.result, outcome: out.outcome, from }
}

section('§1 an abort mid-click ends the act, releases everything and frees the desktop')
{
  const { result, outcome, from } = await act({ action: 'click', x: 812, y: 300 }, 100)
  check('the result names the interruption and the release', namesInterruption(result), result)
  check("the outcome is 'failed'", outcome === 'failed')
  check('the log carries the aborted click, then releaseAll, and no capture after it', tail(from) === 'click:aborted,releaseAll:done', tail(from))
  check('the claim is released and the snapshot idle', claim.desktopClaimHeld() === false && session.desktopSnapshot().phase === 'idle')
}

section('§2 an abort during a hold releases the chord')
{
  const { result, outcome, from } = await act({ action: 'hold', key: 'shift', durationMs: 3_000 }, 700)
  check('the result names the interruption', namesInterruption(result) && outcome === 'failed', result)
  const entries = log().slice(from)
  const down = entries.find(a => a.act === 'keyDown')
  const release = entries.find(a => a.act === 'releaseAll')
  check('the chord went down, then releaseAll released it', down?.outcome === 'done' && down.detail.key === 'shift' && release !== undefined && JSON.stringify(release.detail.keys) === JSON.stringify(['shift']), tail(from))
  check('no keyUp was posted by the act itself (the release did it)', !entries.some(a => a.act === 'keyUp'))
  check('the claim is released', claim.desktopClaimHeld() === false && session.desktopSnapshot().phase === 'idle')
}

section('§3 an abort during a drag releases the button')
{
  const { result, outcome, from } = await act({ action: 'drag', x: 100, y: 100, toX: 900, toY: 700 }, 100)
  check('the result names the interruption', namesInterruption(result) && outcome === 'failed', result)
  check('the log carries the aborted drag then releaseAll', tail(from) === 'drag:aborted,releaseAll:done', tail(from))
  const held = log().slice(from).find(a => a.act === 'releaseAll')
  check('nothing stays held after the release', held !== undefined && JSON.stringify(held.detail.buttons) === JSON.stringify([]) && JSON.stringify(held.detail.keys) === JSON.stringify([]), JSON.stringify(held))
}

section('§4 a signal already aborted never reaches the driver')
{
  const { result, outcome, from } = await act({ action: 'click', x: 812, y: 300 }, null, true)
  check('the result names the interruption', namesInterruption(result) && outcome === 'failed', result)
  const acts = log().slice(from).filter(a => a.act !== 'releaseAll')
  check('no act was logged', acts.length === 0, tail(from))
}

section('§5 an abort at the settle skips the screenshot after the act')
{
  const { result, outcome, from } = await act({ action: 'click', x: 812, y: 300, settleMs: 1_000 }, 700)
  check('the click completed', log().slice(from).some(a => a.act === 'click' && a.outcome === 'done'), tail(from))
  check('no capture followed the click', !log().slice(from).some(a => a.act === 'capture'), tail(from))
  check('the result names the interruption', namesInterruption(result) && outcome === 'failed', result)
  check('the claim is released', claim.desktopClaimHeld() === false && session.desktopSnapshot().phase === 'idle')
}

section('§6 without an abort the act completes with its screenshot')
{
  const { result, outcome, from } = await act({ action: 'click', x: 812, y: 300, settleMs: 0 }, null)
  check('the click succeeds with a screenshot after it', outcome === 'succeeded' && tail(from) === 'click:done,capture:done', `${outcome} · ${tail(from)} · ${result}`)
  check('the result line carries the act and the screenshot', result.includes('click (812, 300)') && result.includes('screenshot:'), result)
  await claim.releaseDesktopClaim()
}

delete process.env.MERCURY_DESKTOP_FAKE_SCENE
delete process.env.MERCURY_DESKTOP_FAKE_LOG
resetDesktopDriverForTest()
finish('prove-computer-interrupt')
