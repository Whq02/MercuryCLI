#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'search-flight-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('============================================================')
console.log(' interactive search — one in-flight grep, total settlement')
console.log('============================================================')

console.log('\n── §1 live: an aborted grep stream settles, its child dies ──')
{
  const hay = join(SCRATCH, 'hay')
  mkdirSync(hay, { recursive: true })
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(hay, `f${i}.txt`), Array.from({ length: 2000 }, (_, k) => `needle line ${k}`).join('\n'))
  }
  const { ripGrepStream } = await import(join(REPO, 'src/platform/shell/ripgrep.ts'))
  const controller = new AbortController()
  let sawLines = false
  const stream = ripGrepStream(['-n', '-e', 'needle'], hay, controller.signal, () => {
    sawLines = true
    controller.abort()
  }).then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  )
  const outcome = await Promise.race([stream, sleep(4000).then(() => 'pending' as const)])
  check('§1 the stream produced output before the abort', sawLines, 'onLines never fired: ripGrepStream in src/platform/shell/ripgrep.ts emitted no lines for the needle fixture; check its stdout data handler and the rg spawn')
  check('§1 the aborted stream SETTLES within the bound (resolved or rejected, never pending)', outcome !== 'pending', `${outcome} — ripGrepStream in src/platform/shell/ripgrep.ts must settle its promise on abort (the close handler when abortSignal.aborted)`)
  await sleep(300)
  let rgAlive = ''
  try {
    rgAlive = execFileSync('pgrep', ['-f', String(hay)], { encoding: 'utf8' }).trim()
  } catch {
    rgAlive = ''
  }
  check('§1 the rg child is gone after the abort', rgAlive === '', rgAlive && `pids: ${rgAlive} — the rg child must be killed on abort; check the spawn signal option in ripGrepStream in src/platform/shell/ripgrep.ts`)
}


console.log(failures === 0 ? '\n✅ ONE IN-FLIGHT SEARCH PROVEN' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
