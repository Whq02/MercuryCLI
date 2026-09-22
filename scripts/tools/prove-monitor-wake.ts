#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BURST_WINDOW_MS,
  createWatchMailbox,
  HELD_LINES_CAP,
  heldHeader,
  LISTED_LINES_CAP,
  REOPEN_GRACE_MS,
  WALL_RECHECK_MS,
  type WatchWall,
} from '../../src/tools/MonitorTool/watchMailbox.ts'
import { MonitorTool, monitorExpiryNotice } from '../../src/tools/MonitorTool/MonitorTool.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type Timer = { at: number; fn: () => void; cleared: boolean; fired: boolean }
function harness(wall: WatchWall) {
  let now = 1_000_000
  const timers: Timer[] = []
  const delivered: string[] = []
  const state = { wall }
  const mailbox = createWatchMailbox({
    now: () => now,
    wall: () => ({ ...state.wall }),
    deliver: text => delivered.push(text),
    setTimer: (fn, ms) => {
      const timer: Timer = { at: now + ms, fn, cleared: false, fired: false }
      timers.push(timer)
      return timer
    },
    clearTimer: handle => {
      ;(handle as Timer).cleared = true
    },
  })
  const advance = (ms: number): void => {
    const target = now + ms
    for (;;) {
      const due = timers.filter(t => !t.cleared && !t.fired && t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      now = due.at
      due.fired = true
      due.fn()
    }
    now = target
  }
  const live = (): Timer[] => timers.filter(t => !t.cleared && !t.fired)
  return { mailbox, delivered, advance, live, state, nowMs: () => now }
}

{
  const h = harness({ closed: false })
  h.mailbox.push('one\n')
  h.advance(50)
  h.mailbox.push('two\n')
  h.advance(100)
  h.mailbox.push('three\n')
  h.advance(BURST_WINDOW_MS)
  check('three lines inside the burst window fold into ONE notification', h.delivered.length === 1, JSON.stringify(h.delivered))
  check('the folded notification lists the three lines in arrival order', h.delivered[0] === 'one\ntwo\nthree', JSON.stringify(h.delivered[0]))
  h.advance(60 * 60 * 1000)
  check('after the fold nothing else is delivered and no timer stays armed', h.delivered.length === 1 && h.live().length === 0, `${h.delivered.length} delivered, ${h.live().length} live timers`)
}

{
  const h = harness({ closed: false })
  h.advance(24 * 60 * 60 * 1000)
  check('a quiet watch delivers nothing and arms nothing', h.delivered.length === 0 && h.live().length === 0)
  h.mailbox.push('\n\n')
  h.advance(BURST_WINDOW_MS * 2)
  check('a chunk of blank lines is not an event', h.delivered.length === 0)
}

{
  const h = harness({ closed: false })
  h.mailbox.push('early\n')
  h.advance(BURST_WINDOW_MS)
  check('a line that lands with the window open is delivered at once', h.delivered.length === 1 && h.delivered[0] === 'early')
  const reopensAtMs = h.nowMs() + 30_000
  h.state.wall = { closed: true, reopensAtMs }
  h.mailbox.push('first held\n')
  h.advance(2_500)
  h.mailbox.push('second held\n')
  h.advance(2_500)
  h.mailbox.push('third held\n')
  h.advance(2_500)
  check('lines that land while the window is closed are held, not delivered', h.delivered.length === 1 && h.mailbox.heldCount() === 3, `${h.delivered.length} delivered, ${h.mailbox.heldCount()} held`)
  const recheck = h.live()
  check('one re-check timer is armed at the stated reopen time plus the grace', recheck.length === 1 && recheck[0]!.at === reopensAtMs + REOPEN_GRACE_MS, JSON.stringify(recheck.map(t => t.at - h.nowMs())))
  h.advance(reopensAtMs + REOPEN_GRACE_MS - h.nowMs())
  check('a re-check that finds the window still closed delivers nothing and re-arms within a short bound', h.delivered.length === 1 && h.live().length === 1 && h.live()[0]!.at - h.nowMs() <= WALL_RECHECK_MS && h.live()[0]!.at - h.nowMs() >= REOPEN_GRACE_MS)
  h.state.wall = { closed: false }
  h.advance(WALL_RECHECK_MS)
  check('when the window reopens the held lines land as ONE notification', h.delivered.length === 2, JSON.stringify(h.delivered))
  const text = h.delivered[1] ?? ''
  const i1 = text.indexOf('first held')
  const i2 = text.indexOf('second held')
  const i3 = text.indexOf('third held')
  check('the held notification opens with the count header and lists the lines in order', text.startsWith(heldHeader(3)) && i1 >= 0 && i2 > i1 && i3 > i2, JSON.stringify(text))
  check('the header names how the lines waited', heldHeader(3).includes('3 lines') && heldHeader(3).includes('usage window was closed') && heldHeader(1).includes('1 line arrived'))
  h.advance(24 * 60 * 60 * 1000)
  check('after the flush the watch is quiet again', h.delivered.length === 2 && h.live().length === 0)
}

{
  const h = harness({ closed: true })
  h.mailbox.push('held while closed\n')
  h.advance(BURST_WINDOW_MS)
  check('a closed window with no stated reopen time re-checks on the long bound', h.live().length === 1 && h.live()[0]!.at - h.nowMs() === WALL_RECHECK_MS)
  h.state.wall = { closed: false }
  h.mailbox.push('fresh after reopening\n')
  h.advance(BURST_WINDOW_MS)
  check('a fresh line after the window reopens carries the held lines with it, in one notification', h.delivered.length === 1 && h.delivered[0]!.startsWith(heldHeader(1)) && h.delivered[0]!.includes('held while closed\nfresh after reopening'), JSON.stringify(h.delivered))
  check('the re-check timer is retired once the held lines were delivered by a fresh line', h.live().length === 1 && h.live()[0]!.fired === false)
  h.advance(WALL_RECHECK_MS * 2)
  check('the retired re-check delivers nothing more', h.delivered.length === 1)
}

{
  const h = harness({ closed: false })
  const many = Array.from({ length: LISTED_LINES_CAP + 5 }, (_, i) => `line ${i + 1}`)
  h.mailbox.push(`${many.join('\n')}\n`)
  h.advance(BURST_WINDOW_MS)
  const text = h.delivered[0] ?? ''
  check('a notification lists at most the cap and counts the rest', h.delivered.length === 1 && text.includes(`line ${LISTED_LINES_CAP}`) && !text.includes(`line ${LISTED_LINES_CAP + 1}\n`) && text.endsWith('[+5 more lines from this watch not listed]'), JSON.stringify(text.slice(-80)))
}

{
  const h = harness({ closed: true })
  for (let i = 0; i < HELD_LINES_CAP + 50; i++) h.mailbox.push(`held ${i + 1}\n`)
  h.advance(BURST_WINDOW_MS)
  check('the held buffer is bounded and counts what it dropped', h.mailbox.heldCount() === HELD_LINES_CAP + 50)
  h.state.wall = { closed: false }
  h.advance(WALL_RECHECK_MS)
  const text = h.delivered[0] ?? ''
  const rest = HELD_LINES_CAP + 50 - LISTED_LINES_CAP
  check('the flush of a full buffer names every held line in its count and its trailer', h.delivered.length === 1 && text.startsWith(heldHeader(HELD_LINES_CAP + 50)) && text.endsWith(`[+${rest} more lines from this watch not listed]`), JSON.stringify([text.slice(0, 90), text.slice(-60)]))
}

{
  const h = harness({ closed: true })
  h.mailbox.push('doomed\n')
  h.mailbox.dispose()
  h.advance(WALL_RECHECK_MS * 2)
  check('a disposed mailbox clears its timers and delivers nothing', h.delivered.length === 0 && h.live().length === 0)
}

{
  const notice = monitorExpiryNotice('the comms watch', 'b1', 300_000, 3)
  check('the expiry notice names the watch, the deadline and the event count', notice.includes('"the comms watch"') && notice.includes('task b1') && notice.includes('300s') && notice.includes('3 events'))
  check('the expiry notice says how to re-arm and names the persistent flag', notice.includes('calling Monitor again with the same command') && notice.includes('persistent: true'))
  const description = await MonitorTool.description()
  check('the model-facing description says when to set persistent', description.includes('`persistent: true`') && description.includes('until you stop it with TaskStop or the session ends'))
  check('the model-facing description names the default deadline and the expiry notice', description.includes('default 5 minutes, at most 1 hour') && description.includes('expiry notice that says how to re-arm'))
  check('the model-facing description says what happens to events behind a closed usage window', description.includes('usage window is closed are held') && description.includes('delivered together, in one notification'))
  check('the model-facing description names the burst window', description.includes(`${BURST_WINDOW_MS}ms fold into one notification`))
  const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'MonitorTool', 'MonitorTool.ts'), 'utf8')
  check("the persistent field's own words tell the model the watch outlives the deadline until TaskStop", /persistent: semanticBoolean\([\s\S]{0,200}?the watch runs until TaskStop or the session ends/.test(source))
  check('every event the tool emits rides the mailbox, never the queue directly', (source.match(/mailbox\.push\(/g) ?? []).length >= 4 && (source.match(/\bemit\(/g) ?? []).length === 1)
}

console.log(failures === 0 ? 'prove-monitor-wake: ALL LAWS HOLD' : 'prove-monitor-wake: FAILURE(S)')
process.exit(failures)
