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

function runSubprocess(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn22-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const SRC = ${JSON.stringify(SRC)}
    const PROJECT = ${JSON.stringify(project)}
    const HOME = ${JSON.stringify(home)}
    const attempt = async fn => {
      try { return { ok: true, value: await fn() } }
      catch (e) { return { ok: false, code: e?.code ?? null, name: e?.name ?? null, message: String(e?.message ?? e) } }
    }
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
    if (res.status !== 0) throw new Error(`subprocess exited ${res.status}: ${(res.stderr || res.stdout).slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

type Attempt = { ok: boolean; value?: unknown; code?: string | null; name?: string | null; message?: string }

console.log('\n1. unity/bridgeInstaller.ts — readProjectBridgePort throws on corrupt or unreadable settings')
{
  const r = runSubprocess(`
    const m = await import(path.join(SRC, 'services/unity/bridgeInstaller.ts'))
    const settingsDir = path.join(PROJECT, 'ProjectSettings')
    const settingsFile = path.join(settingsDir, 'MercuryUnityBridge.json')
    out.absent = await attempt(() => m.readProjectBridgePort(PROJECT))
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ port: 7123 }))
    out.valid = await attempt(() => m.readProjectBridgePort(PROJECT))
    fs.writeFileSync(settingsFile, '{not valid json')
    out.corrupt = await attempt(() => m.readProjectBridgePort(PROJECT))
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.writeFileSync(settingsFile, JSON.stringify({ port: 7123 }))
      fs.chmodSync(settingsFile, 0o200)
      out.unreadable = await attempt(() => m.readProjectBridgePort(PROJECT))
      fs.chmodSync(settingsFile, 0o600)
    }
  `)
  const absent = r.absent as Attempt
  const valid = r.valid as Attempt
  const corrupt = r.corrupt as Attempt
  check('bridgeInstaller-readProjectBridgePort: absent file returns undefined', absent.ok && absent.value === undefined, JSON.stringify(absent))
  check('bridgeInstaller-readProjectBridgePort: valid settings file returns port', valid.ok && valid.value === 7123, JSON.stringify(valid))
  check('bridgeInstaller-readProjectBridgePort: corrupt JSON throws SyntaxError', !corrupt.ok && corrupt.name === 'SyntaxError', JSON.stringify(corrupt))
  if (!POSIX_MODES) skip('bridgeInstaller-readProjectBridgePort: unreadable file', 'needs non-root POSIX')
  else {
    const unreadable = r.unreadable as Attempt
    check('bridgeInstaller-readProjectBridgePort: unreadable settings throws EACCES', !unreadable.ok && unreadable.code === 'EACCES', JSON.stringify(unreadable))
  }
}

console.log('\n2. voice/capture.ts + voice/voiceSession.ts — failed cancelCapture stays retryable and does not throw out of cancelVoiceCapture')
{
  const r = runSubprocess(`
    const { mock } = await import('bun:test')
    const realPack = await import(path.join(SRC, 'services/voice/voicePack.ts'))
    let cancelCalls = 0
    const addon = {
      packVersion: () => '1.0.0',
      listInputDevices: () => ['mic'],
      defaultInputDevice: () => 'mic',
      startCapture: () => 42,
      captureErrors: () => ({ transient: 0, lastTransient: null, fatal: null }),
      stopCapture: () => Buffer.alloc(0),
      cancelCapture: () => {
        cancelCalls++
        if (cancelCalls === 1) throw new Error('coreaudio stop busy')
      },
      lastCaptureErrors: () => null,
      ttyForegroundGroup: () => ({}),
      ownProcessGroup: () => ({}),
      reclaimTerminal: () => ({ reclaimed: false }),
    }
    const manifest = {
      name: 'mercury-voice', version: '1.0.0', platform: 'test', addon: 'a.node',
      addonSha256: '0'.repeat(64), sourceTreeDigest: '0'.repeat(64), cargo: '1', crates: [], fileCount: 1, treeDigest: '0'.repeat(64),
    }
    mock.module(path.join(SRC, 'services/voice/voicePack.ts'), () => ({
      ...realPack,
      resolveVoicePackDir: () => ({ state: 'ok', dir: PROJECT, addonPath: path.join(PROJECT, 'a.node'), manifest, source: 'override' }),
      loadVoiceAddon: () => ({ state: 'ok', addon, dir: PROJECT, manifest, source: 'override' }),
    }))
    const capture = await import(path.join(SRC, 'services/voice/capture.ts'))
    const h = await capture.startCapture({ backend: { state: 'ok', kind: 'vendored', detail: 'stub', pinned: true } })
    out.firstCancel = await attempt(() => h.cancel())
    out.settledAfterFail = h.settled
    out.secondCancel = await attempt(() => h.cancel())
    out.settledAfterRetry = h.settled
    out.cancelCalls = cancelCalls
  `)
  const firstCancel = r.firstCancel as Attempt
  const secondCancel = r.secondCancel as Attempt
  check('capture-cancelCapture-retry: first cancel throws when addon cancelCapture throws and leaves handle unsettled', !firstCancel.ok && firstCancel.message?.includes('coreaudio stop busy') === true && r.settledAfterFail === false, JSON.stringify(r))
  check('capture-cancelCapture-retry: retry calls addon cancelCapture again and settles handle', secondCancel.ok && r.settledAfterRetry === true && r.cancelCalls === 2, JSON.stringify(r))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
