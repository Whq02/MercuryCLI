import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertCompleted, connect, MercuryError, MercuryOutcomeError, MercuryRefusal, prewarm } from '../../sdk/src/index.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { PYTHON } from './runtime.ts'

const root = resolve(import.meta.dir, '../..')
const mercury = ['node', join(root, 'dist/mercury.mjs')]
const guard = setTimeout(() => { console.error('FAIL headless SDK errors timed out'); process.exit(1) }, 90000)
try {
  for (const language of ['ts', 'py']) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-headless-errors-')))
    const cwd = join(home, 'project')
    mkdirSync(cwd)
    seedFirstRun(home, [cwd])
    const target = join(cwd, 'not-written.txt')
    const api = await startFixtureApi([{ kind: 'tool_use', name: 'Write', input: { file_path: target, content: 'not permitted' } }, { kind: 'text', text: 'The write needs permission.' }])
    const env = { HOME: home, PATH: process.env.PATH!, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url }
    try {
      if (language === 'ts') {
        const warm = await prewarm({ mercury, cwd, env, timeoutMs: 30000 })
        const missing = randomUUID()
        try {
          await assert.rejects(warm.claim({ session_id: missing, resume: true }), error => error instanceof MercuryRefusal && error.code === -32010 && (error.data as { kind: string }).kind === 'claim' && error.message.includes(missing) && error.message.includes('no conversation found'))
          assert.equal(warm.sessionId, null)
        } finally { await warm.close() }
        await assert.rejects(connect({ mercury, cwd, env, resume: missing, timeoutMs: 30000 }), error => error instanceof MercuryError && /no .*found|not found/i.test(error.message))
        const session = await connect({ mercury, cwd, env, mode: 'dontAsk', ephemeral: true, timeoutMs: 30000 })
        try {
          const outcome = await session.prompt('Write not-written.txt', { timeoutMs: 30000 })
          assert.equal(outcome.status, 'blocked')
          assert(outcome.denials.length > 0)
          assert.throws(() => assertCompleted(outcome), error => error instanceof MercuryOutcomeError && error.outcome === outcome && error.errorClass === 'blocked' && error.detail.length > 0 && error.message.includes('Write') && /allowed-tools|mode|host/.test(error.message))
        } finally { await session.close() }
      } else {
        const child = spawn(PYTHON, [join(root, 'scripts/sdk/python-headless-errors.py'), JSON.stringify(mercury), cwd], { cwd, env: { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, stdio: 'inherit' })
        assert.equal(await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }), 0)
      }
      assert.equal(existsSync(target), false)
      console.log(`PASS ${language}: absent resumed session stays refused; an unanswered permission ask is catchable and performs no write`)
    } finally { await api.close(); rmSync(home, { recursive: true, force: true }) }
  }
} finally { clearTimeout(guard) }
