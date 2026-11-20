#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runIsolated(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn29-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (res.status !== 0) throw new Error(`isolated check failed (rc ${res.status}): ${(res.stderr || res.stdout).slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('1. src/utils/capability/manifest.ts — throwing isEnabled reads unavailable')
{
  const r = runIsolated(`
    const { compileToolCapabilityCard } = await import(SRC + '/utils/capability/manifest.ts')
    const base = {
      name: 'ProbeTool',
      capability: {
        class: 'observation',
        units: ['source-reading'],
        latency: 'fast',
        cancellation: 'not-applicable',
        intents: ['inspect state'],
      },
    }
    out.throwing = compileToolCapabilityCard({ ...base, isEnabled: () => { throw new Error('probe broke') } })
    out.enabled = compileToolCapabilityCard({ ...base, isEnabled: () => true })
    out.disabled = compileToolCapabilityCard({ ...base, isEnabled: () => false })
  `)
  const throwing = String(r.throwing ?? '')
  const enabled = String(r.enabled ?? '')
  const disabled = String(r.disabled ?? '')
  check(
    'manifest: throwing isEnabled marks capability card unavailable',
    throwing.includes('· unavailable]') && !throwing.includes('· available]'),
    throwing,
  )
  check(
    'manifest: control enabled and disabled cards unchanged',
    enabled.includes('· available]') && disabled.includes('· unavailable]'),
    `${enabled} | ${disabled}`,
  )
}

console.log('2. src/utils/cleanup.ts — recordingsUnderSweep rethrows non-ENOENT errors')
if (!POSIX_MODES) skip('cleanup: recordingsUnderSweep non-ENOENT errors', 'needs POSIX non-root chmod')
else {
  const r = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { recordingsUnderSweep } = await import(SRC + '/utils/cleanup.ts')
    const { getProjectsDir } = await import(SRC + '/utils/sessionStorage.ts')
    const root = getProjectsDir()
    out.absent = await recordingsUnderSweep()
    const projA = path.join(root, 'proj-a')
    fs.mkdirSync(projA, { recursive: true })
    fs.writeFileSync(path.join(projA, 'a.cast'), 'hello')
    out.readable = await recordingsUnderSweep()
    fs.chmodSync(projA, 0o000)
    try {
      out.unreadableSub = await recordingsUnderSweep()
    } catch (e) {
      out.subErr = e.code ?? String(e)
    } finally {
      fs.chmodSync(projA, 0o700)
    }
    fs.chmodSync(root, 0o000)
    try {
      out.unreadableRoot = await recordingsUnderSweep()
    } catch (e) {
      out.rootErr = e.code ?? String(e)
    } finally {
      fs.chmodSync(root, 0o700)
    }
  `)
  check(
    'cleanup: recordingsUnderSweep rejects on unreadable project subdir',
    r.subErr === 'EACCES',
    `subErr=${String(r.subErr)} result=${JSON.stringify(r.unreadableSub)}`,
  )
  check(
    'cleanup: recordingsUnderSweep rejects on unreadable projects root',
    r.rootErr === 'EACCES',
    `rootErr=${String(r.rootErr)} result=${JSON.stringify(r.unreadableRoot)}`,
  )
  const absent = r.absent as { count: number; bytes: number } | undefined
  const readable = r.readable as { count: number; bytes: number } | undefined
  check(
    'cleanup: recordingsUnderSweep control absent=0 and readable=1',
    absent?.count === 0 && absent?.bytes === 0 && readable?.count === 1 && readable?.bytes === 5,
    `${JSON.stringify(absent)} | ${JSON.stringify(readable)}`,
  )
}

console.log('3. src/utils/cockpit/daemonSnapshot.ts — EPERM on pid probe reads as live')
{
  const r = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { daemonStatePath } = await import(SRC + '/daemon/controlSocket.ts')
    const { daemonSnapshot } = await import(SRC + '/utils/cockpit/daemonSnapshot.ts')
    const recPath = daemonStatePath()
    fs.mkdirSync(path.dirname(recPath), { recursive: true })
    fs.writeFileSync(recPath, JSON.stringify({
      pid: 424242,
      version: '1.0.0',
      startedAt: Date.now() - 5000,
    }))
    const origKill = process.kill
    try {
      process.kill = ((_pid, _sig) => {
        const err = new Error('operation not permitted')
        err.code = 'EPERM'
        throw err
      })
      out.eperm = daemonSnapshot()
      process.kill = ((_pid, _sig) => {
        const err = new Error('no such process')
        err.code = 'ESRCH'
        throw err
      })
      out.esrch = daemonSnapshot()
    } finally {
      process.kill = origKill
    }
  `)
  const eperm = r.eperm as { state?: string; reason?: string } | undefined
  const esrch = r.esrch as { state?: string; reason?: string } | undefined
  check(
    'daemonSnapshot: EPERM on pid probe reads as live',
    eperm?.state === 'live' && /running · pid 424242/.test(eperm.reason ?? ''),
    JSON.stringify(eperm),
  )
  check(
    'daemonSnapshot: ESRCH on pid probe still reads unavailable stale record',
    esrch?.state === 'unavailable' && /stale record · pid 424242 not running/.test(esrch.reason ?? ''),
    JSON.stringify(esrch),
  )
}

console.log('4. src/utils/cockpit/harnessMap.ts — throwing DAP probe does not claim Debug tool is withheld')
{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    let shouldThrow = true
    mock.module(SRC + '/services/dap/dapClient.js', () => ({
      mercuryDapEnabled: () => true,
      dapAdapterProbePending: () => false,
      reachableDapAdapterKeys: () => {
        if (shouldThrow) throw new Error('dap probe exploded')
        return []
      },
    }))
    const { computeHarnessMapLines } = await import(SRC + '/utils/cockpit/harnessMap.ts')
    out.onThrow = computeHarnessMapLines().some(l => l.includes('The Debug tool is withheld'))
    shouldThrow = false
    out.onEmpty = computeHarnessMapLines().some(l => l.includes('The Debug tool is withheld'))
  `)
  check(
    'harnessMap: throwing DAP probe does not claim Debug tool is withheld',
    r.onThrow === false,
    `onThrow=${String(r.onThrow)}`,
  )
  check(
    'harnessMap: control empty DAP probe still claims Debug tool is withheld',
    r.onEmpty === true,
    `onEmpty=${String(r.onEmpty)}`,
  )
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
