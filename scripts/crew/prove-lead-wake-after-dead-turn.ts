#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const suiteHome = process.env.MERCURY_CONFIG_DIR
assert(suiteHome, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(suiteHome, 'lead-wake-home-'))
process.env.MERCURY_CONFIG_DIR = home
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(home)
bootstrap.setCwdState(home)
bootstrap.setProjectRoot(home)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const { operatorPauseGate } = await import('../../src/run-core/pauseGate.ts')
runSwarmCommand('on')
await seam.latchSwarmAgent('sender', 'Sender')

let wakes = 0
let idle = true
const watch = seam.watchSwarmLead(() => idle, () => { wakes++ }, () => {})
const board = seam.swarmStore()!
const sender = seam.swarmPrincipal('sender')!
const lead = seam.swarmPrincipal()!
let serial = 0
const post = (kind: 'ask' | 'blocker' | 'answer' | 'result', text: string): string => {
  const receipt = board.post(sender, { clientOpId: `p${++serial}`, kind, text })
  assert(receipt.ok, JSON.stringify(receipt))
  return receipt.eventId
}
const pendingPacket = (): { text: string; eventIds: string[] } | undefined => seam.swarmBoundary(undefined, new Set())[0]
const present = (requestId: string): string[] => {
  const packet = pendingPacket()
  if (packet === undefined) return []
  board.presented(lead, packet.eventIds, requestId)
  return packet.eventIds
}
const turnSettles = (): void => watch.check()
const newest = (): string | undefined => (typeof board.leadMentionNewest === 'function' ? board.leadMentionNewest()?.eventId : undefined)

section('§1 an ask wakes the idle lead once')
const x = post('ask', '@main the first ask')
check('one wake', wakes === 1, String(wakes))

section('§2 the wake turn dies before its first byte: nothing was presented, and nothing re-wakes by itself')
turnSettles()
check('the settle of a turn that presented nothing wakes nobody (no spin)', wakes === 1, String(wakes))
turnSettles()
turnSettles()
check('…however often the host settles with no new post', wakes === 1 && board.leadMention()?.eventId === x, String(wakes))

section('§3 a new post after the dead turn wakes the lead again, and its packet carries everything that waits')
const y = post('ask', '@main a new ask after the dead turn')
check('the new post wakes the lead', wakes === 2, `wakes ${wakes} — the oldest pending post is still ${board.leadMention()?.eventId === x ? 'the first ask' : 'another'}`)
const packet = pendingPacket()
check('the packet the woken turn reads holds the first ask and the new one', packet !== undefined && [x, y].every(id => packet.eventIds.includes(id)), JSON.stringify(packet?.eventIds))

section('§4 a post that arrives while a wake is out rides that wake; if the turn dies it has earned one wake of its own, an empty settle none')
const w = post('blocker', '@all a blocker while the second wake is still queued')
check('a post while the wake is out makes no further wake', wakes === 2, String(wakes))
check('the store names both ends of what waits: the oldest and the newest pending post', board.leadMention()?.eventId === x && newest() === w, `${board.leadMention()?.eventId} · ${newest()}`)
turnSettles()
check('the settle of the dead turn finds a post newer than the last wake and wakes once', wakes === 3, String(wakes))
turnSettles()
turnSettles()
check('the next empty settles wake nobody', wakes === 3, String(wakes))

section('§5 a turn that reaches the model clears the wake, and the next post wakes again')
const shown = present('t-live')
check('presenting the packet leaves nothing pending for the lead', [x, y, w].every(id => shown.includes(id)) && board.leadMention() === null && newest() === undefined, JSON.stringify(shown))
turnSettles()
check('the settle of that turn wakes nobody', wakes === 3, String(wakes))
post('ask', '@main an ask after the live turn')
check('the next ask wakes the lead once', wakes === 4, String(wakes))
post('result', 'an unaddressed result is for the crew chat and the next boundary')
check('a post that would not wake the lead still wakes nobody', wakes === 4, String(wakes))

section('§6 a turn in flight and the pause gate keep their meaning')
present('t-clear')
turnSettles()
idle = false
const mid = post('ask', '@main an ask while a turn is in flight')
check('a post during a turn makes no wake', wakes === 4 && board.leadMention()?.eventId === mid, String(wakes))
idle = true
turnSettles()
check('the settle of a turn that did not read it wakes once', wakes === 5, String(wakes))
turnSettles()
check('…and that wake turn dying does not re-wake', wakes === 5, String(wakes))
operatorPauseGate.pause()
post('ask', '@main an ask while the operator holds the lead')
turnSettles()
check('a held lead is not woken by a new post or a settle', wakes === 5 && operatorPauseGate.holds('main'), String(wakes))
operatorPauseGate.resume()
check('lifting the hold wakes it once for what arrived', wakes === 6, String(wakes))

watch.stop()
runSwarmCommand('off')
seam.settleSwarmAgent('sender')
console.log(failures === 0 ? '\nprove-lead-wake-after-dead-turn: ALL LAWS HOLD' : `\nprove-lead-wake-after-dead-turn: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
