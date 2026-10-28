import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, MODEL, NODE, SCRATCH_ROOT, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-inline-shell-prompt')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'inline-shell-')))
const home = join(root, 'home')
const cwd = join(root, 'project')
seedScratchHome(home, cwd)
mkdirSync(join(cwd, '.mercury', 'skills', 'today'), { recursive: true })
writeFileSync(join(cwd, '.mercury', 'skills', 'today', 'SKILL.md'), '---\nname: today\ndescription: show date\n---\nToday is !`date +%F`. Reply with the date.\n')
const api = await startScriptedFixture(() => [{ type: 'text', text: 'Date received.' }])
try {
  const env = childEnv(home, Number(new URL(api.base).port))
  delete env.MERCURY_HOME
  const got = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--model', MODEL, '--mode', 'implement', '--format', 'rows', '--allowed-tools', 'Bash', '--', '/today'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
  console.log(JSON.stringify({ code: got.code, requests: api.requests.length, stdout: got.stdout, stderr: got.stderr }))
  tally.check('headless skill completes', got.code === 0)
  tally.check('one model request, after expansion', api.requests.length === 1)
  tally.check('the prompt contains the command date', api.requests.some(req => req.allTexts.some(text => /Today is \d{4}-\d{2}-\d{2}/.test(text))))
  tally.check('no unexpanded shell block reaches the model', api.requests.every(req => req.allTexts.every(text => !text.includes('!`date +%F`'))))
} finally {
  await api.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
