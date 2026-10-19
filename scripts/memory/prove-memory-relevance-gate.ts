import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'memory-gate-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_EMBED_ENGINE = 'off'
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { lookupFacts, automaticMemoryCandidates } = await import('../../src/mneme/mnemeLookup.ts')
const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const now = new Date().toISOString()
const doc = emptyDoc('harbour', 'harbour', now)
doc.sections.push({ heading: 'notes', entries: Array.from({ length: 26 }, (_, i) => ({ seq: i + 1, time: now, source: 'tool:Retain s:test', text: `The release update ${i} used the ordinary blue dock.` })) })
doc.sections[0]!.entries.push(
  { seq: 27, time: now, source: 'tool:Retain s:test', text: 'Release notes must keep the private harbour key out of public copy.' },
  { seq: 28, time: now, source: 'tool:Retain s:test', text: 'Quartz engine maintenance always preserves the signed cobalt receipt.' },
  { seq: 29, time: now, source: 'tool:Retain s:test', text: 'The owner keeps the private harbour key in the cobalt vault beside the signed ledger.' },
  { seq: 30, time: now, source: 'tool:Retain s:test', text: 'Captions and subtitles for the harbour film never use the word utilise; the writing stays plain.' },
  { seq: 31, time: now, source: 'tool:Retain s:test', text: 'After 1.0.0-beta.32 ships: a showcase film about the marble pier, then the owner boosts the post.' },
  { seq: 32, time: now, source: 'tool:Retain s:test', text: 'The 1.0.0-beta.36 marble pier page is published after the tag.' },
)
writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
try {
  assert.equal(lookupFacts('ordinary release update', { dir }).length, 0, 'a low-information query does not walk the library')
  const exact = lookupFacts('quartz engine cobalt receipt', { dir })
  assert.ok(exact.some(row => row.id === 'seq:28'))
  assert.equal(lookupFacts('quartz engine cobalt receipt', { dir, exclude: new Set(exact.map(row => row.id)) }).length, 0, 'exclusions do not backfill lower ranks')
  const triggered = automaticMemoryCandidates('please review the harbour pages and tell me what changed', { dir, files: ['docs/releases/notes.md'], limit: Infinity })
  assert.ok(triggered.some(row => row.id === 'seq:27' && row.admission === 'constraint' && row.text.includes('private harbour key out of public copy')), 'the release-notes rule is admitted as a constraint when a release-notes path is in hand')
  assert.ok(triggered.some(row => row.id === 'seq:29' && row.admission === 'companion'), 'the rule brings its rare-stem companion along')
  assert.ok(!triggered.some(row => row.id === 'seq:31'), 'the old-cycle plan is not admitted by a file event')
  const named = automaticMemoryCandidates('tighten the wording in docs/releases/notes.md', { dir, limit: Infinity })
  assert.ok(named.some(row => row.id === 'seq:27' && row.admission === 'constraint'), 'a prompt naming a release-notes path admits the rule too')
  doc.sections[0]!.entries.push(
    { seq: 33, time: now, source: 'tool:Retain s:test', text: 'Release notes list Added, Changed and Fixed; never a Removed section.' },
    { seq: 34, time: now, source: 'tool:Retain s:test', text: 'Release notes list the user-facing facts. Never name the inherited estate.' },
    { seq: 35, time: now, source: 'tool:Retain s:test', text: 'Never edit packages/core/schema.sql without a migration file beside it.' },
    { seq: 36, time: now, source: 'tool:Retain s:test', text: 'The ceilings in config/limits.yaml are the owner\'s; never change them without his word.' },
  )
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  const drafting = automaticMemoryCandidates('draft the release notes for the harbour release', { dir, limit: Infinity }).map(row => row.id)
  assert.ok(drafting.includes('seq:33'), 'a rule whose trigger term and rule word sit either side of a semicolon is still one sentence to the trigger')
  assert.notEqual(automaticMemoryCandidates('write the changelog for the harbour release', { dir, limit: Infinity }).find(row => row.id === 'seq:34')?.admission, 'constraint', 'a rule word only in the sentence after the trigger term is not an exact trigger (sentences are whole, not merged)')
  doc.sections[0]!.entries.push({ seq: 37, time: now, source: 'operator', text: 'retired: operator marked no longer current (was: Release notes must keep the private harbour key out of public copy.)', supersedes: '27' } as never)
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  assert.ok(!automaticMemoryCandidates('draft the release notes for the harbour release', { dir, limit: Infinity }).some(row => row.id === 'seq:37'), 'a retirement record (a tombstone) is never surfaced automatically')
  const schema = automaticMemoryCandidates('tidy the schema', { dir, files: [join(home, 'repo/packages/core/schema.sql')], limit: Infinity })
  assert.ok(schema.some(row => row.id === 'seq:35' && row.admission === 'constraint'), 'a rule citing a path under a root outside the seven named ones triggers when that file is edited')
  doc.sections[0]!.entries.push(
    { seq: 38, time: now, source: 'tool:Retain s:test', text: 'beta.32 website state at 2026-10-12 00:4x: main at 6bf18b0, pushed, NOT deployed; only src/panels/Licence.tsx and src/data/install.ts changed, never the queue page.' },
    { seq: 39, time: now, source: 'tool:Retain s:test', text: 'Session note (licence lane, 2026-10-12): src/panels/Licence.tsx must keep the signed badge; the lane landed on main.' },
    { seq: 40, time: now, source: 'tool:Retain s:test', text: 'Never edit src/panels/Licence.tsx without re-running the licence census.' },
    { seq: 41, time: now, source: 'tool:Retain s:test', text: 'Licence lane (1.0.0-beta.35), 2026-10-14 09:1x: the owner flipped the review seat into the fix seat; src/panels/Licence.tsx must keep the signed badge; DONE at dc5853f07f.' },
  )
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  const verdicts = automaticMemoryCandidates('tidy the licence panel', { dir, files: [join(home, 'repo/src/panels/Licence.tsx')], limit: Infinity })
  assert.ok(verdicts.some(row => row.id === 'seq:40' && row.admission === 'constraint'), 'the rule about the edited file triggers')
  assert.ok(!verdicts.some(row => (row.id === 'seq:38' || row.id === 'seq:39' || row.id === 'seq:41') && (row.admission === 'constraint' || row.admission === 'companion')), 'a dated state note, a session note or a lane note naming the file is never bound as a constraint or carried as a companion')
  assert.ok(verdicts.find(row => row.id === 'seq:38')?.historical?.names === 32 || !verdicts.some(row => row.id === 'seq:38'), 'a state note naming an older cycle is marked historical when it rides at all')
  const limits = automaticMemoryCandidates('raise the limits', { dir, files: ['config/limits.yaml'], limit: Infinity })
  assert.ok(limits.some(row => row.id === 'seq:36' && row.admission === 'constraint'), 'a rule citing config/… triggers when a command names that file')
  const caption = automaticMemoryCandidates('give the subtitles to a new seat with the plain writing rules', { dir, limit: Infinity })
  assert.ok(caption.some(row => row.id === 'seq:30' && row.admission === 'constraint'), 'a captions task admits the writing constraint')
  const paraphrase = automaticMemoryCandidates('fix the caption wording on the harbour film', { dir, limit: Infinity })
  assert.ok(paraphrase.some(row => row.id === 'seq:30'), 'a paraphrase of the captions task still admits it')
  assert.equal(automaticMemoryCandidates('run the dock census and tell me the count', { dir, limit: Infinity }).length, 0, 'a distractor with no task word and no two rare stems admits nothing')
  const stale = automaticMemoryCandidates('the marble pier showcase film', { dir, limit: Infinity })
  const plan = stale.find(row => row.id === 'seq:31')
  assert.ok(plan?.historical?.names === 32 && plan.historical.latest === 36, 'a prior-cycle plan is marked historical against the library\'s latest cycle')
  assert.ok(stale.findIndex(row => row.id === 'seq:31') > stale.findIndex(row => row.id === 'seq:32'), 'the historical plan ranks after the current fact')
  console.log('PASS relevance gate; generic 0; no backfill; file constraint with its companion; captions constraint on the task and its paraphrase; historical plan marked and last')
} finally {
  rmSync(home, { recursive: true, force: true })
}
