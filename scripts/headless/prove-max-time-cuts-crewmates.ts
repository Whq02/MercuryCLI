import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { endProcessTree } from '../../src/utils/processGroup.ts'
import { quote, runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'
import { slashed } from '../lib/platformPath.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { SHELL_PID_COMMAND, shellTreeRows, shellTreeWords } from '../lib/toolShellTree.ts'

const SLEEPER_SECONDS = 30
const pidWritten = (file: string): boolean => existsSync(file) && /^\d+\s*$/.test(readFileSync(file, 'utf8'))
let failures = 0
for (const background of [false, true]) {
  const paths = sceneRoot('max-time-crewmate-')
  const pidFile = join(paths.root, 'sleeper.pid')
  try {
    const result = await runDoor(paths, {
      args: ['--mode', 'sovereign', '--max-time', '4s'],
      hooks: {},
      timeoutMs: 40_000,
      turns: [
        { kind: 'tool_use', name: 'Crewmate', id: 'crew', input: { description: 'sleeper', prompt: 'run the sleeper', crewmate_type: 'mercury-crew', run_in_background: background } },
        { kind: 'tool_use', name: 'Bash', id: 'child-shell', input: { command: `${SHELL_PID_COMMAND} > ${quote(slashed(pidFile))}; exec sleep ${SLEEPER_SECONDS}` } },
        { kind: 'text', text: 'parent done', whenBody: 'Crewmate launched in the background' },
        { kind: 'text', text: 'child done' },
        { kind: 'text', text: 'all done' },
      ],
    })
    assert.ok(pidWritten(pidFile), 'the child shell must have started')
    assert.ok(result.rows.some(row => row.type === 'tool_call' && row.tool === 'Bash' && row.parent_call_id === 'crew'), 'the sleeper must be in the crewmate')
    assert.equal(result.code, 1, `background=${background}, wall=${result.tookMs}`)
    assert.ok(result.tookMs < SLEEPER_SECONDS * 1000 * 2 / 3, `the deadline cut the run well before the sleeper's ${SLEEPER_SECONDS} s: wall=${result.tookMs}`)
    assert.ok(result.rows.some(row => row.type === 'outcome' && row.status === 'time_limit'), JSON.stringify(result.rows.filter(row => row.type === 'outcome')))
    const sleeper = Number(readFileSync(pidFile, 'utf8'))
    let left = shellTreeRows(sleeper)
    const settle = Date.now() + 3_000
    while (left.length > 0 && Date.now() < settle) {
      await new Promise(resolve => setTimeout(resolve, 100))
      left = shellTreeRows(sleeper)
    }
    assert.equal(left.length, 0, `sleeper survived the deadline: ${shellTreeWords(left)}`)
    console.log(`PASS deadline cuts crewmate and tool, background=${background}, wall=${result.tookMs}`)
  } catch (error) {
    failures++
    console.error(String(error))
  } finally {
    if (pidWritten(pidFile)) await endProcessTree(Number(readFileSync(pidFile, 'utf8')))
    removeScratch(paths.root)
  }
}
process.exitCode = failures ? 1 : 0
