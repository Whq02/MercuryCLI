import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'entry-task-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const { composeStartPage } = await import('../../src/mneme/entryKnapsack.ts')
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const dir = join(home, 'library')
mkdirSync(dir, { recursive: true })
const now = '2026-01-01T00:00:00.000Z'
const doc = emptyDoc('harbour', 'harbour notes', now)
doc.sections.push({ heading: 'notes', entries: [
  { seq: 1, time: now, source: 'tool:Retain s:one', text: 'Release bulletins must keep the crane count private.' },
  { seq: 2, time: now, source: 'tool:Retain s:one', text: 'Caption edits preserve the supplied harbour wording.' },
  { seq: 3, time: now, source: 'tool:Retain s:one', text: 'Kernel inspections use the signed workshop checklist.' },
  { seq: 4, time: now, source: 'tool:Retain s:one', text: 'The website crew prepares the harbour release page.' },
  { seq: 5, time: now, source: 'tool:Retain s:one', text: 'The amber worktree note names the old dock.' },
] })
writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
writeFileSync(join(dir, 'pins.json'), '{"version":1,"pins":[]}')
writeFileSync(join(dir, 'current.jsonl'), JSON.stringify({ ts: now, source: 'tool:Retain s:two', text: 'Quartz tickets require the dockmaster signature.', topicHint: 'harbour' }) + '\n')
const pins = readFileSync(join(dir, 'pins.json'), 'utf8')
const state = { branch: 'amber/worktree', files: [], note: { text: 'amber worktree '.repeat(200), session: 1, at: now }, at: now }
const base = { dir, projectKey: 'harbour', state, previous: [], limit: 300, now: Date.parse(now), root: null }
try {
  for (const [prompt, id] of [['release bulletins', 'seq:1'], ['caption edits', 'seq:2'], ['kernel inspections', 'seq:3'], ['website crew', 'seq:4']] as const) {
    const page = composeStartPage({ ...base, task: { prompt } } as never)
    assert.equal(page.choice.rode[0]?.id, id, `${prompt} wins over the old note`)
  }
  const pending = composeStartPage({ ...base, task: { prompt: 'quartz tickets dockmaster' } } as never)
  assert.ok(pending.choice.rode.some(row => row.id === `pending:${now}`), 'a relevant pending row participates at entry')
  const required = composeStartPage({ ...base, limit: 1, task: { prompt: 'amber worktree', required: [{ id: 'seq:1', source: 'operator-turn-7' }] } } as never)
  assert.ok(required.text?.includes('crane count private'), 'required source-linked obligations survive outside optional packing')
  assert.equal(readFileSync(join(dir, 'pins.json'), 'utf8'), pins, 'restoration never pins')
  const missing = composeStartPage({ ...base, task: { required: [{ id: 'seq:404', source: 'operator-turn-8' }] } } as never)
  assert.match(missing.text ?? '', /seq:404.*unknown.*operator-turn-8/)
  console.log('PASS prompt precedence 4/4; pending 1/1; source-linked restoration pin-neutral')
} finally {
  rmSync(home, { recursive: true, force: true })
}
