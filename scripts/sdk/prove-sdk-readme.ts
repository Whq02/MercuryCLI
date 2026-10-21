import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUN, PYTHON } from './runtime.ts'
import { run } from '../../sdk/src/index.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const mercury = ['node', join(root, 'dist/mercury.mjs')]
const ANSWER = 'The README example answered.'
const guard = setTimeout(() => { console.error('FAIL README examples timed out'); process.exit(1) }, 300000)
const failures: string[] = []
const blocksOf = (path: string) => [...readFileSync(path, 'utf8').matchAll(/```(ts|python)\n([\s\S]*?)```/g)].map(m => ({ lang: m[1]!, code: m[2]! }))
function execute(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (s: string) => { stdout += s })
    child.stderr.setEncoding('utf8').on('data', (s: string) => { stderr += s })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}
async function context(turns: ScriptedTurn[]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-readme-')))
  const cwd = join(home, 'project'); mkdirSync(cwd)
  seedFirstRun(home, [cwd])
  const api = await startFixtureApi(turns)
  const env = { HOME: home, PATH: process.env.PATH!, TMPDIR: tmpdir(), BROWSER: '/usr/bin/true', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url }
  return { home, cwd, api, env, close: async () => { await api.close(); rmSync(home, { recursive: true, force: true }) } }
}
const consumer = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-readme-types-')))
{
  const built = await execute('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'sdk/tsconfig.json')], root, process.env)
  assert.equal(built.status, 0, built.stdout + built.stderr)
  mkdirSync(join(consumer, 'node_modules'))
  cpSync(join(root, 'sdk'), join(consumer, 'node_modules/mercury-cli-sdk'), { recursive: true, filter: p => !p.includes('/node_modules/') && !p.includes('/src/') })
  symlinkSync(join(root, 'node_modules/@types'), join(consumer, 'node_modules/@types'), 'junction')
  symlinkSync(join(root, 'node_modules/undici-types'), join(consumer, 'node_modules/undici-types'), 'junction')
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true }, files: ['example.ts'] }))
}
const recording = await context([{ kind: 'text', text: ANSWER }])
let recordedRows: unknown[]
try {
  const task = run({ mercury, cwd: recording.cwd, env: recording.env, prompt: 'record rows for the testing example', ephemeral: true })
  assert.equal((await task.outcome).answer, ANSWER)
  recordedRows = task.rows
} finally { await recording.close() }
try {
  for (const [dir, lang] of [['sdk', 'ts'], ['sdk-py', 'python']] as const) {
    const blocks = blocksOf(join(root, dir, 'README.md')).filter(block => block.lang === lang)
    assert(blocks.length >= 4, `${dir}/README.md carries ${blocks.length} ${lang} blocks`)
    for (const [index, block] of blocks.entries()) {
      const usesTool = /defineTool|define_tool/.test(block.code)
      const c = await context(usesTool ? [{ kind: 'tool_use', name: 'mcp__sdk-tools__greeting', input: {} }, { kind: 'text', text: ANSWER }] : [{ kind: 'text', text: ANSWER }, { kind: 'text', text: ANSWER }, { kind: 'text', text: ANSWER }])
      const label = `${dir}/README.md ${lang} block ${index + 1}: ${block.code.split('\n').find(line => /^(const|async def|with|result|from|import)/.test(line))?.slice(0, 60)}`
      try {
        const defaults = { mercury, cwd: c.cwd, env: c.env, ephemeral: true }
        let code = block.code
        let result: Awaited<ReturnType<typeof execute>>
        if (lang === 'ts') {
          writeFileSync(join(consumer, 'example.ts'), /recordedRows/.test(block.code) ? `declare const recordedRows: Record<string, unknown>[]\n${block.code}` : block.code)
          const typed = await execute('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer, process.env)
          assert.equal(typed.status, 0, `the block does not typecheck against the built declarations:\n${typed.stdout}${typed.stderr}`)
          writeFileSync(join(c.home, 'shim.ts'), `export * from ${JSON.stringify(join(root, 'sdk/src/index.ts'))}
import { run as realRun, connect as realConnect } from ${JSON.stringify(join(root, 'sdk/src/index.ts'))}
const defaults = ${JSON.stringify(defaults)}
export const run = (options: Record<string, unknown>) => realRun({ ...defaults, ...options } as never)
export const connect = (options: Record<string, unknown> = {}) => realConnect({ ...defaults, ...options } as never)
`)
          code = code.replace(/'mercury-cli-sdk\/testing'/g, JSON.stringify(join(root, 'sdk/src/testing.ts'))).replace(/'mercury-cli-sdk'/g, "'./shim.ts'")
          if (/recordedRows/.test(code)) code = `const recordedRows = ${JSON.stringify(recordedRows)}\n${code}`
          writeFileSync(join(c.home, 'example.ts'), code)
          result = await execute(BUN, [join(c.home, 'example.ts')], c.cwd, { ...process.env, ...c.env })
        } else {
          if (/async def review\(\)/.test(code)) code += '\nasyncio.run(review())\n'
          if (/async def test\(recorded_rows\)/.test(code)) code += `\nimport json\nasyncio.run(test(json.loads(${JSON.stringify(JSON.stringify(recordedRows))})))\n`
          if (!/^import asyncio/m.test(code)) code = `import asyncio\n${code}`
          writeFileSync(join(c.home, 'example.py'), code)
          writeFileSync(join(c.home, 'wrapper.py'), `import functools, json, runpy, sys
import mercury_cli_sdk
defaults = json.loads(${JSON.stringify(JSON.stringify(defaults))})
for name in ('run', 'connect', 'run_sync', 'connect_sync'):
    original = getattr(mercury_cli_sdk, name)
    setattr(mercury_cli_sdk, name, functools.wraps(original)(lambda *args, _original=original, **kwargs: _original(*args, **{**defaults, **kwargs})))
runpy.run_path(sys.argv[1], run_name='__main__')
`)
          result = await execute(PYTHON, [join(c.home, 'wrapper.py'), join(c.home, 'example.py')], c.cwd, { ...process.env, ...c.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') })
        }
        const out = `${result.stdout}${result.stderr}`
        assert.equal(result.status, 0, out)
        if (/answer/.test(block.code) && !/fixtureOutcomeRow|fixture_outcome_row/.test(block.code)) assert(result.stdout.includes(ANSWER), out)
        if (usesTool) assert(c.api.requests.some(request => request.raw.includes('Hello') && request.raw.includes('tool_result')), 'the inline tool was never called by the example agent')
        console.log(`PASS ${label}`)
      } catch (error) { failures.push(label); console.error(`FAIL ${label}\n${error}`) } finally { await c.close() }
    }
  }
} finally { clearTimeout(guard); rmSync(consumer, { recursive: true, force: true }) }
assert.deepEqual(failures, [])
console.log('PASS every ts and python block of both READMEs typechecks (ts) and runs as written against the real CLI')
