import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, MODEL, NODE, SCRATCH_ROOT, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'
import { inputLine, parseFrame, promptRow } from '../lib/rows.ts'

const tally = makeTally('prove-skill-grant-scope')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'skill-grant-')))
const api = await startScriptedFixture(req => {
  if (req.step > 0) return [{ type: 'text', text: 'Done.' }]
  const later = req.ask.includes('after grant')
  return [{ type: 'tool_use', name: 'Bash', input: { command: `printf granted > ${later ? 'after' : 'invocation'}.txt` } }]
})
try {
  for (const trusted of [false, true]) {
    const home = join(root, String(trusted), 'home')
    const cwd = join(root, String(trusted), 'project')
    seedScratchHome(home, cwd)
    if (!trusted) {
      const config = JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8'))
      config.projects = {}
      writeFileSync(join(home, '.mercury.json'), JSON.stringify(config))
    }
    mkdirSync(join(cwd, '.mercury', 'skills', 'grant'), { recursive: true })
    writeFileSync(join(cwd, '.mercury', 'skills', 'grant', 'SKILL.md'), '---\nname: grant\ndescription: run the granted command\nallowed-tools: Bash\n---\nGRANT_BODY: run the invocation command.\n')
    const env = childEnv(home, Number(new URL(api.base).port))
    delete env.MERCURY_HOME
    const result = await new Promise<{ code: number | null; outcomes: number; listed: boolean; stderr: string }>(resolve => {
      const child = spawn(NODE, [DIST, 'run', '--model', MODEL, '--mode', 'default', '--format', 'rows', '--input', 'rows', '--only-mcp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      let pending = ''
      let stderr = ''
      let outcomes = 0
      let listed = false
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      child.stdout.on('data', chunk => {
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const row = parseFrame(line)
          if (row?.type === 'session') listed = (row.commands as string[]).includes('grant')
          if (row?.type !== 'outcome') continue
          outcomes++
          if (outcomes === 1) child.stdin.write(inputLine(promptRow('after grant: run the next command')))
          else child.stdin.end()
        }
      })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('close', code => { clearTimeout(timer); resolve({ code, outcomes, listed, stderr }) })
      child.stdin.write(inputLine(promptRow('/grant')))
    })
    const invoked = existsSync(join(cwd, 'invocation.txt'))
    const leaked = existsSync(join(cwd, 'after.txt'))
    console.log(JSON.stringify({ trusted, ...result, invoked, leaked }))
    tally.check(`${trusted ? 'trusted' : 'untrusted'}: both turns settle`, result.outcomes === 2)
    tally.check(`${trusted ? 'trusted' : 'untrusted'}: skill catalogue follows folder trust`, result.listed === trusted)
    tally.check(`${trusted ? 'trusted' : 'untrusted'}: invocation grant follows folder trust`, invoked === trusted)
    tally.check(`${trusted ? 'trusted' : 'untrusted'}: no grant survives into the next turn`, !leaked)
  }
} finally {
  await api.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
