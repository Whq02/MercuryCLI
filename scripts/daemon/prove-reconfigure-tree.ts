import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const processGroup = await import('../../src/platform/processes/processGroup.js')
const strikes: Array<{ child: unknown; signal: unknown }> = []
mock.module('../../src/platform/processes/processGroup.js', () => ({
  ...processGroup,
  killProcessGroup: (child: unknown, signal: unknown) => { strikes.push({ child, signal }) },
}))
const { TaskRoster } = await import('../../src/daemon/roster/roster.js')
let directKills = 0
const child = { pid: 43210, kill: () => { directKills++; return true } }
const handle = {
  entry: { short: 'fixture' },
  child,
  longLived: { spec: {}, turnActive: false, reconfiguring: false, respawnTimer: undefined as ReturnType<typeof setTimeout> | undefined },
}
const roster = new TaskRoster({} as never)
const internal = roster as unknown as { handles: Map<string, unknown> }
internal.handles.set('fixture', handle)
const first = roster.reconfigureLongLived('fixture', {})
assert.equal(first.respawned, true, 'an idle long-lived seat must respawn on reconfigure; see reconfigureLongLived in src/daemon/roster/retarget.ts')
assert.equal(handle.longLived.reconfiguring, true, 'respawnForReconfigure in src/daemon/roster/retarget.ts must set reconfiguring before it ends the child')
assert.deepEqual(strikes, [{ child, signal: 'SIGTERM' }], 'reconfigure must end the child with one SIGTERM through killProcessGroup, so the whole owned tree goes; see respawnForReconfigure in src/daemon/roster/retarget.ts and endChild in src/daemon/roster/end.ts')
assert.equal(directKills, 0, 'the runner must not be signalled alone with child.kill; endChild in src/daemon/roster/end.ts must strike the process group')
console.log('PASS idle reconfigure tears down the owned tree instead of signalling only the runner')
handle.longLived.respawnTimer = setTimeout(() => {}, 60_000)
try {
  roster.reconfigureLongLived('fixture', {})
  assert.equal(strikes.length, 1, 'a seat with a pending respawn timer must not be struck again; see the respawnTimer guard in respawnForReconfigure, src/daemon/roster/retarget.ts')
} finally {
  clearTimeout(handle.longLived.respawnTimer)
  handle.longLived.respawnTimer = undefined
}
handle.longLived.turnActive = true
const busy = roster.reconfigureLongLived('fixture', {})
assert.equal(busy.pending, true, 'a seat with a turn active must queue the reconfigure as pending; see reconfigureLongLived in src/daemon/roster/retarget.ts')
assert.equal(strikes.length, 1, 'a busy seat must not be struck; see reconfigureLongLived and respawnForReconfigure in src/daemon/roster/retarget.ts')
assert.equal(roster.reconfigureLongLived('missing', {}).ok, false, 'an absent seat must answer ok false; see reconfigureLongLived in src/daemon/roster/retarget.ts')
console.log('PASS pending respawns and busy or absent seats are not struck')
