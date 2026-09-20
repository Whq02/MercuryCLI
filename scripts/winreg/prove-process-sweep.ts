import assert from 'node:assert/strict'
import {
  decodeWindowsProcessRows,
  windowsIdentityMatches,
  windowsObservation,
  windowsSignalRefusal,
  type WindowsRawRow,
} from '../../src/daemon/processSweepWindows.js'

const raw: WindowsRawRow = {
  pid: 4242,
  ppid: 100,
  exe: 'C:\\runtime\\node.exe',
  args: ['C:\\runtime\\node.exe', 'C:\\runtime\\mercury.mjs', 'daemon', 'run', 'C:\\home'],
  startedAtMs: 1_700_000_000_000,
  startToken: '9/20/2026 3:57:19 AM',
  user: 'S-1-5-21-1',
  sessionId: 3,
  consoleAttached: false,
  sessionConnected: false,
}

const detached = windowsObservation(raw)
assert.deepEqual(detached, {
  process: { pid: 4242, ppid: 100, exe: raw.exe, args: raw.args, startedAtMs: raw.startedAtMs, user: raw.user, terminal: 'session 3 · console absent' },
  startToken: raw.startToken,
  state: 'running',
  terminalAlive: false,
})
assert.equal(windowsObservation({ ...raw, consoleAttached: true }).terminalAlive, true)
assert.equal(windowsObservation({ ...raw, consoleAttached: true }).process.terminal, 'session 3 · console attached')
assert.equal(windowsObservation({ ...raw, consoleAttached: true, sessionConnected: false }).terminalAlive, true)
assert.equal(windowsObservation({ ...raw, sessionConnected: true }).terminalAlive, false)
assert.equal(windowsObservation({ ...raw, sessionConnected: true }).process.terminal, 'session 3 · console absent')
assert.equal(windowsObservation({ ...raw, consoleAttached: null, sessionConnected: true }).terminalAlive, true)
assert.equal(windowsObservation({ ...raw, consoleAttached: null }).terminalAlive, null)
assert.equal(windowsObservation({ ...raw, consoleAttached: null }).process.terminal, 'session 3 · console unknown')
assert.equal(windowsObservation({ ...raw, consoleAttached: null, sessionConnected: null }).terminalAlive, null)
assert.equal(windowsObservation({ ...raw, sessionConnected: null }).terminalAlive, false)
assert.equal(windowsObservation({ ...raw, sessionId: null, sessionConnected: null }).process.terminal, null)
assert.equal(windowsObservation({ ...raw, sessionId: null, sessionConnected: null }).terminalAlive, null)
assert.equal(windowsObservation({ ...raw, sessionId: null, sessionConnected: null, consoleAttached: null }).terminalAlive, null)
assert.equal(windowsObservation({ ...raw, sessionId: null, sessionConnected: null, consoleAttached: true }).terminalAlive, true)
assert.equal(windowsObservation({ ...raw, sessionId: 0, sessionConnected: false }).process.terminal, 'session 0 · console absent')
assert.equal(windowsObservation({ ...raw, sessionId: 0, sessionConnected: false }).terminalAlive, false)

const blank = windowsObservation({ ...raw, exe: null, args: null, startedAtMs: null, startToken: null, user: null })
assert.equal(blank.process.exe, '')
assert.deepEqual(blank.process.args, [])
assert.equal(blank.process.startedAtMs, 0)
assert.equal(blank.process.user, '')
assert.equal(blank.startToken, null)

assert.equal(decodeWindowsProcessRows({ rows: [raw] }).length, 1)
assert.throws(() => decodeWindowsProcessRows({ rows: [{ ...raw, pid: '4242' }] }))
assert.throws(() => decodeWindowsProcessRows({ rows: [{ ...raw, consoleAttached: 'yes' }] }))
assert.throws(() => decodeWindowsProcessRows({ rows: [{ ...raw, startedAtMs: Number.NaN }] }))
assert.throws(() => decodeWindowsProcessRows({ rows: 'none' }))

const fresh = windowsObservation(raw)
assert.equal(windowsIdentityMatches(detached, fresh), true)
assert.equal(windowsIdentityMatches(detached, windowsObservation({ ...raw, startToken: '9/20/2026 3:58:00 AM' })), false)
assert.equal(windowsIdentityMatches(detached, windowsObservation({ ...raw, startedAtMs: raw.startedAtMs + 1 })), false)
assert.equal(windowsIdentityMatches(detached, windowsObservation({ ...raw, exe: 'C:\\other\\node.exe' })), false)
assert.equal(windowsIdentityMatches(detached, windowsObservation({ ...raw, exe: raw.exe.toUpperCase() })), true)
assert.equal(windowsIdentityMatches(detached, windowsObservation({ ...raw, user: 'S-1-5-21-2' })), false)
assert.equal(windowsIdentityMatches(detached, windowsObservation({ ...raw, pid: 4243 })), false)
assert.equal(windowsIdentityMatches(blank, blank), false)
assert.equal(windowsIdentityMatches(windowsObservation({ ...raw, startToken: null }), windowsObservation({ ...raw, startToken: null })), false)
assert.equal(windowsIdentityMatches(windowsObservation({ ...raw, user: null }), windowsObservation({ ...raw, user: null })), false)

const me = raw.user!
assert.equal(windowsSignalRefusal(detached, fresh, me), null)
assert.match(windowsSignalRefusal(detached, windowsObservation({ ...raw, consoleAttached: true }), me) ?? '', /console|session/)
assert.equal(windowsSignalRefusal(detached, windowsObservation({ ...raw, sessionConnected: true }), me), null)
assert.match(windowsSignalRefusal(detached, windowsObservation({ ...raw, consoleAttached: null, sessionConnected: true }), me) ?? '', /console|session/)
assert.match(windowsSignalRefusal(detached, windowsObservation({ ...raw, consoleAttached: null }), me) ?? '', /unknown/)
assert.match(windowsSignalRefusal(detached, windowsObservation({ ...raw, consoleAttached: null, sessionId: null, sessionConnected: null }), me) ?? '', /unknown/)
assert.match(windowsSignalRefusal(detached, windowsObservation({ ...raw, startToken: 'other' }), me) ?? '', /identity/)
assert.match(windowsSignalRefusal(detached, windowsObservation({ ...raw, user: 'S-1-5-21-2' }), me) ?? '', /not-ours/)
const foreign = windowsObservation({ ...raw, user: 'S-1-5-21-2' })
assert.match(windowsSignalRefusal(foreign, foreign, me) ?? '', /not-ours/)
assert.match(windowsSignalRefusal(detached, fresh, 'S-1-5-21-2') ?? '', /not-ours/)
assert.match(windowsSignalRefusal(detached, fresh, '') ?? '', /not-ours/)
assert.match(windowsSignalRefusal(blank, blank, me) ?? '', /not-ours/)
assert.match(windowsSignalRefusal(blank, blank, '') ?? '', /not-ours/)
console.log('PASS: Windows observations over recorded rows — terminal tri-state, unknown reads stay null, identity pins pid+birth+executable+user, another user or an unreadable owner is not-ours, signal refuses live or unknown terminals')
