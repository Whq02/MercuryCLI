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

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runScenario(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn11-')))
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
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const SRC = ${JSON.stringify(SRC)}
    const HOME = ${JSON.stringify(home)}
    const SCRATCH = ${JSON.stringify(scratch)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', ...extraEnv },
    })
    if (res.status !== 0) throw new Error(`scenario failed (rc=${res.status}): ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\ncomputerGrant.clearComputerGrant — non-ENOENT unlink failure throws')
{
  const r = runScenario(`
    const cg = await import(path.join(SRC, 'services/desktop/computerGrant.ts'))
    const grantFile = cg.computerGrantPath('sess-1', HOME)
    cg.writeComputerGrant('sess-1', cg.sessionComputerGrant(1000), HOME)
    const dir = path.dirname(grantFile)
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.chmodSync(dir, 0o500)
      try {
        cg.clearComputerGrant('sess-1', HOME)
        out.clearDenied = null
      } catch (e) {
        out.clearDenied = { code: e.code ?? null, message: String(e.message ?? e) }
      } finally {
        fs.chmodSync(dir, 0o700)
      }
      out.stillOnDisk = fs.existsSync(grantFile)
      cg.writeComputerGrant('sess-exp', cg.timedComputerGrant(1, 1000), HOME)
      const expDir = path.dirname(cg.computerGrantPath('sess-exp', HOME))
      fs.chmodSync(expDir, 0o500)
      try {
        out.expiredRead = cg.readComputerGrant('sess-exp', 1000 + cg.HOUR_MS + 1, HOME)
      } finally {
        fs.chmodSync(expDir, 0o700)
      }
    } else {
      fs.rmSync(grantFile)
      fs.mkdirSync(grantFile)
      try {
        cg.clearComputerGrant('sess-1', HOME)
        out.clearDenied = null
      } catch (e) {
        out.clearDenied = { code: e.code ?? null, message: String(e.message ?? e) }
      }
      out.stillOnDisk = fs.existsSync(grantFile)
      fs.rmdirSync(grantFile)
      out.expiredRead = null
    }
    cg.clearComputerGrant('sess-absent', HOME)
    out.absentOk = true
  `)
  check('clearComputerGrant throws when unlink fails with non-ENOENT', r.clearDenied !== null && r.stillOnDisk === true, JSON.stringify(r))
  check('clearComputerGrant ignores ENOENT and readComputerGrant still returns null on expired grant', r.absentOk === true && r.expiredRead === null, JSON.stringify(r))
}

console.log('\ndesktopClaim.readDesktopClaimFile — non-ENOENT read error throws instead of claiming idle')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const focused = await import(path.join(SRC, 'services/engine-connector/focusedConnector.ts'))
    const owner = focused.conversationIdHere() + ':' + process.pid
    const pidLockPath = path.join(SRC, 'substrate/pidLock.ts')
    const realPidLock = await import(pidLockPath)
    mock.module(pidLockPath, () => ({
      ...realPidLock,
      probePidLock: async () => ({ owner, pid: process.pid, acquiredAt: Date.now() }),
    }))
    const claim = await import(path.join(SRC, 'services/desktop/desktopClaim.ts'))
    const lockFile = claim.desktopClaimPath()
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.writeFileSync(lockFile, JSON.stringify({ owner, pid: process.pid, app: { identity: 'app.id', name: 'App' }, since: 100 }))
      fs.chmodSync(lockFile, 0o000)
      try {
        out.unreadable = await claim.readDesktopClaimFile()
      } catch (e) {
        out.unreadableErr = { code: e.code ?? null, message: String(e.message ?? e) }
      } finally {
        fs.chmodSync(lockFile, 0o600)
        fs.rmSync(lockFile, { force: true })
      }
    } else {
      fs.mkdirSync(lockFile)
      try {
        out.unreadable = await claim.readDesktopClaimFile()
      } catch (e) {
        out.unreadableErr = { code: e.code ?? null, message: String(e.message ?? e) }
      } finally {
        fs.rmdirSync(lockFile)
      }
    }
    out.vanished = await claim.readDesktopClaimFile()
  `)
  check('readDesktopClaimFile throws on non-ENOENT read error after holder confirmed', r.unreadableErr !== undefined && r.unreadable === undefined, JSON.stringify(r))
  check('readDesktopClaimFile still returns idle on ENOENT vanish race', (r.vanished as { phase?: string })?.phase === 'idle', JSON.stringify(r))
}

console.log('\nfakeDesktopDriver.readFakeActLog — non-ENOENT read error throws instead of returning empty list')
{
  const r = runScenario(`
    const fake = await import(path.join(SRC, 'services/desktop/fakeDesktopDriver.ts'))
    const logDir = path.join(SCRATCH, 'not-a-file')
    fs.mkdirSync(logDir)
    try {
      out.onDir = fake.readFakeActLog(logDir)
    } catch (e) {
      out.dirErr = { code: e.code ?? null, message: String(e.message ?? e) }
    }
    out.onAbsent = fake.readFakeActLog(path.join(SCRATCH, 'absent.jsonl'))
  `)
  check('readFakeActLog throws on non-ENOENT error (EISDIR)', r.dirErr !== undefined && r.onDir === undefined, JSON.stringify(r))
  check('readFakeActLog still returns [] on ENOENT', Array.isArray(r.onAbsent) && r.onAbsent.length === 0, JSON.stringify(r))
}

console.log('\nnativeDriver.keyboardIdleMs — addon throw propagates instead of answering null')
{
  const r = runScenario(`
    const { voicePackPlatform } = await import(path.join(SRC, 'services/voice/voicePack.ts'))
    const pack = await import(path.join(SRC, 'services/desktop/pack.ts'))
    const packDir = path.join(SCRATCH, 'desktop-pack')
    fs.mkdirSync(packDir, { recursive: true })
    const stubLines = pack.DESKTOP_ADDON_EXPORTS.map(fn => '  ' + fn + ': () => ({}),').join('\\n')
    const addonSrc = 'let mode = "throw";\\nmodule.exports = {\\n' + stubLines + '\\n  setMode(m) { mode = m },\\n  keyboardIdleMs() { if (mode === "throw") throw new Error("addon idle read failed"); return mode === "num" ? 42 : null },\\n};\\n'
    const addonFile = path.join(packDir, 'stub-addon.cjs')
    fs.writeFileSync(addonFile, addonSrc)
    const hex = 'a'.repeat(64)
    fs.writeFileSync(path.join(packDir, pack.DESKTOP_PACK_MANIFEST_FILE), JSON.stringify({
      name: pack.DESKTOP_PACK_NAME,
      version: '0.0.0-test',
      platform: voicePackPlatform(),
      addon: 'stub-addon.cjs',
      addonSha256: hex,
      sourceTreeDigest: hex,
      cargo: 'test',
      crates: [],
      fileCount: 1,
      treeDigest: hex,
    }))
    process.env.MERCURY_DESKTOP_PACK_DIR = packDir
    const native = await import(path.join(SRC, 'services/desktop/nativeDriver.ts'))
    const loaded = native.resolveNativeDesktopDriver()
    out.state = loaded.state
    if (loaded.state === 'ok') {
      try {
        out.threwValue = await loaded.driver.keyboardIdleMs()
      } catch (e) {
        out.threwMsg = e instanceof Error ? e.message : String(e)
      }
      loaded.driver.addon.setMode('num')
      out.numValue = await loaded.driver.keyboardIdleMs()
    }
  `)
  check('nativeDriver.keyboardIdleMs rejects when addon throws', r.state === 'ok' && r.threwMsg === 'addon idle read failed' && r.threwValue === undefined, JSON.stringify(r))
  check('nativeDriver.keyboardIdleMs still returns finite idle ms on success', r.numValue === 42, JSON.stringify(r))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
