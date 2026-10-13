import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'
import { handoffTurn } from '../lib/fixtureApi.ts'
import { emptyDoc } from '../../src/mneme/mnemeTopicDocs.ts'
import { writeDoc } from '../../src/mneme/mnemeLibrary.ts'
import { readUsage } from '../../src/mneme/mnemeUsage.ts'

const paths = sceneRoot('citation-turn-')
const library = join(paths.home, 'memory', 'library')
try {
  const old = new Date(Date.now() - 120 * 86400000).toISOString()
  const doc = emptyDoc('checksum', 'backup checksums', old)
  doc.sections = [{ heading: 'notes', entries: [{ seq: 1, text: 'Every backup has a checksum.', time: old, source: 'proof' }] }]
  writeDoc(doc, library)
  const result = await runDoor(paths, {
    prompt: 'Answer briefly.',
    turns: [{ kind: 'text', text: 'Every backup has a checksum [seq 1].' }, handoffTurn()],
    hooks: {},
    beforeRun: ({ home }) => {
      const path = join(home, 'settings.json')
      const settings = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path, JSON.stringify({ ...settings, memory: { directory: join(home, 'memory'), journal: false } }))
    },
  })
  assert.equal(result.code, 0, result.stderr)
  assert(result.rows.some(row => JSON.stringify(row).includes('[seq 1]')))
  assert(Date.parse(readUsage(library)['1']?.last ?? '') > Date.parse(old))
  assert.equal(readUsage(library)['1']?.count, 0)
  console.log('PASS a real assistant answer confirms its citation without counting a memory open')
} finally {
  rmSync(paths.root, { recursive: true, force: true })
}
