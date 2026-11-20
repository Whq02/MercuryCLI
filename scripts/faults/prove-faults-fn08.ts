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
    const overrides = await import('../../src/services/agents/overrides.js')
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
    check('setAgentDisabled rejects corrupt file', corruptThrew)
    check('corrupt file stands unchanged after setAgentDisabled', readFileSync(file, 'utf8') === '{not valid json')

    let corruptOverrideThrew = false
    try {
      await overrides.setAgentOverride('user', WORK, 'other', { model: 'opus' })
    } catch {
      corruptOverrideThrew = true
    }
    check('setAgentOverride rejects corrupt file', corruptOverrideThrew)
    check('corrupt file stands unchanged after setAgentOverride', readFileSync(file, 'utf8') === '{not valid json')

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
      check('setAgentDisabled rejects unreadable file', eaccesDisabled)
      check('setAgentOverride rejects unreadable file', eaccesOverride)
      check('unreadable file keeps existing overrides byte for byte', readFileSync(file, 'utf8') === valid)
    }

    rmSync(file, { force: true })
    const created = await overrides.setAgentDisabled('user', WORK, 'other', true)
    check('absent file still writes cleanly', created.disabled.includes('other'))
  })

  await runRow('store: appendReceipt keeps history when receipts unreadable and restore reports unreadable trashDir', async () => {
    const store = await import('../../src/services/agents/store.js')
    const codec = await import('../../src/services/agents/codec.js')
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
      check('unreadable receipts file keeps prior history intact', readFileSync(receipts, 'utf8') === prior)

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
      check('restoreAgentFromTrash reports io error instead of source-missing when trash dir is unreadable', errCode === 'io', `got ${errCode}`)
    }
  })

  await runRow('watch: keeps probing a newly created root whose first readdir fails until it becomes readable', async () => {
    if (!POSIX_MODES) return
    const watch = await import('../../src/services/agents/watch.js')
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
      check('agentsChanged fires once unreadable new root becomes readable', emitted > 0, `emitted=${emitted}`)
    } finally {
      chmodSync(agentsDir, 0o700)
      unsub()
      await watch.stopAgentWatch()
      watch.setAgentWatchTimingForTests(null)
    }
  })

  await runRow('errors: route lookup and provider name bugs propagate instead of falling back to anthropic', () => {
    const script = `
      import { mock } from 'bun:test'
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
      process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      const routePath = ${JSON.stringify(join(SRC, 'services/providers/routeLaw.ts'))}
      const realRoute = await import(routePath)
      let mode = 'declared'
      mock.module(routePath, () => ({
        ...realRoute,
        declaredRouteOf: () => {
          if (mode === 'declared') throw new Error('route-law-boom')
          return 'openai'
        },
        providerDisplayName: () => {
          throw new Error('display-name-boom')
        },
      }))
      const errors = await import(${JSON.stringify(join(SRC, 'services/api/errors.ts'))})
      const { APIError } = await import(${JSON.stringify(join(SRC, 'services/api/sdkErrors.ts'))})
      const out = { routeThrew: false, overflowThrew: false, displayThrew: false }
      try {
        errors.getAssistantMessageFromError(new APIError(401, { error: { message: 'bad key' } }, 'bad key', new Headers()), 'gpt-5')
      } catch (e) {
        out.routeThrew = String(e).includes('route-law-boom')
      }
      try {
        errors.getAssistantMessageFromError(new APIError(400, { error: { message: 'prompt is too long' } }, 'prompt is too long', new Headers()), 'gpt-5')
      } catch (e) {
        out.overflowThrew = String(e).includes('route-law-boom')
      }
      mode = 'display'
      try {
        errors.getAssistantMessageFromError(new APIError(400, { error: { message: 'bad req' } }, 'bad req', new Headers()), 'gpt-5')
      } catch (e) {
        out.displayThrew = String(e).includes('display-name-boom')
      }
      process.stdout.write('\\n' + JSON.stringify(out))
    `
    const res = spawnSync(BUN, ['-e', script], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: HOME, MERCURY_HOME: '' } })
    check('isolated errors check exited 0', res.status === 0, res.stderr.slice(-400))
    const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { routeThrew?: boolean; overflowThrew?: boolean; displayThrew?: boolean }
    check('routeOfModel bug propagates', out.routeThrew === true)
    check('overflowFamilyOfModel bug propagates', out.overflowThrew === true)
    check('providerNameOfModel bug propagates', out.displayThrew === true)
  })
}

try {
  await main()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
