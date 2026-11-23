#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn08-')))
const HOME = join(SCRATCH, 'home')
const WORK = join(SCRATCH, 'work')
mkdirSync(HOME, { recursive: true })
mkdirSync(WORK, { recursive: true })
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../../src'))

process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function runRow(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n${name}`)
  try {
    await fn()
  } catch (err) {
    failures++
    console.log(`  [FAIL] ${name} threw unexpectedly — ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main(): Promise<void> {
  await runRow('overrides: refuses overwrite when agent-overrides.json is unreadable or corrupt', async () => {
    const overrides = await import('../../src/crew/agents/overrides.js')
    const file = overrides.userOverridesPath()
    const valid = JSON.stringify({ version: 1, disabled: ['keep-me'], agents: { helper: { model: 'sonnet' } } }, null, 2) + '\n'
    mkdirSync(HOME, { recursive: true })

    writeFileSync(file, '{not valid json', { mode: 0o600 })
    let corruptThrew = false
    try {
      await overrides.setAgentDisabled('user', WORK, 'other', true)
    } catch {
      corruptThrew = true
    }
    check('setAgentDisabled rejects corrupt file', corruptThrew, 'make setAgentDisabled in src/crew/agents/overrides.ts throw when agent-overrides.json is corrupt, not overwrite it')
    check('corrupt file stands unchanged after setAgentDisabled', readFileSync(file, 'utf8') === '{not valid json', 'setAgentDisabled in src/crew/agents/overrides.ts must leave a corrupt agent-overrides.json as it found it')

    let corruptOverrideThrew = false
    try {
      await overrides.setAgentOverride('user', WORK, 'other', { model: 'opus' })
    } catch {
      corruptOverrideThrew = true
    }
    check('setAgentOverride rejects corrupt file', corruptOverrideThrew, 'make setAgentOverride in src/crew/agents/overrides.ts throw when agent-overrides.json is corrupt, not overwrite it')
    check('corrupt file stands unchanged after setAgentOverride', readFileSync(file, 'utf8') === '{not valid json', 'setAgentOverride in src/crew/agents/overrides.ts must leave a corrupt agent-overrides.json as it found it')

    if (POSIX_MODES) {
      writeFileSync(file, valid, { mode: 0o600 })
      chmodSync(file, 0o200)
      let eaccesDisabled = false
      let eaccesOverride = false
      try {
        try {
          await overrides.setAgentDisabled('user', WORK, 'other', true)
        } catch {
          eaccesDisabled = true
        }
        try {
          await overrides.setAgentOverride('user', WORK, 'other', { model: 'opus' })
        } catch {
          eaccesOverride = true
        }
      } finally {
        chmodSync(file, 0o600)
      }
      check('setAgentDisabled rejects unreadable file', eaccesDisabled, 'make setAgentDisabled in src/crew/agents/overrides.ts throw when the file cannot be read, not treat it as empty')
      check('setAgentOverride rejects unreadable file', eaccesOverride, 'make setAgentOverride in src/crew/agents/overrides.ts throw when the file cannot be read, not treat it as empty')
      check('unreadable file keeps existing overrides byte for byte', readFileSync(file, 'utf8') === valid, 'the overrides setters in src/crew/agents/overrides.ts must not rewrite an unreadable agent-overrides.json')
    }

    rmSync(file, { force: true })
    const created = await overrides.setAgentDisabled('user', WORK, 'other', true)
    check('absent file still writes cleanly', created.disabled.includes('other'), 'setAgentDisabled in src/crew/agents/overrides.ts must still create the file when it is absent')
  })

  await runRow('store: appendReceipt keeps history when receipts unreadable and restore reports unreadable trashDir', async () => {
    const store = await import('../../src/crew/agents/store.js')
    const codec = await import('../../src/crew/agents/codec.js')
    const receipts = join(HOME, 'agent-receipts.jsonl')
    const prior = JSON.stringify({ kind: 'save', path: '/prior', at: '2026-01-01T00:00:00Z' }) + '\n'
    const trash = join(HOME, 'agent-trash')

    if (POSIX_MODES) {
      writeFileSync(receipts, prior, { mode: 0o600 })
      chmodSync(receipts, 0o200)
      const doc = codec.decodeAgentDocument('---\nname: receipt-probe\ndescription: probe\n---\nbody\n', join(HOME, 'agents', 'receipt-probe.md'))
      try {
        await store.saveAgentDocument({ kind: 'new', scope: 'user', cwd: WORK, slug: 'receipt-probe' }, doc)
      } finally {
        chmodSync(receipts, 0o600)
      }
      check('unreadable receipts file keeps prior history intact', readFileSync(receipts, 'utf8') === prior, 'saveAgentDocument in src/crew/agents/store.ts must append the receipt without dropping the prior history when agent-receipts.jsonl cannot be read')

      mkdirSync(trash, { recursive: true })
      chmodSync(trash, 0o000)
      let errCode: string | undefined
      try {
        await store.restoreAgentFromTrash('missing-or-unreadable')
      } catch (e) {
        errCode = e instanceof store.AgentStoreError ? e.code : undefined
      } finally {
        chmodSync(trash, 0o700)
      }
      check('restoreAgentFromTrash reports io error instead of source-missing when trash dir is unreadable', errCode === 'io', `restoreAgentFromTrash in src/crew/agents/store.ts must throw an AgentStoreError with code io when the trash folder cannot be read; got ${errCode}`)
    }
  })

  await runRow('watch: keeps probing a newly created root whose first readdir fails until it becomes readable', async () => {
    if (!POSIX_MODES) return
    const watch = await import('../../src/crew/agents/watch.js')
    const proj = join(SCRATCH, 'watch-proj')
    const agentsDir = join(proj, '.mercury', 'agents')
    mkdirSync(proj, { recursive: true })
    watch.setAgentWatchTimingForTests({ rootProbeIntervalMs: 40, reloadDebounce: 20, stabilityThreshold: 20, pollInterval: 20, chokidarInterval: 50 })
    let emitted = 0
    const unsub = watch.subscribeAgentsChanged(() => { emitted++ })
    try {
      await watch.startAgentWatch(proj)
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(join(agentsDir, 'late.md'), '---\nname: late\ndescription: late\n---\nbody\n')
      chmodSync(agentsDir, 0o000)
      await new Promise(r => setTimeout(r, 120))
      chmodSync(agentsDir, 0o700)
      const deadline = Date.now() + 1200
      while (emitted === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 30))
      }
      check('agentsChanged fires once unreadable new root becomes readable', emitted > 0, `keep probing a new agents root whose first read failed until it is readable (src/crew/agents/watch.ts, startAgentWatch); emitted=${emitted}`)
    } finally {
      chmodSync(agentsDir, 0o700)
      unsub()
      await watch.stopAgentWatch()
      watch.setAgentWatchTimingForTests(null)
    }
  })

  await runRow('errors: overflowFamilyOfModel classifies as unknown and preserves provider error when routeLaw throws', () => {
    const script = `
      import { mock } from 'bun:test'
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
      process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      const routePath = ${JSON.stringify(join(SRC, 'models/roads/routeLaw.ts'))}
      const realRoute = await import(routePath)
      mock.module(routePath, () => ({
        ...realRoute,
        declaredRouteOf: () => {
          throw new Error('route-law-boom')
        },
        providerDisplayName: () => {
          throw new Error('display-name-boom')
        },
      }))
      const errors = await import(${JSON.stringify(join(SRC, 'engine/requests/apiErrorRows.ts'))})
      const { APIError } = await import(${JSON.stringify(join(SRC, 'engine/request-parts/sdkErrors.ts'))})
      const overflowMsg = errors.getAssistantMessageFromError(
        new APIError(400, { error: { message: 'prompt is too long' } }, 'prompt is too long', new Headers()),
        'gpt-5',
      )
      const authMsg = errors.getAssistantMessageFromError(
        new APIError(400, { error: { message: 'bad req' } }, 'bad req', new Headers()),
        'gpt-5',
      )
      process.stdout.write('\\n' + JSON.stringify({
        family: overflowMsg.overflowSignal?.family ?? null,
        hasOverflowMsg: overflowMsg.isApiErrorMessage === true,
        hasBadReqMsg: authMsg.isApiErrorMessage === true,
      }))
    `
    const res = spawnSync(BUN, ['-e', script], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: HOME, MERCURY_HOME: '' } })
    check('isolated errors check exited 0', res.status === 0, `the isolated script in this row failed; read its stderr (src/engine/requests/apiErrorRows.ts getAssistantMessageFromError): ${res.stderr.slice(-400)}`)
    const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { family?: string | null; hasOverflowMsg?: boolean; hasBadReqMsg?: boolean }
    check('overflowFamilyOfModel classifies as unknown on throw instead of anthropic', out.family === 'unknown', `make the overflow family fall back to unknown when routeLaw throws (src/engine/requests/apiErrorRows.ts, getAssistantMessageFromError); got ${out.family}`)
    check('provider error message still returned when routeLaw throws', out.hasOverflowMsg === true && out.hasBadReqMsg === true, 'getAssistantMessageFromError in src/engine/requests/apiErrorRows.ts must still return the provider error message when routeLaw throws')
  })

  await runRow('branchManifest: readBranchManifest throws on unreadable or corrupt manifest and returns null when absent', async () => {
    const { readBranchManifest } = await import('../../src/sessions/branches/branchManifest.js')
    const base = join(SCRATCH, 'branch-session.jsonl')
    const manifestPath = `${base}.branch-manifest.json`

    check('absent manifest returns null', readBranchManifest(base) === null, 'readBranchManifest in src/sessions/branches/branchManifest.ts must return null when there is no manifest')

    writeFileSync(manifestPath, '{corrupt', { mode: 0o600 })
    let corruptThrew = false
    try {
      readBranchManifest(base)
    } catch {
      corruptThrew = true
    }
    check('corrupt manifest throws instead of returning null', corruptThrew, 'make readBranchManifest in src/sessions/branches/branchManifest.ts throw on a corrupt manifest')

    if (POSIX_MODES) {
      writeFileSync(manifestPath, JSON.stringify({ v: 1 }), { mode: 0o600 })
      chmodSync(manifestPath, 0o200)
      let eaccesThrew = false
      try {
        readBranchManifest(base)
      } catch {
        eaccesThrew = true
      } finally {
        chmodSync(manifestPath, 0o600)
      }
      check('unreadable manifest throws instead of returning null', eaccesThrew, 'make readBranchManifest in src/sessions/branches/branchManifest.ts throw when the manifest cannot be read')
    }
  })

  await runRow('browserEmulation: reports revoke failure, re-grant failure, and inherited header clear failure', () => {
    const script = `
      import { mock } from 'bun:test'
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
      process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      const sessionPath = ${JSON.stringify(join(SRC, 'integrations/browser/browserSession.ts'))}
      const realSession = await import(sessionPath)
      const kits = new WeakMap()
      mock.module(sessionPath, () => ({
        ...realSession,
        pageKitOf: page => kits.get(page) ?? null,
        presentToFrames: () => undefined,
        driverVersion: () => 'test',
      }))
      const emu = await import(${JSON.stringify(join(SRC, 'integrations/browser/browserEmulation.ts'))})
      const makePage = (startUrl, permImpl, cdpImpl) => {
        let curUrl = startUrl
        const handlers = new Map()
        const ctx = { setPermission: permImpl }
        const page = {
          url: () => curUrl,
          setUrl: u => { curUrl = u },
          browserContext: () => ctx,
          browser: () => ctx,
          setExtraHTTPHeaders: async () => undefined,
          setViewport: async () => undefined,
          emulateNetworkConditions: async () => undefined,
          on: (ev, fn) => {
            const set = handlers.get(ev) ?? new Set()
            set.add(fn)
            handlers.set(ev, set)
          },
          once: (ev, fn) => {
            const set = handlers.get(ev) ?? new Set()
            set.add(fn)
            handlers.set(ev, set)
          },
          off: (ev, fn) => { handlers.get(ev)?.delete(fn) },
          emit: (ev, arg) => { for (const fn of [...(handlers.get(ev) ?? [])]) fn(arg) },
        }
        kits.set(page, {
          cdp: { send: cdpImpl, on: () => undefined },
          identity: null,
          languages: ['en-US'],
          timeZone: 'UTC',
          born: null,
          presented: null,
          fetchHeld: false,
        })
        return page
      }

      let permFail = null
      const page1 = makePage(
        'https://a.example/',
        async (_origin, req) => {
          if (permFail && req.state === permFail.state) throw new Error(permFail.msg)
        },
        async () => undefined,
      )
      await emu.applyEmulation(page1, { geolocation: { latitude: 1, longitude: 2 } }, {})
      permFail = { state: 'granted', msg: 'grant denied' }
      page1.setUrl('https://b.example/')
      page1.emit('framenavigated', { parentFrame: () => null })
      await new Promise(r => setTimeout(r, 20))
      const linesAfterNav = emu.emulationLines(page1)

      permFail = { state: 'prompt', msg: 'revoke denied' }
      const clearOutcome = await emu.applyEmulation(page1, { geolocation: null }, {})

      const fromPage = makePage('https://a.example/', async () => undefined, async () => undefined)
      await emu.applyEmulation(fromPage, { timezone: 'Europe/Paris' }, {})
      const toPage = makePage(
        'https://a.example/',
        async () => undefined,
        async method => {
          if (method === 'Network.setExtraHTTPHeaders') throw new Error('headers clear refused')
        },
      )
      kits.get(toPage).born = {
        identity: null,
        languages: ['en-US'],
        locale: null,
        timeZone: 'UTC',
        headers: { 'x-old': '1' },
      }
      const inherited = await emu.inheritEmulation(fromPage, toPage, true)

      process.stdout.write('\\n' + JSON.stringify({
        regrantReported: linesAfterNav.some(l => l.includes('location permission could not be granted to https://b.example (grant denied)')),
        revokeReported: clearOutcome.failures.some(f => f.includes('revoke denied')),
        headerClearReported: (inherited?.failures ?? []).some(f => f.includes('headers clear refused')),
      }))
    `
    const res = spawnSync(BUN, ['-e', script], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: HOME, MERCURY_HOME: '' } })
    check('isolated browserEmulation check exited 0', res.status === 0, `the isolated script in this row failed; read its stderr (src/integrations/browser/browserEmulation.ts): ${res.stderr.slice(-400)}`)
    const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { regrantReported?: boolean; revokeReported?: boolean; headerClearReported?: boolean }
    check('re-grant failure after navigation surfaces in emulationLines', out.regrantReported === true, 'make the emulation lines of src/integrations/browser/browserEmulation.ts report a location permission re-grant that failed after navigation')
    check('revoke failure on geolocation clear surfaces in outcome.failures', out.revokeReported === true, 'make applyEmulation in src/integrations/browser/browserEmulation.ts put a failed geolocation revoke into outcome.failures')
    check('inherited header clear failure surfaces in outcome.failures', out.headerClearReported === true, 'make inheritEmulation in src/integrations/browser/browserEmulation.ts put a failed header clear into failures')
  })

  await runRow('browserSecrets: refuses unreadable secrets file and keychain read or JSON errors instead of missing', () => {
    const script = `
      import { mock } from 'bun:test'
      import * as childProcess from 'node:child_process'
      import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
      process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      const posix = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
      const dir = mkdtempSync(join(tmpdir(), 'fn08-secrets-'))
      const file = join(dir, 'browser-secrets.json')
      let keychainMode = 'absent'
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      const realSpawn = childProcess.spawnSync
      mock.module('node:child_process', () => ({
        ...childProcess,
        spawnSync: (cmd, args, opts) => {
          if (cmd !== 'security') return realSpawn(cmd, args, opts)
          if (keychainMode === 'throw') throw new Error('keychain locked')
          if (keychainMode === 'bad-json') return { status: 0, stdout: '{bad json\\n', stderr: '' }
          return { status: 44, stdout: '', stderr: '' }
        },
      }))
      try {
        const secrets = await import(${JSON.stringify(join(SRC, 'integrations/browser/browserSecrets.ts'))})
        process.env.MERCURY_CREDENTIAL_STORE = 'file'
        const absentRes = secrets.resolveBrowserSecret('MISSING_ONE', { fileDir: dir })

        let unreadableRes = { state: 'skipped', note: '' }
        if (posix) {
          writeFileSync(file, JSON.stringify({ UNREAD: 'secret' }), { mode: 0o600 })
          chmodSync(file, 0o200)
          try {
            unreadableRes = secrets.resolveBrowserSecret('UNREAD', { fileDir: dir })
          } finally {
            chmodSync(file, 0o600)
            rmSync(file, { force: true })
          }
        }

        if (posix) Object.defineProperty(process, 'platform', { value: 'darwin' })
        process.env.MERCURY_CREDENTIAL_STORE = 'keychain'
        keychainMode = 'throw'
        const kcThrowRes = posix ? secrets.resolveBrowserSecret('KC_ERR', { fileDir: dir }) : { state: 'skipped', note: '' }
        keychainMode = 'bad-json'
        const kcBadJsonRes = posix ? secrets.resolveBrowserSecret('KC_BAD', { fileDir: dir }) : { state: 'skipped', note: '' }
        process.stdout.write('\\n' + JSON.stringify({ posix, absentRes, unreadableRes, kcThrowRes, kcBadJsonRes }))
      } finally {
        Object.defineProperty(process, 'platform', origPlatform)
        rmSync(dir, { recursive: true, force: true })
      }
    `
    const res = spawnSync(BUN, ['-e', script], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: HOME, MERCURY_HOME: '' } })
    check('isolated browserSecrets check exited 0', res.status === 0, `the isolated script in this row failed; read its stderr (src/integrations/browser/browserSecrets.ts): ${res.stderr.slice(-400)}`)
    const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as {
      posix?: boolean
      absentRes?: { state: string; note: string }
      unreadableRes?: { state: string; note: string }
      kcThrowRes?: { state: string; note: string }
      kcBadJsonRes?: { state: string; note: string }
    }
    check('absent secrets file still reports missing', out.absentRes?.state === 'missing', 'resolveBrowserSecret in src/integrations/browser/browserSecrets.ts must report missing for an absent secrets file')
    if (out.posix) {
      check('unreadable secrets file refuses instead of missing', out.unreadableRes?.state === 'refused' && out.unreadableRes.note.includes('could not be read'), `make resolveBrowserSecret in src/integrations/browser/browserSecrets.ts refuse with could not be read when the file cannot be read; got ${JSON.stringify(out.unreadableRes)}`)
      check('keychain read error refuses instead of missing', out.kcThrowRes?.state === 'refused' && out.kcThrowRes.note.includes('keychain locked'), `make resolveBrowserSecret in src/integrations/browser/browserSecrets.ts refuse with the keychain error when the read throws; got ${JSON.stringify(out.kcThrowRes)}`)
      check('keychain corrupt JSON refuses instead of missing', out.kcBadJsonRes?.state === 'refused' && out.kcBadJsonRes.note.includes('not valid JSON'), `make resolveBrowserSecret in src/integrations/browser/browserSecrets.ts refuse with not valid JSON when the keychain answers with bad JSON; got ${JSON.stringify(out.kcBadJsonRes)}`)
    }
  })

  await runRow('browserTransfers: fails closed when destination lstat fails with non-ENOENT error', () => {
    const script = `
      import { mock } from 'bun:test'
      import * as realFs from 'node:fs'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
      process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      const home = realFs.mkdtempSync(join(tmpdir(), 'fn08-transfers-'))
      realFs.mkdirSync(join(home, 'incoming'), { recursive: true })
      let scenario = 'first'
      let lstatCount = 0
      const realLstat = realFs.promises.lstat.bind(realFs.promises)
      const realRename = realFs.promises.rename.bind(realFs.promises)
      mock.module('node:fs', () => ({
        ...realFs,
        promises: {
          ...realFs.promises,
          lstat: async p => {
            if (String(p).endsWith('report.txt')) {
              lstatCount++
              if (scenario === 'first' || (scenario === 'second' && lstatCount === 2)) {
                throw Object.assign(new Error('EACCES: cannot stat destination'), { code: 'EACCES' })
              }
            }
            return realLstat(p)
          },
          rename: async (from, to) => {
            if (scenario === 'second' && String(to).endsWith('report.txt') && !String(from).includes('.part-')) {
              throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })
            }
            return realRename(from, to)
          },
        },
      }))
      try {
        const tr = await import(${JSON.stringify(join(SRC, 'integrations/browser/browserTransfers.ts'))})
        const book = tr.newTransferBook()

        realFs.writeFileSync(join(home, 'incoming', 'g1'), 'payload-1')
        const t1 = tr.beginTransfer(book, { guid: 'g1', tab: 't1', url: 'https://a.example', name: 'report.txt', type: 'text/plain', home })
        tr.moveTransfer(book, 'g1', { state: 'completed', receivedBytes: 9, totalBytes: 9 })
        await t1.done

        scenario = 'second'
        lstatCount = 0
        realFs.writeFileSync(join(home, 'incoming', 'g2'), 'payload-2')
        const t2 = tr.beginTransfer(book, { guid: 'g2', tab: 't1', url: 'https://a.example', name: 'report.txt', type: 'text/plain', home })
        tr.moveTransfer(book, 'g2', { state: 'completed', receivedBytes: 9, totalBytes: 9 })
        await t2.done

        process.stdout.write('\\n' + JSON.stringify({
          t1State: t1.state,
          t1Failure: t1.failure,
          t2State: t2.state,
          t2Failure: t2.failure,
        }))
      } finally {
        realFs.rmSync(home, { recursive: true, force: true })
      }
    `
    const res = spawnSync(BUN, ['-e', script], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: HOME, MERCURY_HOME: '' } })
    check('isolated browserTransfers check exited 0', res.status === 0, `the isolated script in this row failed; read its stderr (src/integrations/browser/browserTransfers.ts): ${res.stderr.slice(-400)}`)
    const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { t1State?: string; t1Failure?: string | null; t2State?: string; t2Failure?: string | null }
    check('direct move fails closed on non-ENOENT lstat error', out.t1State === 'failed' && String(out.t1Failure).includes('cannot stat destination'), `make the move in src/integrations/browser/browserTransfers.ts fail the transfer with the lstat error when the destination cannot be checked; got ${JSON.stringify(out)}`)
    check('EXDEV fallback move fails closed on non-ENOENT lstat error', out.t2State === 'failed' && String(out.t2Failure).includes('cannot stat destination'), `make the EXDEV fallback move in src/integrations/browser/browserTransfers.ts fail the transfer with the lstat error when the destination cannot be checked; got ${JSON.stringify(out)}`)
  })
}

try {
  await main()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
