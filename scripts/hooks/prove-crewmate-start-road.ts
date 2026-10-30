import assert from 'node:assert/strict'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { quote, runDoor, say, sceneRoot } from './lib/runDoor.ts'

for (const background of [false, true]) {
  const paths = sceneRoot('hook-crewmate-start-')
  const events = join(paths.root, 'events.jsonl')
  try {
    const result = await runDoor(paths, {
      args: ['--mode', 'sovereign'],
      turns: [
        { kind: 'tool_use', name: 'Crewmate', id: 'start-helper', input: { description: 'quick helper', prompt: 'say done', crewmate_type: 'mercury-crew', run_in_background: background } },
        { kind: 'text', text: 'helper done' },
        { kind: 'text', text: 'parent done' },
        { kind: 'text', text: 'all done' },
      ],
      hooks: {
        'crewmate.start': [{ name: 'start', run: `cat >> ${quote(events)}; echo >> ${quote(events)}; ${say({ context: 'count the violet beans' })}` }],
        'crewmate.end': [{ name: 'end', run: `cat >> ${quote(events)}; echo >> ${quote(events)}` }],
      },
    })
    assert.equal(result.code, 0, result.stderr)
    const captured = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    assert.deepEqual(captured.map(row => row.event), ['crewmate.start', 'crewmate.end'], `background=${background}`)
    assert.equal(captured[0].prompt, 'say done')
    assert.ok(captured[0].crewmate_id)
    assert.ok(result.wire.some(request => JSON.stringify(request.body).includes('count the violet beans')))
    console.log(`PASS crewmate start/end and returned context, background=${background}`)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
}
