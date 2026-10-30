#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const home = mkdtempSync(join(tmpdir(), 'history-retract-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'history-retract-cwd-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(cwd)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const bootstrap = await import(`${root}/src/bootstrap/state.ts`)
bootstrap.setOriginalCwd(cwd)
const history = await import(`${root}/src/history.ts`)
const read = async (): Promise<string[]> => { const seen: string[] = []; for await (const entry of history.getHistory()) seen.push(entry.display); return seen }

const realNow = Date.now
Date.now = () => 1_800_000_000_000
try {
  history.addToHistory('keep me')
  await history.flushHistoryNow()
  history.addToHistory('retract me')
  await history.flushHistoryNow()
  const onDisk = readFileSync(join(home, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { display: string; timestamp: number })
  check('the fixture: two prompts flushed with one and the same millisecond stamp', onDisk.length === 2 && onDisk[0]!.timestamp === onDisk[1]!.timestamp, JSON.stringify(onDisk))
  history.removeLastFromHistory()
  const afterOne = await read()
  check('withdrawing the last prompt hides that prompt alone; the earlier same-millisecond prompt stays', JSON.stringify(afterOne) === JSON.stringify(['keep me']), JSON.stringify(afterOne))
  history.addToHistory('pending one')
  history.removeLastFromHistory()
  await history.flushHistoryNow()
  const afterPending = await read()
  check('withdrawing a prompt still pending drops it before any flush', JSON.stringify(afterPending) === JSON.stringify(['keep me']), JSON.stringify(afterPending))
} finally {
  Date.now = realNow
}
console.log(failures === 0 ? '\nprove-history-retraction-keys-the-record: all green' : `\nprove-history-retraction-keys-the-record: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
