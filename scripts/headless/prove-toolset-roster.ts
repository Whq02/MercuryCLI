import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, MODEL, NODE, SCRATCH_ROOT, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-toolset-roster')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'toolset-roster-')))
const names = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']
const api = await startScriptedFixture(() => [{ type: 'text', text: 'Roster received.' }])
try {
  for (const [label, flags, expected] of [
    ['lean explicit', ['--lean', '--toolset', ...names], names],
    ['full explicit', ['--toolset', 'Read', 'Write'], ['Read', 'Write']],
    ['deny wins', ['--lean', '--toolset', ...names, '--block-tools', 'Write'], names.filter(name => name !== 'Write')],
    ['lean default', ['--lean'], ['Bash', 'Read', 'Edit', 'Write']],
  ] as const) {
    const home = join(root, label, 'home')
    const cwd = join(root, label, 'project')
    seedScratchHome(home, cwd)
    api.requests.length = 0
    const env = childEnv(home, Number(new URL(api.base).port))
    delete env.MERCURY_HOME
    const got = await new Promise<{ code: number | null; stderr: string }>(resolve => {
      const child = spawn(NODE, [DIST, 'run', '--model', MODEL, '--format', 'rows', '--only-mcp', ...flags, '--', 'Name nothing.'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('close', code => { clearTimeout(timer); resolve({ code, stderr }) })
    })
    const actual = api.requests[0]?.toolNames.filter(name => !name.startsWith('mcp__')).sort()
    console.log(JSON.stringify({ label, ...got, actual }))
    tally.check(`${label}: completed with one request`, got.code === 0 && api.requests.length === 1)
    tally.check(`${label}: exact wire roster`, JSON.stringify(actual) === JSON.stringify([...expected].sort()))
  }
} finally {
  await api.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
