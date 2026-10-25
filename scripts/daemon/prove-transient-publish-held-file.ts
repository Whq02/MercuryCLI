#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { publishTransientInDaemonHome } = await import(join(ROOT, 'src/daemon/daemonHome.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('prove-transient-publish-held-file — a session projection survives a reader that holds the file without delete sharing')
const seam = readFileSync(join(ROOT, 'src/daemon/daemonHome.ts'), 'utf8')
const body = seam.slice(seam.indexOf('export function publishTransientInDaemonHome('), seam.indexOf('export function ensureDirInDaemonHome('))
check('the transient publish renames through the Windows retry road, never a bare renameSync', body.includes('renameWithWin32RetrySync(tmp, path)') && !body.includes('renameSync(tmp, path)'), body.slice(0, 400))

if (process.platform !== 'win32') {
  console.log('  [SKIP] the held-file legs need Windows share modes (a POSIX rename never waits on a reader)')
} else {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'transient-held-')))
  const hold = async (target: string, ms: number): Promise<{ released: Promise<unknown> }> => {
    const literal = target.split("'").join("''")
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${literal}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('held')) resolve() })
      child.once('error', reject)
      child.once('close', () => resolve())
    })
    return { released: new Promise(resolve => child.once('close', resolve)) }
  }
  const attempt = (target: string): string => {
    try {
      return publishTransientInDaemonHome('the proof tail', target, 'new\n')
    } catch (error) {
      return `threw ${(error as NodeJS.ErrnoException).code ?? String(error)}`
    }
  }
  {
    const target = join(scratch, 'brief.json')
    writeFileSync(target, 'old\n')
    const held = await hold(target, 250)
    const outcome = attempt(target)
    await held.released
    check('a brief hold (250ms) is ridden out: the projection is published', outcome === 'published', outcome)
    check('…the reader-side file now carries the new bytes', readFileSync(target, 'utf8') === 'new\n', JSON.stringify(readFileSync(target, 'utf8')))
    check('…and no temp file is left beside it', readdirSync(scratch).filter(name => name.startsWith('brief.json.')).length === 0, JSON.stringify(readdirSync(scratch)))
  }
  {
    const target = join(scratch, 'long.json')
    writeFileSync(target, 'old\n')
    const held = await hold(target, 3_000)
    const t0 = Date.now()
    const outcome = attempt(target)
    const ms = Date.now() - t0
    await held.released
    check('a hold past the retry budget still ends in bounded time with the transient code (the daemon loop is never held hostage)', /^threw (EPERM|EACCES|EBUSY)$/.test(outcome) && ms < 2_000, `${outcome} after ${ms}ms`)
  }
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-transient-publish-held-file: ALL LAWS HOLD' : `\nprove-transient-publish-held-file: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
