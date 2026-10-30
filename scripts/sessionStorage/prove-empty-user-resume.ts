import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const paths = sceneRoot('empty-user-resume-')
process.env.MERCURY_CONFIG_DIR = paths.home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
try {
  const project = getProjectDir(paths.cwd)
  mkdirSync(project, { recursive: true })
  for (const content of [[{ type: 'text', text: '' }], '', [{ type: 'text', text: '' }, { type: 'text', text: 'keep these words' }]]) {
    const sessionId = crypto.randomUUID()
    const path = join(project, `${sessionId}.jsonl`)
    const userId = crypto.randomUUID()
    const entries = [
      { type: 'user', uuid: userId, parentUuid: null, isSidechain: false, sessionId, cwd: paths.cwd, version: 'proof', timestamp: new Date().toISOString(), message: { role: 'user', content } },
      { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: userId, isSidechain: false, sessionId, cwd: paths.cwd, version: 'proof', timestamp: new Date().toISOString(), message: { role: 'assistant', model: '', id: 'saved-answer', content: [{ type: 'text', text: 'saved reply' }] } },
    ]
    writeFileSync(path, entries.map(entry => encodeTranscriptLine(path, entry).line).join(''))
    const result = await runDoor(paths, { args: ['--resume', sessionId], hooks: {}, prompt: 'next question', turns: [{ kind: 'text', text: 'resumed answer' }] })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.requests, 1)
    const wire = result.wire[0]!.body as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }
    assert.ok(wire.messages.every(message => message.content.length > 0 && message.content.every(block => block.type !== 'text' || (block.text ?? '').length > 0)), JSON.stringify(wire.messages))
    assert.equal(wire.messages[0]!.role, 'user')
    assert.ok(JSON.stringify(wire.messages).includes('saved reply'))
    assert.ok(JSON.stringify(wire.messages).includes('next question'))
    if (Array.isArray(content) && content.length > 1) assert.ok(JSON.stringify(wire.messages).includes('keep these words'))
    assert.ok(result.rows.some(row => row.type === 'outcome' && row.status === 'completed'))
    console.log(`PASS resumed empty user content ${JSON.stringify(content)}`)
  }
} finally {
  rmSync(paths.root, { recursive: true, force: true })
}
