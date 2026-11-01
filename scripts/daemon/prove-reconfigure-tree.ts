import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const processGroup = await import('../../src/utils/processGroup.js')
const strikes: Array<{ child: unknown; signal: unknown }> = []
mock.module('../../src/utils/processGroup.js', () => ({
  ...processGroup,
  killProcessGroup: (child: unknown, signal: unknown) => { strikes.push({ child, signal }) },
}))
const { TaskRoster } = await import('../../src/daemon/roster.js')
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
assert.equal(first.respawned, true)
assert.equal(handle.longLived.reconfiguring, true)
assert.deepEqual(strikes, [{ child, signal: 'SIGTERM' }])
assert.equal(directKills, 0)
console.log('PASS idle reconfigure tears down the owned tree instead of signalling only the runner')
handle.longLived.respawnTimer = setTimeout(() => {}, 60_000)
try {
  roster.reconfigureLongLived('fixture', {})
  assert.equal(strikes.length, 1)
} finally {
  clearTimeout(handle.longLived.respawnTimer)
  handle.longLived.respawnTimer = undefined
}
handle.longLived.turnActive = true
const busy = roster.reconfigureLongLived('fixture', {})
assert.equal(busy.pending, true)
assert.equal(strikes.length, 1)
assert.equal(roster.reconfigureLongLived('missing', {}).ok, false)
console.log('PASS pending respawns and busy or absent seats are not struck')
