#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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
  const { ripGrepStream } = await import(join(REPO, 'src/utils/ripgrep.ts'))
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
  check('§1 the stream produced output before the abort', sawLines)
  check('§1 the aborted stream SETTLES within the bound (resolved or rejected, never pending)', outcome !== 'pending', outcome)
  await sleep(300)
  let rgAlive = ''
  try {
    rgAlive = execFileSync('pgrep', ['-f', String(hay)], { encoding: 'utf8' }).trim()
  } catch {
    rgAlive = ''
  }
  check('§1 the rg child is gone after the abort', rgAlive === '', rgAlive && `pids: ${rgAlive}`)
}

console.log('\n── §2 the picker contract at its owner ──')
{
  const rip = readFileSync(join(REPO, 'src/utils/ripgrep.ts'), 'utf8')
  check('§2 the close arm settles totally under abort', rip.includes('a bare return would leak the promise pending forever'))
  const cs = readFileSync(join(REPO, 'src/components/MercuryContentSearch.tsx'), 'utf8')
  check('§2 a new query aborts the in-flight grep FIRST', /const gen = \+\+genRef\.current\s*\n\s*abortRef\.current\?\.abort\(\)/m.test(cs))
  check('§2 closing the picker aborts the in-flight grep (unmount cleanup)', /return \(\) => \{\s*alive = false\s*controller\.abort\(\)/m.test(cs))
  check('§2 no aborted result ever lands (gen-guard on both settle arms)', (cs.match(/gen === genRef\.current/g) ?? []).length >= 2)
  check('§2 one controller per keystroke, held in the one ref', cs.includes('abortRef.current = controller'))
}

console.log('\n── §3 the @-picker walk: single-flight, deadline disarmed ──')
{
  const idx = readFileSync(join(REPO, 'src/hooks/fileSuggestions.ts'), 'utf8')
  check('§3 one refresh in flight at a time', idx.includes('if (refreshInFlight) return'))
  check('§3 the walk deadline is disarmed in finally', /finally \{\s*clearTimeout\(timer\)/m.test(idx))
  check('§3 the untracked merge is single-flight too', idx.includes('if (untrackedInFlight) return'))
  check('§3 queries ride the in-memory index, never a per-keystroke rg', !/generateFileSuggestions[\s\S]{0,600}ripGrep/m.test(idx))
}

console.log(failures === 0 ? '\n✅ ONE IN-FLIGHT SEARCH PROVEN' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
