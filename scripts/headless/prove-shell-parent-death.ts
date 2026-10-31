import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { endProcessTree } from '../../src/utils/processGroup.ts'
import { quote, runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { slashed } from '../lib/platformPath.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { SHELL_PID_COMMAND, shellTreeRows, shellTreeWords } from '../lib/toolShellTree.ts'

const REAP_BUDGET_MS = process.platform === 'win32' ? 12_000 : 4000
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const pidWritten = (file: string): boolean => existsSync(file) && /^\d+\s*$/.test(readFileSync(file, 'utf8'))
let failures = 0
for (const mode of ['plain', 'foreground', 'background'] as const) {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const paths = sceneRoot('shell-parent-death-')
    const pidFile = join(paths.root, 'sleeper.pid')
    let pid = 0
    try {
      const shell: ScriptedTurn = { kind: 'tool_use', name: 'Bash', id: 'sleeper', input: { command: `${SHELL_PID_COMMAND} > ${quote(slashed(pidFile))}; exec sleep 30` } }
      const turns: ScriptedTurn[] = mode === 'plain' ? [shell] : [
        { kind: 'tool_use', name: 'Crewmate', id: 'crew', input: { description: 'sleeper', prompt: 'run the sleeper', crewmate_type: 'mercury-crew', run_in_background: mode === 'background' } },
        shell,
        { kind: 'text', text: 'parent done', whenBody: 'Crewmate launched in the background' },
      ]
      const result = await runDoor(paths, { hooks: {}, args: ['--mode', 'sovereign'], turns, signalWhen: { ready: () => pidWritten(pidFile), signal }, timeoutMs: 45_000 })
      assert.ok(pidWritten(pidFile), existsSync(pidFile)
        ? `the shell wrote no pid: ${JSON.stringify(readFileSync(pidFile, 'utf8'))} (run exit ${result.code} after ${result.tookMs} ms)`
        : `shell did not start (run exit ${result.code} after ${result.tookMs} ms)`)
      pid = Number(readFileSync(pidFile, 'utf8'))
      const until = Date.now() + REAP_BUDGET_MS
      let rows = shellTreeRows(pid)
      while (rows.length > 0 && Date.now() < until) {
        await sleep(100)
        rows = shellTreeRows(pid)
      }
      assert.equal(rows.length, 0, `${mode} ${signal}: the shell's tree survived parent exit ${result.code} by ${REAP_BUDGET_MS} ms: ${shellTreeWords(rows)}`)
      console.log(`PASS ${mode} shell reaped after parent ${signal}`)
    } catch (error) {
      failures++
      console.error(String(error))
    } finally {
      if (pid > 1) await endProcessTree(pid)
      removeScratch(paths.root)
    }
  }
}
process.exitCode = failures ? 1 : 0
