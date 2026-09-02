/**
 * the transactional store proof.
 *
 * Persistence/recovery: native-root creation through the seam,
 * canonical-write on legacy-home projects, duplicate
 * blocked, revision conflict
 * instead of blind overwrite, injected failure at every durable-publish phase
 * (old-complete-or-new-complete, never a hybrid), trash-first delete with a
 * typed error on a missing source,
 * restore + restore-conflict, drafts + damaged-draft tolerance, receipts.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'foundry-store-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_FAULT_INJECT

const { decodeAgentDocument, serializeAgentMarkdown, patchAgentDocument } =
  await import('../../src/services/agents/codec.js')
const { revisionDigest } = await import('../../src/services/agents/contracts.js')
const {
  AgentStoreError,
  deleteAgentToTrash,
  discardAgentDraft,
  listAgentDrafts,
  listAgentTrash,
  newAgentPath,
  restoreAgentFromTrash,
  saveAgentDocument,
  saveAgentDraft,
} = await import('../../src/services/agents/store.js')

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function expectCode(
  name: string,
  code: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn()
    check(name, false, 'no error thrown')
  } catch (e) {
    check(
      name,
      e instanceof AgentStoreError && e.code === code,
      e instanceof AgentStoreError ? `code=${e.code}` : String(e),
    )
  }
}

const freshDoc = (name: string, description = 'Use when testing.') =>
  decodeAgentDocument(
    serializeAgentMarkdown({ name, description }, `You are ${name}.`),
  )

// ── P1: fresh project creation lands in .mercury via the seam ───────────────
{
  console.log('P1: native-root creation (fresh project → .mercury)')
  const project = join(scratch, 'fresh-project')
  mkdirSync(join(project, '.git'), { recursive: true })
  const receipt = await saveAgentDocument(
    { kind: 'new', scope: 'project', cwd: project, slug: 'fresh-one' },
    freshDoc('fresh-one'),
  )
  const expected = join(project, '.mercury', 'agents', 'fresh-one.md')
  check('lands under .mercury/agents (fresh-write law, sovereign §9)', receipt.path === expected, receipt.path)
  check('file exists + decodes', existsSync(expected))
  check('receipt revision matches bytes',
    receipt.afterRevision === revisionDigest(readFileSync(expected, 'utf-8')))
  check('semantic changes recorded',
    receipt.semanticChanges.includes('name') && receipt.semanticChanges.includes('body'),
    receipt.semanticChanges.join(','))
}

// ── P2: legacy.claude project — NEW writes land canonical ─
{
  console.log('P2: legacy .claude project writes canonical')
  const project = join(scratch, 'legacy-project')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, '.claude', 'agents'), { recursive: true })
  const receipt = await saveAgentDocument(
    { kind: 'new', scope: 'project', cwd: project, slug: 'legacy-one' },
    freshDoc('legacy-one'),
  )
  check(
    'a NEW agent lands in .mercury/agents (the old home is import-only)',
    receipt.path === join(project, '.mercury', 'agents', 'legacy-one.md'),
    receipt.path,
  )
}

// ── P3: duplicate blocked · user scope ──────────────────────────────────────
{
  console.log('P3: duplicate + user scope')
  const cwd = join(scratch, 'anywhere')
  mkdirSync(cwd, { recursive: true })
  const receipt = await saveAgentDocument(
    { kind: 'new', scope: 'user', cwd, slug: 'user-one' },
    freshDoc('user-one'),
  )
  check('user agent lands in config home', receipt.path === join(home, 'agents', 'user-one.md'))
  await expectCode('same-path duplicate refused', 'already-exists', () =>
    saveAgentDocument(
      { kind: 'new', scope: 'user', cwd, slug: 'user-one' },
      freshDoc('user-one'),
    ),
  )
}

// ── P4: revision conflict instead of blind overwrite ────────────────────────
{
  console.log('P4: revision conflict')
  const path = join(home, 'agents', 'conflict.md')
  const original = serializeAgentMarkdown(
    { name: 'conflict-agent', description: 'v1' },
    'Original body.',
  )
  writeFileSync(path, original)
  const loaded = decodeAgentDocument(original, path)
  const identity = { filePath: path, revision: revisionDigest(original) }
  // Concurrent external edit lands…
  writeFileSync(path, original.replace('v1', 'v2-external'))
  const mine = patchAgentDocument(loaded, { set: { description: 'v2-mine' } })
  try {
    await saveAgentDocument({ kind: 'existing', identity }, mine)
    check('conflicting save refused', false, 'save succeeded')
  } catch (e) {
    const err = e as InstanceType<typeof AgentStoreError>
    check('conflicting save refused', err.code === 'revision-conflict', err.code)
    check('conflict carries current bytes',
      err.detail?.currentRaw?.includes('v2-external') === true)
  }
  check('external edit untouched after refusal',
    readFileSync(path, 'utf-8').includes('v2-external'))
  // Reload → save cleanly.
  const reloadedRaw = readFileSync(path, 'utf-8')
  const reloaded = decodeAgentDocument(reloadedRaw, path)
  const saved = await saveAgentDocument(
    { kind: 'existing', identity: { filePath: path, revision: revisionDigest(reloadedRaw) } },
    patchAgentDocument(reloaded, { set: { description: 'v3-merged' } }),
  )
  check('reload-then-save commits', saved.beforeRevision === revisionDigest(reloadedRaw))
  await expectCode('vanished source = typed error', 'source-missing', () =>
    saveAgentDocument(
      { kind: 'existing', identity: { filePath: join(home, 'agents', 'gone.md'), revision: 'dead' } },
      mine,
    ),
  )
}

// ── P5: injected failure at every publish phase ─────────────────────────────
{
  console.log('P5: fault injection (old-complete-or-new-complete)')
  const path = join(home, 'agents', 'faulty.md')
  const v1 = serializeAgentMarkdown({ name: 'faulty-agent', description: 'v1' }, 'B1.')
  writeFileSync(path, v1)
  for (const phase of ['create-temp', 'write', 'flush-file', 'rename']) {
    process.env.MERCURY_FAULT_INJECT = `${phase}@faulty.md:throw`
    const doc = patchAgentDocument(decodeAgentDocument(v1, path), {
      set: { description: `after-${phase}` },
    })
    try {
      await saveAgentDocument(
        { kind: 'existing', identity: { filePath: path, revision: revisionDigest(v1) } },
        doc,
      )
      check(`${phase}: save failed loudly`, false, 'save succeeded under fault')
    } catch (e) {
      check(
        `${phase}: typed io error`,
        e instanceof AgentStoreError && e.code === 'io',
        String(e),
      )
    }
    const after = readFileSync(path, 'utf-8')
    check(`${phase}: old file intact (never a hybrid)`, after === v1)
  }
  delete process.env.MERCURY_FAULT_INJECT
}

// ── P6: delete → trash → restore ────────────────────────────────────────────
{
  console.log('P6: trash + restore')
  const path = join(home, 'agents', 'doomed.md')
  const raw = serializeAgentMarkdown({ name: 'doomed-agent', description: 'd' }, 'Doomed body.')
  writeFileSync(path, raw)
  const identity = { filePath: path, revision: revisionDigest(raw) }
  const entry = await deleteAgentToTrash(identity, {
    agentType: 'doomed-agent',
    source: 'userSettings',
  })
  check('source removed', !existsSync(path))
  check('trash entry listed', listAgentTrash().some(t => t.id === entry.id))
  const restored = await restoreAgentFromTrash(entry.id)
  check('restored to original path', restored.path === path && existsSync(path))
  check('restored bytes exact', readFileSync(path, 'utf-8') === raw)
  check('trash entry consumed', !listAgentTrash().some(t => t.id === entry.id))

  // Missing source: typed error, never a silent "Deleted" success.
  await expectCode('deleting a missing file is a typed error', 'source-missing', () =>
    deleteAgentToTrash(
      { filePath: join(home, 'agents', 'never-was.md'), revision: 'dead' },
      { agentType: 'never-was', source: 'userSettings' },
    ),
  )

  // Restore-conflict: refuse to overwrite silently.
  const entry2 = await deleteAgentToTrash(
    { filePath: path, revision: revisionDigest(raw) },
    { agentType: 'doomed-agent', source: 'userSettings' },
  )
  writeFileSync(path, raw.replace('Doomed body.', 'Squatter.'))
  await expectCode('restore refuses to overwrite', 'already-exists', () =>
    restoreAgentFromTrash(entry2.id),
  )
  const elsewhere = join(home, 'agents', 'doomed-restored.md')
  const restored2 = await restoreAgentFromTrash(entry2.id, { toPath: elsewhere })
  check('restore-as works', restored2.path === elsewhere && existsSync(elsewhere))
}

// ── P7: drafts ──────────────────────────────────────────────────────────────
{
  console.log('P7: drafts')
  const draftRaw = serializeAgentMarkdown(
    { name: 'draft-agent', description: 'unsaved work' },
    'Draft body.',
  )
  const draftPath = await saveAgentDraft({
    newTarget: { scope: 'user', cwd: scratch },
    raw: draftRaw,
  })
  const listed = listAgentDrafts()
  check('draft listed', listed.some(d => d.path === draftPath))
  check('draft raw survives', listed.find(d => d.path === draftPath)?.draft.raw === draftRaw)
  // Damaged draft never crashes recovery.
  writeFileSync(join(home, 'agent-drafts', 'zz-damaged.json'), '{not json')
  check('damaged draft tolerated', listAgentDrafts().length === listed.length)
  discardAgentDraft(draftPath)
  check('draft discarded', !listAgentDrafts().some(d => d.path === draftPath))
}

// ── P8: receipts ledger ─────────────────────────────────────────────────────
{
  console.log('P8: receipts')
  const receipts = readFileSync(join(home, 'agent-receipts.jsonl'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { kind: string })
  check('save receipts recorded', receipts.some(r => r.kind === 'save'))
  check('delete receipts recorded', receipts.some(r => r.kind === 'delete'))
  check('restore receipts recorded', receipts.some(r => r.kind === 'restore'))
}

// newAgentPath sanity: the seam never emits a literal `.claude` for fresh trees.
{
  const fresh = join(scratch, 'seam-check')
  mkdirSync(fresh, { recursive: true })
  check(
    'seam: fresh tree resolves .mercury',
    newAgentPath('project', fresh, 'x').includes('.mercury'),
  )
}

rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} store check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll store checks pass.')
