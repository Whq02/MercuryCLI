import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { quote, runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
let failures = 0
for (const background of [false, true]) {
  const paths = sceneRoot('max-time-crewmate-')
  const pidFile = join(paths.root, 'sleeper.pid')
  try {
    const result = await runDoor(paths, {
      args: ['--mode', 'sovereign', '--max-time', '4s'],
      hooks: {},
      timeoutMs: 12_000,
      turns: [
        { kind: 'tool_use', name: 'Crewmate', id: 'crew', input: { description: 'sleeper', prompt: 'run the sleeper', crewmate_type: 'mercury-crew', run_in_background: background } },
        { kind: 'tool_use', name: 'Bash', id: 'child-shell', input: { command: `echo $$ > ${quote(pidFile)}; exec sleep 30` } },
        { kind: 'text', text: 'parent done', whenBody: 'Crewmate launched in the background' },
        { kind: 'text', text: 'child done' },
        { kind: 'text', text: 'all done' },
      ],
    })
    assert.ok(existsSync(pidFile), 'the child shell must have started')
    assert.ok(result.rows.some(row => row.type === 'tool_call' && row.tool === 'Bash' && row.parent_call_id === 'crew'), 'the sleeper must be in the crewmate')
    assert.equal(result.code, 1, `background=${background}, wall=${result.tookMs}`)
    assert.ok(result.tookMs < 9_000, `wall=${result.tookMs}`)
    assert.ok(result.rows.some(row => row.type === 'outcome' && row.status === 'time_limit'), JSON.stringify(result.rows.filter(row => row.type === 'outcome')))
    assert.ok(!alive(Number(readFileSync(pidFile, 'utf8'))), 'sleeper survived the deadline')
    console.log(`PASS deadline cuts crewmate and tool, background=${background}, wall=${result.tookMs}`)
  } catch (error) {
    failures++
    console.error(String(error))
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    }
    rmSync(paths.root, { recursive: true, force: true })
  }
}
process.exitCode = failures ? 1 : 0
