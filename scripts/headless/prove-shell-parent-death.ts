import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { endProcessTree } from '../../src/utils/processGroup.ts'
import { quote, runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
let failures = 0
for (const mode of ['plain', 'foreground', 'background'] as const) {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const paths = sceneRoot('shell-parent-death-')
    const pidFile = join(paths.root, 'sleeper.pid')
    try {
      const shell: ScriptedTurn = { kind: 'tool_use', name: 'Bash', id: 'sleeper', input: { command: `echo $$ > ${quote(pidFile)}; exec sleep 30` } }
      const turns: ScriptedTurn[] = mode === 'plain' ? [shell] : [
        { kind: 'tool_use', name: 'Crewmate', id: 'crew', input: { description: 'sleeper', prompt: 'run the sleeper', crewmate_type: 'mercury-crew', run_in_background: mode === 'background' } },
        shell,
        { kind: 'text', text: 'parent done', whenBody: 'Crewmate launched in the background' },
      ]
      const result = await runDoor(paths, { hooks: {}, args: ['--mode', 'sovereign'], turns, signalAfterMs: { ms: 2500, signal }, timeoutMs: 15_000 })
      assert.ok(existsSync(pidFile), 'shell did not start')
      const pid = Number(readFileSync(pidFile, 'utf8'))
      const until = Date.now() + 4000
      while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(!alive(pid), `${mode} ${signal}: shell ${pid} survived parent exit ${result.code}`)
      console.log(`PASS ${mode} shell reaped after parent ${signal}`)
    } catch (error) {
      failures++
      console.error(String(error))
    } finally {
      if (existsSync(pidFile)) await endProcessTree(Number(readFileSync(pidFile, 'utf8')))
      rmSync(paths.root, { recursive: true, force: true })
    }
  }
}
process.exitCode = failures ? 1 : 0
