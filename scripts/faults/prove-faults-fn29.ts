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

console.log('1. src/permissions/capability/manifest.ts — throwing isEnabled reads unavailable')
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
    const { recordingsUnderSweep } = await import(SRC + '/services/cleanup.ts')
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

console.log('3. src/screen/cockpit-gauges/daemonSnapshot.ts — EPERM on pid probe reads as live')
{
  const r = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { daemonStatePath } = await import(SRC + '/daemon/controlSocket.ts')
    const { daemonSnapshot } = await import(SRC + '/services/cockpit/daemonSnapshot.ts')
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

console.log('4. src/screen/cockpit-gauges/harnessMap.ts — throwing DAP probe does not claim Debug tool is withheld')
{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    const realDap = await import(SRC + '/services/dap/dapClient.ts')
    let shouldThrow = true
    mock.module(SRC + '/services/dap/dapClient.js', () => ({
      ...realDap,
      mercuryDapEnabled: () => true,
      dapAdapterProbePending: () => false,
      reachableDapAdapterKeys: () => {
        if (shouldThrow) throw new Error('dap probe exploded')
        return []
      },
    }))
    const { computeHarnessMapLines } = await import(SRC + '/services/cockpit/harnessMap.ts')
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

console.log('5. src/platform/health/healthCertSnapshot.ts — corrupt or unreadable cert reads certificate unreadable')
{
  const r = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { lastCertPath } = await import(SRC + '/services/health/healthReport.ts')
    const { healthCertSnapshot } = await import(SRC + '/services/health/healthCertSnapshot.ts')
    out.absent = healthCertSnapshot()
    const certFile = lastCertPath()
    fs.mkdirSync(path.dirname(certFile), { recursive: true })
    fs.writeFileSync(certFile, '{ not valid json')
    out.corrupt = healthCertSnapshot()
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.writeFileSync(certFile, '{"verdict":"pass"}', { mode: 0o600 })
      fs.chmodSync(certFile, 0o200)
      try {
        out.unreadable = healthCertSnapshot()
      } finally {
        fs.chmodSync(certFile, 0o600)
      }
    }
  `)
  const absent = r.absent as { state?: string; reason?: string } | undefined
  const corrupt = r.corrupt as { state?: string; reason?: string } | undefined
  const unreadable = r.unreadable as { state?: string; reason?: string } | undefined
  check(
    'healthCertSnapshot: corrupt cert file reads certificate unreadable',
    corrupt?.state === 'unavailable' && corrupt.reason === 'certificate unreadable',
    JSON.stringify(corrupt),
  )
  if (POSIX_MODES) {
    check(
      'healthCertSnapshot: unreadable cert file reads certificate unreadable',
      unreadable?.state === 'unavailable' && unreadable.reason === 'certificate unreadable',
      JSON.stringify(unreadable),
    )
  } else {
    skip('healthCertSnapshot: unreadable cert file', 'needs POSIX non-root chmod')
  }
  check(
    'healthCertSnapshot: control absent cert still reads no certificate issued',
    absent?.state === 'unavailable' && absent.reason === 'no certificate issued — run /health',
    JSON.stringify(absent),
  )
}

console.log('6. src/screen/cockpit-gauges/mcpGauge.ts — policy or project MCP read failure reads unavailable')
{
  const rPolicy = runIsolated(`
    const { mock } = await import('bun:test')
    const realPolicy = await import(SRC + '/utils/mcp/toolPolicy.ts')
    mock.module(SRC + '/utils/mcp/toolPolicy.js', () => ({
      ...realPolicy,
      getMaxExposedRisk: () => { throw new Error('policy read failed') },
    }))
    const { enableConfigs } = await import(SRC + '/utils/config/globalConfig.ts')
    enableConfigs()
    const { mcpGauge } = await import(SRC + '/services/cockpit/mcpGauge.ts')
    out.snap = mcpGauge()
  `)
  const snapPolicy = rPolicy.snap as { state?: string; reason?: string; data?: { mcpPolicyHint?: string } } | undefined
  check(
    'mcpGauge: throwing policy read returns unavailable instead of permissive default',
    snapPolicy?.state === 'unavailable' && snapPolicy.reason === 'mcp config unreadable' && snapPolicy.data?.mcpPolicyHint !== 'high · permissive',
    JSON.stringify(snapPolicy),
  )

  const rProj = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { enableConfigs } = await import(SRC + '/utils/config/globalConfig.ts')
    const { setCwd } = await import(SRC + '/utils/Shell.ts')
    const { setIsInteractive, setSessionTrustAccepted, setOriginalCwd, setProjectRoot } = await import(SRC + '/bootstrap/state.ts')
    const { resetTrustDialogAcceptedCacheForTesting } = await import(SRC + '/utils/config/trust.ts')
    enableConfigs()
    setCwd(PROJECT)
    setOriginalCwd(PROJECT)
    setProjectRoot(PROJECT)
    setIsInteractive(false)
    setSessionTrustAccepted(true)
    resetTrustDialogAcceptedCacheForTesting()
    fs.mkdirSync(path.join(PROJECT, '.mercury'), { recursive: true })
    fs.writeFileSync(path.join(PROJECT, '.mercury', 'mcp.json'), '{ broken json')
    const { mcpGauge } = await import(SRC + '/services/cockpit/mcpGauge.ts')
    out.corrupt = mcpGauge()
  `)
  const snapCorrupt = rProj.corrupt as { state?: string; reason?: string } | undefined
  check(
    'mcpGauge: unreadable or corrupt project MCP config reads unavailable',
    snapCorrupt?.state === 'unavailable' && snapCorrupt.reason === 'mcp config unreadable',
    JSON.stringify(snapCorrupt),
  )
}

console.log('7. src/screen/cockpit/traceSnapshot.ts — unreadable trace file does not say no trace file yet')
if (!POSIX_MODES) skip('traceSnapshot: unreadable trace file', 'needs POSIX non-root chmod')
else {
  const r = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    process.env.MERCURY_TRACE = '1'
    const { getInvocationTracePath } = await import(SRC + '/utils/observability/invocationTrace.ts')
    const { traceSnapshot } = await import(SRC + '/utils/cockpit/traceSnapshot.ts')
    out.absent = await traceSnapshot()
    const traceFile = getInvocationTracePath()
    fs.mkdirSync(path.dirname(traceFile), { recursive: true })
    fs.writeFileSync(traceFile, '{"tool":"Read"}\\n', { mode: 0o600 })
    fs.chmodSync(traceFile, 0o200)
    try {
      out.unreadable = await traceSnapshot()
    } finally {
      fs.chmodSync(traceFile, 0o600)
    }
  `)
  const absent = r.absent as { state?: string; reason?: string } | undefined
  const unreadable = r.unreadable as { state?: string; reason?: string } | undefined
  check(
    'traceSnapshot: unreadable trace file reports trace file unreadable with error message',
    unreadable?.state === 'unavailable' && (unreadable.reason ?? '').startsWith('trace file unreadable (') && (unreadable.reason ?? '').includes('EACCES'),
    JSON.stringify(unreadable),
  )
  check(
    'traceSnapshot: control absent trace file still reads no trace file yet',
    absent?.state === 'unavailable' && absent.reason === 'no trace file yet',
    JSON.stringify(absent),
  )
}

console.log('8. src/screen/app-state/commitAttribution.ts — throwing git deleted-file probe propagates')
{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    const realExec = await import(SRC + '/utils/execFileNoThrow.ts')
    mock.module(SRC + '/utils/execFileNoThrow.js', () => ({
      ...realExec,
      execFileNoThrowWithCwd: async () => {
        throw new Error('git spawn exploded')
      },
    }))
    const { calculateCommitAttribution, createEmptyAttributionState } = await import(SRC + '/utils/commitAttribution.ts')
    try {
      out.data = await calculateCommitAttribution([createEmptyAttributionState()], ['gone.ts'])
    } catch (e) {
      out.err = e instanceof Error ? e.message : String(e)
    }
  `)
  check(
    'commitAttribution: throwing git probe in isFileDeleted rejects instead of dropping file',
    r.err === 'git spawn exploded',
    `err=${String(r.err)} data=${JSON.stringify(r.data)}`,
  )
}

console.log('9. src/platform/config/globalConfig.ts — failed quarantine copy does not claim bytes were kept')
if (!POSIX_MODES) skip('globalConfig: failed quarantine copy', 'needs POSIX non-root chmod')
else {
  const r = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const {
      enableConfigs,
      getConfig,
      getConfigBackupDir,
    } = await import(SRC + '/utils/config/globalConfig.ts')
    const { createDefaultGlobalConfig } = await import(SRC + '/utils/config/schema.ts')
    enableConfigs()
    const target = path.join(HOME, 'corrupt-test.json')
    fs.writeFileSync(target, '{ broken json', { mode: 0o600 })
    const backupDir = getConfigBackupDir()
    fs.mkdirSync(backupDir, { recursive: true })
    let captured = ''
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk => {
      captured += String(chunk)
      return true
    })
    fs.chmodSync(backupDir, 0o500)
    try {
      getConfig(target, createDefaultGlobalConfig)
    } finally {
      fs.chmodSync(backupDir, 0o700)
      process.stderr.write = origWrite
    }
    out.stderrOnFail = captured
    let capturedOk = ''
    process.stderr.write = (chunk => {
      capturedOk += String(chunk)
      return true
    })
    try {
      getConfig(target, createDefaultGlobalConfig)
    } finally {
      process.stderr.write = origWrite
    }
    out.stderrOnOk = capturedOk
  `)
  const stderrOnFail = String(r.stderrOnFail ?? '')
  const stderrOnOk = String(r.stderrOnOk ?? '')
  check(
    'globalConfig: failed quarantine copy does not claim bytes were kept at path',
    !stderrOnFail.includes('The unreadable bytes were kept at'),
    stderrOnFail,
  )
  check(
    'globalConfig: control succeeded quarantine copy still states where bytes were kept',
    stderrOnOk.includes('The unreadable bytes were kept at'),
    stderrOnOk,
  )
}

console.log('10. src/screen/cockpit-gauges/daemonSnapshot.ts — unexpected failure reads daemon state unreadable')
{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    const realCtrl = await import(SRC + '/daemon/controlSocket.ts')
    mock.module(SRC + '/daemon/controlSocket.js', () => ({
      ...realCtrl,
      daemonStatePath: () => { throw new Error('state path broke') },
    }))
    const { daemonSnapshot } = await import(SRC + '/services/cockpit/daemonSnapshot.ts')
    out.snap = daemonSnapshot()
  `)
  const snap = r.snap as { state?: string; reason?: string } | undefined
  check(
    'daemonSnapshot: unexpected error reads unavailable with daemon state unreadable',
    snap?.state === 'unavailable' && snap.reason === 'daemon state unreadable (state path broke)',
    JSON.stringify(snap),
  )
}

console.log('11. src/screen/cockpit-gauges/fleetGauge.ts — worker or execution listing failure reads fleet roster unreadable')
{
  const rConcourse = runIsolated(`
    const { mock } = await import('bun:test')
    const realConcourse = await import(SRC + '/daemon/concourseWorkers.ts')
    mock.module(SRC + '/daemon/concourseWorkers.js', () => ({
      ...realConcourse,
      listConcourseWorkers: () => { throw new Error('workers read failed') },
    }))
    const { fleetGauge } = await import(SRC + '/services/cockpit/fleetGauge.ts')
    out.snap = await fleetGauge()
  `)
  const snapC = rConcourse.snap as { state?: string; reason?: string } | undefined
  check(
    'fleetGauge: throwing listConcourseWorkers reads unavailable fleet roster unreadable',
    snapC?.state === 'unavailable' && snapC.reason === 'fleet roster unreadable (workers read failed)',
    JSON.stringify(snapC),
  )

  const rExec = runIsolated(`
    const { mock } = await import('bun:test')
    const realExec = await import(SRC + '/utils/primitives/executionPlane.ts')
    mock.module(SRC + '/utils/primitives/executionPlane.js', () => ({
      ...realExec,
      listExecutions: () => { throw new Error('executions registry failed') },
    }))
    const { fleetGauge } = await import(SRC + '/services/cockpit/fleetGauge.ts')
    out.snap = await fleetGauge()
  `)
  const snapE = rExec.snap as { state?: string; reason?: string } | undefined
  check(
    'fleetGauge: throwing listExecutions reads unavailable fleet roster unreadable',
    snapE?.state === 'unavailable' && snapE.reason === 'fleet roster unreadable (executions registry failed)',
    JSON.stringify(snapE),
  )
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
