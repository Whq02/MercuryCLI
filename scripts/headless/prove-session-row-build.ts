import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, isSession, type Frame } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { startOverflowFixture } from '../compact/overflowFixture.ts'

const tally = makeTally('prove-session-row-build')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'session-row-build-')))
const home = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(home, cwd)
const fixture = await startOverflowFixture()
const model = 'openrouter/fixture/model'
const env = { ...childEnv(home, Number(new URL(fixture.base).port)), ...fixture.env, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }

function run(args: string[]): Promise<{ frames: Frame[]; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', model, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('close', code => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr, code }) })
    child.on('error', error => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr: String(error), code: null }) })
  })
}

try {
  console.log(`build under proof: ${DIST}`)
  const manifest = JSON.parse(readFileSync(join(dirname(DIST), 'manifest.json'), 'utf8')) as { version?: string; buildTree?: string }
  const expectedBuild = typeof manifest.buildTree === 'string' ? manifest.buildTree.slice(0, 12) : null
  tally.section('the session row names the build beside the version, as the manifest beside the bundle states it')
  fixture.script([{ text: 'The answer.' }])
  const first = await run(['Say the answer.'])
  const session = first.frames.find(isSession)
  const outcome = first.frames.find(isOutcome)
  tally.check('the run completed through the fixture', first.code === 0 && outcome?.status === 'completed', JSON.stringify({ code: first.code, outcome, stderr: first.stderr.slice(-300) }))
  tally.check('the manifest beside the bundle carries a build tree', expectedBuild !== null && expectedBuild.length === 12, JSON.stringify(manifest))
  tally.check('the session row carries version from the manifest', session?.version === manifest.version, JSON.stringify({ version: session?.version, manifest: manifest.version }))
  tally.check('the session row carries build: the first twelve hex of the manifest buildTree', typeof session?.build === 'string' && session.build === expectedBuild, JSON.stringify({ build: session?.build, expectedBuild }))
  tally.check('build is twelve lowercase hex characters', typeof session?.build === 'string' && /^[0-9a-f]{12}$/.test(session.build), JSON.stringify(session?.build))
} finally {
  await fixture.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
