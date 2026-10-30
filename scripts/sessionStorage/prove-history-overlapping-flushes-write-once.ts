#!/usr/bin/env bun
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const home = mkdtempSync(join(tmpdir(), 'history-flush-once-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'history-flush-once-cwd-'))
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
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const filePath = join(home, 'history.jsonl')
const linesOnDisk = (): string[] => { try { return readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as { display: string }).display) } catch { return [] } }

const bootstrap = await import(`${root}/src/bootstrap/state.ts`)
bootstrap.setOriginalCwd(cwd)
const history = await import(`${root}/src/history.ts`)
const { lock } = await import(`${root}/src/utils/lockfile.ts`)
const { runCleanupFunctions } = await import(`${root}/src/utils/cleanupRegistry.ts`)
const settle = async (): Promise<void> => {
  const end = Date.now() + 5_000
  while (Date.now() < end) {
    const h = history.getHistoryFlushHealth()
    if (h.pending === 0 && !h.inFlight) return
    await sleep(10)
  }
}

section('§1 two flushes that overlap (the background flush and a flush asked for now) write each pending prompt once')
{
  history.addToHistory('first prompt')
  await sleep(5)
  history.addToHistory('second prompt')
  await history.flushHistoryNow()
  await settle()
  const lines = linesOnDisk()
  check('two prompts, two lines on disk', lines.length === 2 && lines[0] === 'first prompt' && lines[1] === 'second prompt', JSON.stringify(lines))
  const seen: string[] = []
  for await (const entry of history.getHistory()) seen.push(entry.display)
  check('the history reads back each prompt once, newest first', JSON.stringify(seen) === JSON.stringify(['second prompt', 'first prompt']), JSON.stringify(seen))
}

section('§2 the exit road under lock contention: the retry loop and the cleanup closure both flush, the prompt lands once')
{
  const before = linesOnDisk().length
  closeSync(openSync(filePath, 'a'))
  const release = await lock(filePath, { stale: 10_000 })
  setTimeout(() => { void release() }, 900)
  history.addToHistory('only prompt')
  await sleep(600)
  await runCleanupFunctions()
  await sleep(1_500)
  await settle()
  const lines = linesOnDisk().slice(before)
  check('the prompt written during the contended exit is on disk once', lines.length === 1 && lines[0] === 'only prompt', JSON.stringify(lines))
}

console.log(failures === 0 ? '\nprove-history-overlapping-flushes-write-once: all green' : `\nprove-history-overlapping-flushes-write-once: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
