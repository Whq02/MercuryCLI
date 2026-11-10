import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readSync, rmSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { open } from '../../src/services/crewBoard/store.ts'
import type { BoardPrincipal } from '../../src/services/crewBoard/contracts.ts'

const instant = 1_800_000_000_000
const seat = (sessionId: string, agentId: string): BoardPrincipal => ({ author: { sessionId, agentId, executionId: 'first' }, name: agentId })
type Verdict = { opened?: string; error?: string }
const openerAt = process.argv.indexOf('--opener')
if (openerAt >= 0) {
  const path = process.argv[openerAt + 1]!, sessionId = process.argv[openerAt + 2]!, agentId = process.argv[openerAt + 3]!
  type Handle = { exec(sql: string): unknown }
  const handle = (createRequire(import.meta.url)('bun:sqlite') as { Database: { prototype: Handle } }).Database.prototype
  const exec = handle.exec
  handle.exec = function (this: Handle, sql: string): unknown {
    if (sql === 'BEGIN IMMEDIATE') writeSync(1, `${JSON.stringify({ reached: true })}\n`)
    return exec.call(this, sql)
  }
  writeSync(1, `${JSON.stringify({ ready: true })}\n`)
  readSync(0, Buffer.alloc(1))
  try {
    const board = open(path, sessionId, () => instant)
    const author = seat(sessionId, agentId)
    board.enroll(author)
    const receipt = board.post(author, { clientOpId: `opened-${agentId}`, kind: 'result', text: `${agentId} opened the board` })
    assert(receipt.ok, JSON.stringify(receipt))
    const wave = board.screenEvents(0).find(event => event.eventId === receipt.eventId)!.waveId
    board.close()
    console.log(JSON.stringify({ opened: wave } satisfies Verdict))
  } catch (error) { console.log(JSON.stringify({ error: String(error) } satisfies Verdict)) }
} else {
  assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
  const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'open-race-'))
  type Raw = { exec(sql: string): void; prepare(sql: string): { all(): Record<string, unknown>[] }; close(): void }
  const sqlite = createRequire(import.meta.url)('bun:sqlite') as { Database: new (path: string, options?: { readonly?: boolean }) => Raw }
  const opener = (path: string, sessionId: string, agentId: string) => {
    const child = spawn(process.execPath, [import.meta.filename, '--opener', path, sessionId, agentId], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const waiting: Array<{ line: string; resolve: () => void }> = []
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      for (const wait of waiting.splice(0)) if (stdout.includes(wait.line)) wait.resolve(); else waiting.push(wait)
    })
    const printed = (line: string): Promise<void> => new Promise(resolve => { if (stdout.includes(line)) resolve(); else waiting.push({ line, resolve }) })
    const ready = printed('"ready":true'), reached = printed('"reached":true')
    const done = new Promise<Verdict>((resolve, reject) => child.once('exit', code => {
      const last = stdout.trim().split('\n').pop() ?? ''
      try { resolve(JSON.parse(last) as Verdict) } catch { reject(new Error(`opener ${agentId} exited ${code} without a verdict: ${stdout}${stderr}`)) }
    }))
    return { ready, reached, done, go: () => { child.stdin.end('g') } }
  }
  const freshBoard = (name: string): string => {
    const path = join(home, name, 'board.sqlite')
    open(path, 'builder', () => instant).close()
    const raw = new sqlite.Database(path)
    raw.exec('DELETE FROM identity')
    raw.close()
    return path
  }
  const race = async (path: string, sessions: [string, string]): Promise<Verdict[]> => {
    const lock = new sqlite.Database(path)
    lock.exec('BEGIN IMMEDIATE')
    const openers = [opener(path, sessions[0], 'first'), opener(path, sessions[1], 'second')]
    let staged = false
    try {
      await Promise.all(openers.map(o => o.ready))
      for (const o of openers) o.go()
      let bound: ReturnType<typeof setTimeout> | undefined
      staged = await Promise.race([Promise.all(openers.map(o => o.reached)).then(() => true), new Promise<boolean>(resolve => { bound = setTimeout(() => resolve(false), 4000) })])
      clearTimeout(bound)
    } finally {
      lock.exec('COMMIT')
      lock.close()
    }
    const verdicts = await Promise.all(openers.map(o => o.done))
    assert(staged, `the race was not staged: an opener had not read "no session" and reached the identity insert while the write lock was held — ${JSON.stringify(verdicts)}`)
    return verdicts
  }
  const identity = (path: string): Record<string, unknown>[] => {
    const raw = new sqlite.Database(path, { readonly: true })
    try { return raw.prepare('SELECT session, wave FROM identity').all() } finally { raw.close() }
  }
  try {
    const same = freshBoard('same-session')
    const [first, second] = await race(same, ['wave-a', 'wave-a'])
    assert(first!.error === undefined && second!.error === undefined, `an opener of the same session lost the race: ${first!.error ?? second!.error}`)
    assert.equal(first!.opened, second!.opened, 'both openers must come up on one wave')
    assert.deepEqual(identity(same), [{ session: 'wave-a', wave: first!.opened }])
    console.log('PASS two racing opens of a fresh board for one session both open, on one wave (both had read "no session" and stood at the identity insert before the write lock was released)')

    const other = freshBoard('other-session')
    const outcomes = await race(other, ['wave-b', 'wave-c'])
    assert.equal(outcomes.filter(o => o.opened !== undefined).length, 1, `one board, one session: ${JSON.stringify(outcomes)}`)
    assert.match(outcomes.find(o => o.error !== undefined)!.error!, /This board belongs to another session\./)
    assert.equal(identity(other).length, 1)
    console.log('PASS two sessions racing for a fresh board: one owns it, the other is refused (both at the identity insert, as above)')

    assert.throws(() => open(same, 'wave-z', () => instant), /This board belongs to another session\./)
    console.log('PASS a later session is still refused')
    assert.throws(() => open(freshBoard('no-session'), 'wave-a', () => instant, true), /This board has no session\./)
    console.log('PASS a reader of a board with no session is still refused')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
