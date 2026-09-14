#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'gh-timeout-live-')))
const hangGh = join(SCRATCH, 'hang-gh.mjs')
writeFileSync(hangGh, "const a=process.argv.slice(2)\nif(a[0]==='auth'){process.exit(0)}\nsetInterval(()=>{}, 1<<30)\n")
process.env.MERCURY_GH_CMD = JSON.stringify(['node', hangGh])

const marker = 'hang-gh.mjs'
const ghKids = (): number => {
  const out = spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).stdout ?? ''
  return out.split('\n').filter(l => l.includes(marker)).length
}

const { gh } = await import('../../src/services/privateChannel/ghRelease.ts')

console.log('§1 a hung gh spawn is killed by its own timeout, live (never a process that lingers for days)')
{
  const TIMEOUT_MS = 2000
  const started = Date.now()
  const raced = await Promise.race([
    gh(['api', 'repos/Whq02/MercuryCLI', '--jq', '.private'], { timeoutMs: TIMEOUT_MS }).then(res => ({ kind: 'settled' as const, res })),
    new Promise<{ kind: 'overran' }>(resolve => setTimeout(() => resolve({ kind: 'overran' }), TIMEOUT_MS * 4)),
  ])
  const elapsed = Date.now() - started
  check('the gh call SETTLES (the timeout fired) rather than hanging past 4x its budget', raced.kind === 'settled', `elapsed=${elapsed}ms`)
  if (raced.kind === 'settled') {
    check('…within roughly the timeout budget, not the two-minute default', elapsed < TIMEOUT_MS * 3, `elapsed=${elapsed}ms`)
    check('…and reports an error state (the child was killed, not a clean answer)', raced.res.state === 'error', JSON.stringify(raced.res))
  }
  await new Promise(r => setTimeout(r, 500))
  check('the hung gh child was reaped (SIGKILL landed — nothing lingers)', ghKids() === 0, `${ghKids()} still alive`)
}

console.log('\n§2 the spawn owner carries a bounded timeout and SIGKILL (source)')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(REPO, 'src/services/privateChannel/ghRelease.ts'), 'utf8')
  check('the one gh spawn passes a timeout and kills with SIGKILL', /timeout: timeoutMs/.test(src) && /killSignal: 'SIGKILL'/.test(src))
  check('the default budget is bounded (two minutes), not unbounded', /GH_TIMEOUT_MS = 120_000/.test(src))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ prove-gh-timeout-live: all green' : `\n❌ prove-gh-timeout-live: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
