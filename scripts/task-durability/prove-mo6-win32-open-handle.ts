#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  durableAtomicPublish,
  DurablePublishError,
  isDurableTempName,
  type DurablePublishReport,
} from '../../src/substrate/durablePublish.ts'

if (process.platform !== 'win32') {
  console.log('── mo6 win32 open-handle lifecycle — SKIP (POSIX host: an open handle never blocks rename here).')
  console.log('   The windows-functional lane runs this prover on a real NTFS runner.')
  console.log('\nPASS prove-mo6-win32-open-handle (skipped: not win32)')
  process.exit(0)
}

let failures = 0
const ok = (cond: boolean, label: string, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const tmp = mkdtempSync(join(tmpdir(), 'mooring-mo6-'))
const tempsIn = (dir: string): string[] => readdirSync(dir).filter(isDurableTempName)
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const describe = (e: unknown): string =>
  e instanceof DurablePublishError
    ? `DurablePublishError phase=${e.phase} fsCode=${e.fsCode} attempts=${e.attempts} elapsedMs=${e.elapsedMs} tempCleanup=${e.tempCleanup}`
    : String(e)

interface Holder {
  held: Promise<void>
  done: Promise<number | null>
  kill: () => void
}

function holdFile(path: string, releasePath: string, fallbackMs: number): Holder {
  const q = (s: string): string => s.replace(/'/g, "''")
  const script = [
    `$f=[System.IO.File]::Open('${q(path)}','Open','Read','Read')`,
    `[Console]::Out.WriteLine('HELD')`,
    `[Console]::Out.Flush()`,
    `$deadline=[DateTime]::UtcNow.AddMilliseconds(${fallbackMs})`,
    `while(-not (Test-Path -LiteralPath '${q(releasePath)}') -and ([DateTime]::UtcNow -lt $deadline)){ Start-Sleep -Milliseconds 25 }`,
    `$f.Close()`,
    `[Console]::Out.WriteLine('RELEASED')`,
  ].join('; ')
  const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  let resolveHeld!: () => void
  const held = new Promise<void>(resolve => {
    resolveHeld = resolve
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (chunk.includes('HELD')) resolveHeld()
  })
  const done = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  return { held, done, kill: () => void child.kill() }
}

const awaitHeld = (holder: Holder): Promise<'held' | 'exited' | 'timeout'> =>
  Promise.race([
    holder.held.then(() => 'held' as const),
    holder.done.then(() => 'exited' as const),
    pause(30_000).then(() => 'timeout' as const),
  ])

async function section(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (e) {
    ok(false, `${label} ran to completion without an uncaught throw`, describe(e))
  }
}

console.log('── mo6 win32 open-handle lifecycle (real foreign handle, command-driven release)')

await section('§1', async () => {
  const dir = join(tmp, 's1')
  const p = join(dir, 'held.json')
  const release = join(tmp, 's1.release')
  await durableAtomicPublish(p, 'previous-good')
  const holder = holdFile(p, release, 10_000)
  const engaged = await awaitHeld(holder)
  ok(engaged === 'held', '§1 the PowerShell holder engaged (HELD observed)', engaged === 'held' ? '' : engaged)
  if (engaged !== 'held') {
    holder.kill()
    return
  }
  const started = Date.now()
  let settled = false
  const outcome: Promise<{ landed: DurablePublishReport } | { failed: unknown }> = durableAtomicPublish(
    p,
    'new-value',
  ).then(
    r => {
      settled = true
      return { landed: r }
    },
    e => {
      settled = true
      return { failed: e as unknown }
    },
  )
  await pause(50)
  ok(!settled, '§1 the publish is still in flight at +50ms (the retry arm is demonstrably engaged)')
  writeFileSync(release, 'release')
  const res = await outcome
  const wall = Date.now() - started
  if ('landed' in res) {
    ok(
      res.landed.attempts > 1 && res.landed.retriedTransient,
      `§1 the publish RETRIED through the live handle (attempts=${res.landed.attempts})`,
    )
    ok(readFileSync(p, 'utf8') === 'new-value', '§1 the complete NEW value landed')
    ok(wall < 5_000, `§1 landed promptly once the release was commanded (${wall}ms)`)
  } else {
    console.log(`  · §1 LOST RACE under runner starvation (${wall}ms to exhaustion) — degrading to typed-failure discipline`)
    const err = res.failed instanceof DurablePublishError ? res.failed : null
    ok(
      err !== null &&
        err.phase === 'rename' &&
        (err.fsCode === 'EPERM' || err.fsCode === 'EACCES' || err.fsCode === 'EBUSY'),
      '§1 lost race: typed failure with the real fs code',
      describe(res.failed),
    )
    ok(
      err?.attempts === 4 && err?.tempCleanup === 'removed',
      `§1 lost race: full budget spent, temp cleaned (attempts=${err?.attempts}, ${err?.tempCleanup})`,
    )
    ok(readFileSync(p, 'utf8') === 'previous-good', '§1 lost race: the committed file stayed intact through exhaustion')
    await holder.done
    const after = await durableAtomicPublish(p, 'new-value')
    ok(
      after.attempts >= 1 && readFileSync(p, 'utf8') === 'new-value',
      '§1 the publish after the commanded release landed the NEW value',
    )
  }
  ok(tempsIn(dir).length === 0, '§1 no temp residue')
  await holder.done
})

await section('§2', async () => {
  const dir = join(tmp, 's2')
  const p = join(dir, 'stuck.json')
  const release = join(tmp, 's2.release')
  await durableAtomicPublish(p, 'previous-good')
  const holder = holdFile(p, release, 10_000)
  const engaged = await awaitHeld(holder)
  ok(engaged === 'held', '§2 the PowerShell holder engaged (HELD observed)', engaged === 'held' ? '' : engaged)
  if (engaged !== 'held') {
    holder.kill()
    return
  }
  let caught: unknown = null
  try {
    await durableAtomicPublish(p, 'never-lands')
  } catch (e) {
    caught = e
  }
  const err = caught instanceof DurablePublishError ? caught : null
  ok(
    err !== null && err.phase === 'rename' && (err.fsCode === 'EPERM' || err.fsCode === 'EACCES' || err.fsCode === 'EBUSY'),
    '§2 beyond-budget: typed failure with the real fs code',
    err ? `fsCode=${err.fsCode}` : caught === null ? 'the publish unexpectedly LANDED through the held handle' : describe(caught),
  )
  ok(err?.attempts === 4 && (err?.elapsedMs ?? 0) >= 350, `§2 full budget spent (attempts=${err?.attempts}, ${err?.elapsedMs}ms)`)
  ok(err?.tempCleanup === 'removed', `§2 prepared temp cleaned (${err?.tempCleanup})`)
  ok(readFileSync(p, 'utf8') === 'previous-good', '§2 the committed file stayed READABLE + intact through the whole hold')
  ok(tempsIn(dir).length === 0, '§2 no orphan replacement left behind')
  writeFileSync(release, 'release')
  await holder.done
  const after = await durableAtomicPublish(p, 'after-release')
  ok(after.attempts === 1 && readFileSync(p, 'utf8') === 'after-release', '§2 the next publish after release lands cleanly')
})

try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\nPASS prove-mo6-win32-open-handle' : `\nFAIL prove-mo6-win32-open-handle (${failures})`)
process.exit(failures === 0 ? 0 : 1)
