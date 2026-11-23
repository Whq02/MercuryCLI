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
  await import('../../src/crew/agents/codec.js')
const { revisionDigest } = await import('../../src/crew/agents/contracts.js')
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
} = await import('../../src/crew/agents/store.js')

let failures = 0
function check(name: string, cond: boolean, detail?: string, hint?: string): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}${hint ? ` — ${hint}` : ''}`)
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
      `fix the function this case calls in src/crew/agents/store.ts so it throws an AgentStoreError with code ${code}`,
    )
  }
}

const freshDoc = (name: string, description = 'Use when testing.') =>
  decodeAgentDocument(
    serializeAgentMarkdown({ name, description }, `You are ${name}.`),
  )

{
  console.log('P1: native-root creation (fresh project → .mercury)')
  const project = join(scratch, 'fresh-project')
  mkdirSync(join(project, '.git'), { recursive: true })
  const receipt = await saveAgentDocument(
    { kind: 'new', scope: 'project', cwd: project, slug: 'fresh-one' },
    freshDoc('fresh-one'),
  )
  const expected = join(project, '.mercury', 'agents', 'fresh-one.md')
  check('lands under .mercury/agents (fresh-write law, sovereign §9)', receipt.path === expected, receipt.path, 'fix the path a new agent is saved to in saveAgentDocument and newAgentPath in src/crew/agents/store.ts')
  check('file exists + decodes', existsSync(expected), undefined, 'fix saveAgentDocument in src/crew/agents/store.ts so it writes the file at receipt.path')
  check('receipt revision matches bytes',
    receipt.afterRevision === revisionDigest(readFileSync(expected, 'utf-8')), undefined, 'fix saveAgentDocument in src/crew/agents/store.ts so afterRevision is the revisionDigest of the bytes it wrote')
  check('semantic changes recorded',
    receipt.semanticChanges.includes('name') && receipt.semanticChanges.includes('body'),
    receipt.semanticChanges.join(','), 'fix the semanticChanges a new-agent save reports in src/crew/agents/store.ts')
}

{
  console.log('P2: a project with an external agents directory still writes canonical')
  const project = join(scratch, 'external-project')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, '.claude', 'agents'), { recursive: true })
  const receipt = await saveAgentDocument(
    { kind: 'new', scope: 'project', cwd: project, slug: 'external-one' },
    freshDoc('external-one'),
  )
  check(
    'a NEW agent lands in .mercury/agents (the external directory is import-only)',
    receipt.path === join(project, '.mercury', 'agents', 'external-one.md'),
    receipt.path,
    'fix saveAgentDocument in src/crew/agents/store.ts so a new agent goes to .mercury/agents even when an external agents directory exists',
  )
}

{
  console.log('P3: duplicate + user scope')
  const cwd = join(scratch, 'anywhere')
  mkdirSync(cwd, { recursive: true })
  const receipt = await saveAgentDocument(
    { kind: 'new', scope: 'user', cwd, slug: 'user-one' },
    freshDoc('user-one'),
  )
  check('user agent lands in config home', receipt.path === join(home, 'agents', 'user-one.md'), receipt.path, 'fix saveAgentDocument in src/crew/agents/store.ts so a user-scope agent lands in agents under the config home')
  await expectCode('same-path duplicate refused', 'already-exists', () =>
    saveAgentDocument(
      { kind: 'new', scope: 'user', cwd, slug: 'user-one' },
      freshDoc('user-one'),
    ),
  )
}

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
  writeFileSync(path, original.replace('v1', 'v2-external'))
  const mine = patchAgentDocument(loaded, { set: { description: 'v2-mine' } })
  try {
    await saveAgentDocument({ kind: 'existing', identity }, mine)
    check('conflicting save refused', false, 'save succeeded', 'fix saveAgentDocument in src/crew/agents/store.ts to compare identity.revision with the bytes on disk and throw revision-conflict')
  } catch (e) {
    const err = e as InstanceType<typeof AgentStoreError>
    check('conflicting save refused', err.code === 'revision-conflict', err.code, 'fix saveAgentDocument in src/crew/agents/store.ts to throw an AgentStoreError with code revision-conflict')
    check('conflict carries current bytes',
      err.detail?.currentRaw?.includes('v2-external') === true, undefined, 'fix the revision-conflict error in src/crew/agents/store.ts to carry the current file bytes in detail.currentRaw')
  }
  check('external edit untouched after refusal',
    readFileSync(path, 'utf-8').includes('v2-external'), undefined, 'fix saveAgentDocument in src/crew/agents/store.ts so a refused save leaves the file on disk untouched')
  const reloadedRaw = readFileSync(path, 'utf-8')
  const reloaded = decodeAgentDocument(reloadedRaw, path)
  const saved = await saveAgentDocument(
    { kind: 'existing', identity: { filePath: path, revision: revisionDigest(reloadedRaw) } },
    patchAgentDocument(reloaded, { set: { description: 'v3-merged' } }),
  )
  check('reload-then-save commits', saved.beforeRevision === revisionDigest(reloadedRaw), undefined, 'fix saveAgentDocument in src/crew/agents/store.ts so a save with the current revision commits and reports it as beforeRevision')
  await expectCode('vanished source = typed error', 'source-missing', () =>
    saveAgentDocument(
      { kind: 'existing', identity: { filePath: join(home, 'agents', 'gone.md'), revision: 'dead' } },
      mine,
    ),
  )
}

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
      check(`${phase}: save failed loudly`, false, 'save succeeded under fault', `fix the atomic write in src/crew/agents/store.ts so the ${phase} step honours MERCURY_FAULT_INJECT and throws`)
    } catch (e) {
      check(
        `${phase}: typed io error`,
        e instanceof AgentStoreError && e.code === 'io',
        String(e),
        `fix the atomic write in src/crew/agents/store.ts so a failure at the ${phase} step throws an AgentStoreError with code io`,
      )
    }
    const after = readFileSync(path, 'utf-8')
    check(`${phase}: old file intact (never a hybrid)`, after === v1, undefined, `fix the atomic write in src/crew/agents/store.ts so a failure at the ${phase} step leaves the old file bytes in place`)
  }
  delete process.env.MERCURY_FAULT_INJECT
}

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
  check('source removed', !existsSync(path), undefined, 'fix deleteAgentToTrash in src/crew/agents/store.ts so it moves the file out of its original path')
  check('trash entry listed', listAgentTrash().some(t => t.id === entry.id), undefined, 'fix deleteAgentToTrash and listAgentTrash in src/crew/agents/store.ts so a deleted agent is listed in trash')
  const restored = await restoreAgentFromTrash(entry.id)
  check('restored to original path', restored.path === path && existsSync(path), restored.path, 'fix restoreAgentFromTrash in src/crew/agents/store.ts so it puts the file back at its original path')
  check('restored bytes exact', readFileSync(path, 'utf-8') === raw, undefined, 'fix deleteAgentToTrash and restoreAgentFromTrash in src/crew/agents/store.ts so the restored bytes equal the deleted bytes')
  check('trash entry consumed', !listAgentTrash().some(t => t.id === entry.id), undefined, 'fix restoreAgentFromTrash in src/crew/agents/store.ts so a restored entry is removed from trash')

  await expectCode('deleting a missing file is a typed error', 'source-missing', () =>
    deleteAgentToTrash(
      { filePath: join(home, 'agents', 'never-was.md'), revision: 'dead' },
      { agentType: 'never-was', source: 'userSettings' },
    ),
  )

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
  check('restore-as works', restored2.path === elsewhere && existsSync(elsewhere), restored2.path, 'fix the toPath option of restoreAgentFromTrash in src/crew/agents/store.ts')
}

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
  check('draft listed', listed.some(d => d.path === draftPath), undefined, 'fix saveAgentDraft and listAgentDrafts in src/crew/agents/store.ts so a saved draft is listed under its path')
  check('draft raw survives', listed.find(d => d.path === draftPath)?.draft.raw === draftRaw, undefined, 'fix saveAgentDraft and listAgentDrafts in src/crew/agents/store.ts so the draft raw text round-trips')
  writeFileSync(join(home, 'agent-drafts', 'zz-damaged.json'), '{not json')
  check('damaged draft tolerated', listAgentDrafts().length === listed.length, undefined, 'fix listAgentDrafts in src/crew/agents/store.ts to skip a draft file that is not valid JSON')
  discardAgentDraft(draftPath)
  check('draft discarded', !listAgentDrafts().some(d => d.path === draftPath), undefined, 'fix discardAgentDraft in src/crew/agents/store.ts so it removes the draft file')
}

{
  console.log('P8: receipts')
  const receipts = readFileSync(join(home, 'agent-receipts.jsonl'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { kind: string })
  check('save receipts recorded', receipts.some(r => r.kind === 'save'), undefined, 'fix saveAgentDocument in src/crew/agents/store.ts to append a save receipt to agent-receipts.jsonl in the config home')
  check('delete receipts recorded', receipts.some(r => r.kind === 'delete'), undefined, 'fix deleteAgentToTrash in src/crew/agents/store.ts to append a delete receipt to agent-receipts.jsonl in the config home')
  check('restore receipts recorded', receipts.some(r => r.kind === 'restore'), undefined, 'fix restoreAgentFromTrash in src/crew/agents/store.ts to append a restore receipt to agent-receipts.jsonl in the config home')
}

{
  const fresh = join(scratch, 'seam-check')
  mkdirSync(fresh, { recursive: true })
  check(
    'seam: fresh tree resolves .mercury',
    newAgentPath('project', fresh, 'x').includes('.mercury'),
    newAgentPath('project', fresh, 'x'),
    'fix newAgentPath in src/crew/agents/store.ts so a project without agent directories resolves under .mercury',
  )
}

rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} store check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll store checks pass.')
