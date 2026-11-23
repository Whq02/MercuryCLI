#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.env.BUN ?? (process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun'))
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runScenario(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn17-')))
  const home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    const SRC = ${JSON.stringify(SRC)}
    const HOME = ${JSON.stringify(home)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file' },
  })
  if (res.status !== 0) throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1200)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

console.log('modelRefusal — readModelRefusals throws on unreadable directory instead of answering empty')
{
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const mod = await import(SRC + '/models/roads/anthropic/modelRefusal.ts')
    out.absentStanding = mod.standingModelRefusals().length
    out.absentForget = mod.forgetModelRefusals(HOME)
    const dir = path.join(HOME, 'model-refusals')
    fs.writeFileSync(dir, 'not-a-directory')
    try {
      mod.standingModelRefusals()
      out.standingCode = null
    } catch (e) {
      out.standingCode = e?.code ?? String(e)
    }
    try {
      mod.forgetModelRefusals(HOME)
      out.forgetCode = null
    } catch (e) {
      out.forgetCode = e?.code ?? String(e)
    }
    out.wordsReturned = mod.modelRefusalWords('claude-sonnet-4-6') ?? null
  `)
  check(
    'modelRefusal:readModelRefusals throws on non-ENOENT directory error and returns empty on ENOENT',
    r.absentStanding === 0 && r.absentForget === 0 && r.standingCode === 'ENOTDIR' && r.forgetCode === 'ENOTDIR' && r.wordsReturned === null,
    JSON.stringify(r),
  )
}

console.log('prefixRecordStore — sweepPrefixRecords fails closed when getSessionId throws')
{
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const statePath = SRC + '/boot/process-state/processState.ts'
    const realState = await import(statePath)
    mock.module(statePath, () => ({
      ...realState,
      getSessionId: () => { throw new Error('session-id-boom') },
    }))
    const sessionsDir = path.join(HOME, 'sessions', 'sess-1')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const ledger = path.join(sessionsDir, 'prefix-ledger.json')
    fs.writeFileSync(ledger, '{}')
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    fs.utimesSync(ledger, oldTime, oldTime)
    const store = await import(SRC + '/models/roads/anthropic/prefixRecordStore.ts')
    try {
      await store.sweepPrefixRecords({ home: HOME })
      out.threw = null
    } catch (e) {
      out.threw = e instanceof Error ? e.message : String(e)
    }
    out.stillExists = fs.existsSync(ledger)
  `)
  check(
    'prefixRecordStore:sweepPrefixRecords aborts without deleting when getSessionId throws',
    r.threw === 'session-id-boom' && r.stillExists === true,
    JSON.stringify(r),
  )
}

console.log('faultUsageEstimate — non-JSON-serializable requests still estimate input tokens')
{
  const r = runScenario(`
    const mod = await import(SRC + '/models/roads/faultUsageEstimate.ts')
    const circular = { model: 'm', prompt: 'x'.repeat(400) }
    circular.self = circular
    const cUsage = mod.estimateFaultedRequestUsage({ lane: 'test', model: 'm', request: circular, minted: [], faultCode: 'cut' })
    const big = { model: 'm', prompt: 'y'.repeat(400), count: 42n }
    const bUsage = mod.estimateFaultedRequestUsage({ lane: 'test', model: 'm', request: big, minted: [], faultCode: 'cut' })
    out.circularInput = cUsage.input_tokens
    out.bigintInput = bUsage.input_tokens
  `)
  check(
    'faultUsageEstimate:requestCharsOf measures circular and BigInt requests instead of returning 0',
    typeof r.circularInput === 'number' && r.circularInput > 0 && typeof r.bigintInput === 'number' && r.bigintInput > 0,
    JSON.stringify(r),
  )
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

console.log('antigravityClientContract — unreadable contract file is not overwritten and failed write answers learned:false')
if (POSIX_MODES) {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const mod = await import(SRC + '/models/roads/gemini/antigravityClientContract.ts')
    const file = mod.antigravityClientContractPath()
    const original = JSON.stringify({ version: 1, learned: { version: '9.9.9', learnedAtMs: 1, from: 'http://127.0.0.1' } }) + '\\n'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, original, { mode: 0o600 })
    fs.chmodSync(file, 0o200)
    try {
      out.readerEmpty = Object.keys(mod.readAntigravityClientRecord()).length === 0
      const peek = await mod.peekAntigravityClient({
        force: true,
        env: { ...process.env, MERCURY_ANTIGRAVITY_MANIFEST_BASE: 'http://127.0.0.1:9' },
        fetchImpl: async () => new Response('version: 99.0.0\\n', { status: 200 }),
      })
      out.peekLearned = peek.kind === 'read' ? peek.learned : null
    } finally {
      fs.chmodSync(file, 0o600)
    }
    out.sameBytes = fs.readFileSync(file, 'utf8') === original
  `)
  check(
    'antigravityClientContract:peekAntigravityClient keeps unreadable contract file intact and answers learned:false',
    r.readerEmpty === true && r.sameBytes === true && r.peekLearned === false,
    JSON.stringify(r),
  )

  const w = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const mod = await import(SRC + '/models/roads/gemini/antigravityClientContract.ts')
    const file = mod.antigravityClientContractPath()
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o500)
    try {
      const peek = await mod.peekAntigravityClient({
        force: true,
        env: { ...process.env, MERCURY_ANTIGRAVITY_MANIFEST_BASE: 'http://127.0.0.1:9' },
        fetchImpl: async () => new Response('version: 99.0.0\\n', { status: 200 }),
      })
      out.peekKind = peek.kind
      out.peekLearned = peek.kind === 'read' ? peek.learned : null
    } finally {
      fs.chmodSync(dir, 0o700)
    }
  `)
  check(
    'antigravityClientContract:peekAntigravityClient answers learned:false when write fails',
    w.peekKind === 'read' && w.peekLearned === false,
    JSON.stringify(w),
  )
}
{
  const t = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const mod = await import(SRC + '/models/roads/gemini/antigravityClientContract.ts')
    const file = mod.antigravityClientContractPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'torn-not-json {', { mode: 0o600 })
    const peek = await mod.peekAntigravityClient({
      force: true,
      env: { ...process.env, MERCURY_ANTIGRAVITY_MANIFEST_BASE: 'http://127.0.0.1:9' },
      fetchImpl: async () => new Response('version: 99.0.0\\n', { status: 200 }),
    })
    out.peekLearned = peek.kind === 'read' ? peek.learned : null
    out.healedVersion = mod.readAntigravityClientRecord().learned?.version ?? null
  `)
  check(
    'antigravityClientContract:peekAntigravityClient replaces a torn contract file with the next record',
    t.peekLearned === true && t.healedVersion === '99.0.0',
    JSON.stringify(t),
  )
}

console.log('deferralProbe — recordGatewayProbe does not overwrite an unreadable probe store')
if (POSIX_MODES) {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const mod = await import(SRC + '/models/roads/deferralProbe.ts')
    const file = path.join(HOME, 'tool-deferral-probe.json')
    const original = JSON.stringify({ version: 1, hosts: { 'a.example': { verdict: 'block', evidence: 'http 200', status: 200, probedAt: '2026-11-20T00:00:00.000Z' } } }, null, 2)
    fs.writeFileSync(file, original, { mode: 0o600 })
    fs.chmodSync(file, 0o200)
    try {
      out.readerAbsent = mod.readGatewayProbeRecord('a.example') === undefined
      mod.recordGatewayProbe('b.example', { verdict: 'text', evidence: 'http 400', status: 400, probedAt: '2026-11-20T00:00:00.000Z' })
    } finally {
      fs.chmodSync(file, 0o600)
    }
    out.sameBytes = fs.readFileSync(file, 'utf8') === original
  `)
  check(
    'deferralProbe:recordGatewayProbe keeps unreadable store file byte-identical while reader stays non-throwing',
    r.readerAbsent === true && r.sameBytes === true,
    JSON.stringify(r),
  )
}
{
  const t = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const mod = await import(SRC + '/models/roads/deferralProbe.ts')
    const file = path.join(HOME, 'tool-deferral-probe.json')
    fs.writeFileSync(file, 'torn-not-json {', { mode: 0o600 })
    mod.recordGatewayProbe('b.example', { verdict: 'text', evidence: 'http 400', status: 400, probedAt: '2026-11-20T00:00:00.000Z' })
    mod._resetGatewayProbeStoreForTesting()
    out.healedVerdict = mod.readGatewayProbeRecord('b.example')?.verdict ?? null
  `)
  check(
    'deferralProbe:recordGatewayProbe replaces a torn probe store file with the next record',
    t.healedVerdict === 'text',
    JSON.stringify(t),
  )
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
