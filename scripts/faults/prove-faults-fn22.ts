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

console.log('\n3. voice/voiceSession.ts — cancelVoiceCapture keeps active handle on cancel error and retries cleanly')
{
  const r = runSubprocess(`
    const { mock } = await import('bun:test')
    const realPack = await import(path.join(SRC, 'services/voice/voicePack.ts'))
    const realTranscribe = await import(path.join(SRC, 'services/voice/transcribe.ts'))
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
    mock.module(path.join(SRC, 'services/voice/transcribe.ts'), () => ({
      ...realTranscribe,
      resolveTranscriber: () => ({
        state: 'ok',
        choice: { kind: 'local', label: 'stub', model: 'tiny' },
        local: { state: 'ok', label: 'stub', model: 'tiny', language: 'en', pack: { version: '1', platform: 'test', engine: 'whisper 1', gpu: 'none', where: 'override', floor: 'met' } },
      }),
      localDecodesInFlight: () => 0,
      warmLocalTranscriber: () => {},
    }))
    const session = await import(path.join(SRC, 'services/voice/voiceSession.ts'))
    session.setVoiceInputEnabled(true)
    const started = await session.startVoiceCapture({ road: 'command' })
    out.started = started.kind
    out.first = await attempt(() => session.cancelVoiceCapture())
    out.receiptAfterFail = session.voiceSnapshot().receipt
    out.phaseAfterFail = session.voiceSnapshot().phase
    out.second = await attempt(() => session.cancelVoiceCapture())
    out.phaseAfterRetry = session.voiceSnapshot().phase
    out.cancelCalls = cancelCalls
  `)
  const first = r.first as Attempt
  const second = r.second as Attempt
  const receipt = r.receiptAfterFail as { text?: string; tone?: string } | null
  check('voiceSession-cancelVoiceCapture-retry: first cancel does not throw, keeps recording active, and shows error receipt', r.started === 'started' && first.ok && first.value === false && r.phaseAfterFail === 'recording' && receipt?.tone === 'error' && receipt?.text?.includes('coreaudio stop busy') === true, JSON.stringify(r))
  check('voiceSession-cancelVoiceCapture-retry: retry cancels the kept handle and returns to idle', second.ok && second.value === true && r.phaseAfterRetry === 'idle' && r.cancelCalls === 2, JSON.stringify(r))
}

console.log('\n4. vulcan/addonInstaller.ts — unreadable project.godot is never overwritten by mutateProjectGodot and throws in readRuntimeAutoloadEntry')
if (!POSIX_MODES) skip('addonInstaller-projectGodot', 'needs non-root POSIX')
else {
  const r = runSubprocess(`
    const m = await import(path.join(SRC, 'services/vulcan/addonInstaller.ts'))
    const file = path.join(PROJECT, 'project.godot')
    out.absentAutoload = await attempt(() => m.readRuntimeAutoloadEntry(PROJECT))
    const original = 'config_version=5\\n\\n[application]\\n\\nconfig/name="KeepMe"\\n'
    fs.writeFileSync(file, original, { mode: 0o600 })
    fs.chmodSync(file, 0o200)
    out.autoloadUnreadable = await attempt(() => m.readRuntimeAutoloadEntry(PROJECT))
    out.mutateUnreadable = await attempt(() => m.mutateProjectGodot(PROJECT, text => ({ text: text + '\\n[autoload]\\nX="*res://x.gd"\\n', edits: [] })))
    fs.chmodSync(file, 0o600)
    out.contentAfter = fs.readFileSync(file, 'utf8')
    out.tmps = fs.readdirSync(PROJECT).filter(n => n.includes('.mercury-tmp-'))
  `)
  const absentAutoload = r.absentAutoload as Attempt
  const autoloadUnreadable = r.autoloadUnreadable as Attempt
  const mutateUnreadable = r.mutateUnreadable as Attempt
  check('addonInstaller-readRuntimeAutoloadEntry: absent project.godot returns undefined', absentAutoload.ok && absentAutoload.value === undefined, JSON.stringify(absentAutoload))
  check('addonInstaller-readRuntimeAutoloadEntry: unreadable project.godot throws EACCES', !autoloadUnreadable.ok && autoloadUnreadable.code === 'EACCES', JSON.stringify(autoloadUnreadable))
  check('addonInstaller-mutateProjectGodot: unreadable project.godot throws EACCES, preserves bytes, and leaves no temp file', !mutateUnreadable.ok && mutateUnreadable.code === 'EACCES' && typeof r.contentAfter === 'string' && r.contentAfter.includes('config/name="KeepMe"') && Array.isArray(r.tmps) && r.tmps.length === 0, JSON.stringify(r))
}

console.log('\n5. vulcan/engine/compileGate.ts — unreadable project.godot throws in projectAutoloads and unreadable script fails runEngineCheck')
if (!POSIX_MODES) skip('compileGate', 'needs non-root POSIX')
else {
  const r = runSubprocess(`
    const m = await import(path.join(SRC, 'services/vulcan/engine/compileGate.ts'))
    out.absentAutoloads = await attempt(() => m.projectAutoloads(path.join(PROJECT, 'missing')))
    const godotFile = path.join(PROJECT, 'project.godot')
    fs.writeFileSync(godotFile, '[autoload]\\nEvents="*res://events.gd"\\n', { mode: 0o600 })
    fs.chmodSync(godotFile, 0o200)
    out.unreadableAutoloads = await attempt(() => m.projectAutoloads(PROJECT))
    fs.chmodSync(godotFile, 0o600)
    const fakeBin = path.join(HOME, 'fake-godot.sh')
    fs.writeFileSync(fakeBin, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 })
    const scriptFile = path.join(PROJECT, 'suite.gd')
    fs.writeFileSync(scriptFile, 'extends SceneTree\\nfunc _initialize():\\n\\tEvents.go()\\n', { mode: 0o600 })
    fs.chmodSync(scriptFile, 0o200)
    const res = await m.runEngineCheck(PROJECT, { files: ['suite.gd'], shaders: false }, { executable: fakeBin })
    fs.chmodSync(scriptFile, 0o600)
    out.checkOk = res.ok
    out.checkFailures = res.failures
  `)
  const absentAutoloads = r.absentAutoloads as Attempt
  const unreadableAutoloads = r.unreadableAutoloads as Attempt
  const checkFailures = r.checkFailures as Array<{ file?: string; spawnError?: string | null }>
  check('compileGate-projectAutoloads: absent project.godot returns empty list', absentAutoloads.ok && Array.isArray(absentAutoloads.value) && absentAutoloads.value.length === 0, JSON.stringify(absentAutoloads))
  check('compileGate-projectAutoloads: unreadable project.godot throws EACCES', !unreadableAutoloads.ok && unreadableAutoloads.code === 'EACCES', JSON.stringify(unreadableAutoloads))
  check('compileGate-scriptModeHead: unreadable script records a failure and makes ok false', r.checkOk === false && checkFailures.some(f => f.file === 'res://suite.gd' && typeof f.spawnError === 'string' && f.spawnError.includes('EACCES')), JSON.stringify(r))
}

console.log('\n6. vulcan/engine/frozenTree.ts — unreadable files throw in materializeEngineTree, engineTreeHashes, and liveTreeFacts')
if (!POSIX_MODES) skip('frozenTree', 'needs non-root POSIX')
else {
  const r = runSubprocess(`
    const m = await import(path.join(SRC, 'services/vulcan/engine/frozenTree.ts'))
    const aPath = path.join(PROJECT, 'a.gd')
    fs.writeFileSync(aPath, 'class_name Foo\\n', { mode: 0o600 })
    fs.chmodSync(aPath, 0o200)
    out.hashesUnreadable = await attempt(() => m.engineTreeHashes({ path: PROJECT, baseBlobs: new Map([['a.gd', '1111']]), overlay: new Map() }))
    out.hashesAbsent = await attempt(() => m.engineTreeHashes({ path: PROJECT, baseBlobs: new Map([['missing.gd', '1111']]), overlay: new Map() }))
    const fakeGit = async (_root, args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'a'.repeat(40) + '\\n', stderr: '' }
      if (args[0] === 'ls-tree') return { code: 0, stdout: '100644 blob ' + 'b'.repeat(40) + '\\ta.gd\\0', stderr: '' }
      if (args[0] === 'status') return { code: 0, stdout: ' M a.gd\\0', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    out.liveUnreadable = await attempt(() => m.liveTreeFacts(PROJECT, fakeGit))
    fs.chmodSync(aPath, 0o600)
    const subDir = path.join(PROJECT, 'locked')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'b.gd'), 'extends Node\\n')
    fs.chmodSync(subDir, 0o000)
    out.materializeUnreadable = await attempt(() => m.materializeEngineTree(PROJECT, { ref: 'HEAD', files: ['locked/b.gd'], working: false, label: 'HEAD+locked/b.gd' }, path.join(HOME, 'tree-dest'), fakeGit))
    fs.chmodSync(subDir, 0o700)
  `)
  const hashesUnreadable = r.hashesUnreadable as Attempt
  const hashesAbsent = r.hashesAbsent as Attempt
  const liveUnreadable = r.liveUnreadable as Attempt
  const materializeUnreadable = r.materializeUnreadable as Attempt
  check('frozenTree-hashes: unreadable file throws EACCES in engineTreeHashes while absent file still succeeds', !hashesUnreadable.ok && hashesUnreadable.code === 'EACCES' && hashesAbsent.ok, JSON.stringify({ hashesUnreadable, hashesAbsent }))
  check('frozenTree-liveTreeFacts: unreadable modified file throws EACCES instead of recording deletion', !liveUnreadable.ok && liveUnreadable.code === 'EACCES', JSON.stringify(liveUnreadable))
  check('frozenTree-materialize: unreadable overlay path throws EACCES instead of deleting from tree', !materializeUnreadable.ok && materializeUnreadable.code === 'EACCES', JSON.stringify(materializeUnreadable))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
