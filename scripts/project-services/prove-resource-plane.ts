#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'vanguard-refs-'))
process.env.MERCURY_CONFIG_DIR = configDir
delete process.env.MERCURY_REFS
delete process.env.MERCURY_CHANGE_RECEIPTS

const {
  boundedTextView,
  formatRef,
  parseMercuryRef,
} = await import('../../src/integrations/resources/contracts.ts')
const {
  resolveResource,
  resourceAdapterKinds,
} = await import('../../src/integrations/resources/registry.ts')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.ts')
const { observeToolTerminal } = await import('../../src/engine/run-owner/effectObserver.ts')
const { _resetChangeReceiptsForTesting, receiptsFor } = await import(
  '../../src/tools/engines/change-transaction/receipts.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — resource plane proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const workDir = mkdtempSync(join(tmpdir(), 'vanguard-refs-work-'))
const owner = makeOwnerKey({
  workspace: workDir,
  sessionId: 'refs-session',
  lane: 'main',
} as never)
const ctx = { owner, cwd: workDir }

section('G. ref grammar')
{
  const parsed = parseMercuryRef('mercury://file/some/deep/path.ts?lines=10-20&q=alpha&cursor=5&limit=50&child=x')
  check('G1 parse: kind/id keep slashes; selectors typed',
    parsed?.kind === 'file' &&
    parsed.id === 'some/deep/path.ts' &&
    parsed.selectors.lines?.start === 10 && parsed.selectors.lines.end === 20 &&
    parsed.selectors.q === 'alpha' && parsed.selectors.cursor === 5 &&
    parsed.selectors.limit === 50 && parsed.selectors.child === 'x',
    'fix parseMercuryRef in src/integrations/resources/contracts.ts so kind, id and the lines/q/cursor/limit/child selectors parse as typed')
  check('G2 canonical round trip', parsed?.canonical === 'mercury://file/some/deep/path.ts',
    'fix the canonical field built by parseMercuryRef in src/integrations/resources/contracts.ts (kind and id only, no selectors)')
  check('G3 malformed refusals',
    parseMercuryRef('http://x') === null &&
    parseMercuryRef('mercury://UPPER/x') === null &&
    parseMercuryRef('mercury://') === null,
    'fix parseMercuryRef in src/integrations/resources/contracts.ts so a non-mercury scheme, an upper-case kind and an empty kind return null')
  check('G4 formatRef', formatRef('run', 'current') === 'mercury://run/current',
    'fix formatRef in src/integrations/resources/contracts.ts')
  const view = boundedTextView('a\nb\nc\nd\ne', { cursor: 1, limit: 2 })
  check('G5 boundedTextView pages deterministically',
    view.text === 'b\nc' && view.page.hasMore === true && view.page.total === 5,
    'fix boundedTextView in src/integrations/resources/contracts.ts so cursor and limit select the lines and the page reports hasMore and total')
}

section('S. state honesty')
{
  const unknown = await resolveResource('mercury://nosuchkind/x', ctx as never)
  check('S1 unknown kind names the known kinds',
    unknown.state === 'absent' && unknown.note.includes('known kinds:') && unknown.note.includes('file'),
    'fix the unknown-kind branch of resolveResource in src/integrations/resources/registry.ts to answer absent with a note listing the known kinds')
  check('S2 adapter census ≥ 10 built-ins', (await resourceAdapterKinds()).length >= 10,
    'the adapter table built by src/integrations/resources/registry.ts lost adapters; restore them in the list it imports')

  const boom = await resolveResource('mercury://seat', {
    ...ctx,
    engineModel: 'fixture-model',
    getAppState: () => {
      throw new Error('fixture explosion')
    },
  } as never)
  check('S3 a throwing adapter degrades to UNAVAILABLE with the error named',
    boom.state === 'unavailable' && boom.note.includes('fixture explosion'),
    'fix the catch around the adapter call in resolveResource in src/integrations/resources/registry.ts to answer unavailable with the error message in the note')

  const missing = await resolveResource(`mercury://file/${join(workDir, 'nope.ts')}`, ctx as never)
  check('S4 a missing file is ABSENT (never an empty resource)',
    missing.state === 'absent' && missing.note.includes('no such file'),
    'fix the missing-path branch of the file adapter in src/integrations/resources/adapters/file.ts to answer absent with a no such file note')
}

section('F. file adapter')
{
  const filePath = join(workDir, 'sample.ts')
  writeFileSync(filePath, Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'))
  mkdirSync(join(workDir, 'subdir'))

  const whole = await resolveResource(`mercury://file/${filePath}`, ctx as never)
  check('F1 file resolves with anchor + version',
    whole.state === 'ok' &&
    whole.resource.summary.includes('anchor fa:') &&
    /^m\d+-s\d+$/.test(whole.resource.version ?? ''),
    'fix the file adapter in src/integrations/resources/adapters/file.ts so a file resolves ok with an anchor in the summary and a version of the form m<mtime>-s<size>')

  const ranged = await resolveResource(`mercury://file/${filePath}?lines=5-7`, ctx as never)
  check('F2 lines selector bounds the view',
    ranged.state === 'ok' && ranged.resource.text === 'line 5\nline 6\nline 7',
    'fix the lines selector handling in the file adapter, src/integrations/resources/adapters/file.ts')

  const filtered = await resolveResource(`mercury://file/${filePath}?q=line 2`, ctx as never)
  check('F3 q selector filters lines',
    filtered.state === 'ok' &&
    filtered.resource.text?.split('\n').every(l => l.includes('line 2')) === true &&
    (filtered.resource.text?.split('\n').length ?? 0) === 11,
    'fix the q selector handling in the file adapter, src/integrations/resources/adapters/file.ts')

  const dir = await resolveResource(`mercury://file/${workDir}`, ctx as never)
  check('F4 directory lists sorted children with refs',
    dir.state === 'ok' &&
    (dir.resource.children?.length ?? 0) >= 2 &&
    dir.resource.children!.every(c => c.ref.startsWith('mercury://file/')),
    'fix the directory listing in the file adapter, src/integrations/resources/adapters/file.ts, so it returns children whose refs start with mercury://file/')
}

section('R. receipt adapter')
{
  _resetChangeReceiptsForTesting()
  for (let i = 0; i < 300; i++) {
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: `toolu_${i}`,
      input: { file_path: '/tmp/r.ts' },
      ok: true,
      durationMs: 1,
      cwd: workDir,
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: ['/tmp/r.ts'],
        evidence: `synthetic ${i}`,
        startedAt: 1,
        completedAt: 2,
      },
    } as never)
  }
  const live = receiptsFor(owner)
  const liveId = live[live.length - 1]!.id
  const one = await resolveResource(`mercury://receipt/${liveId}`, ctx as never)
  check('R1 a retained receipt resolves with intent + effect',
    one.state === 'ok' && one.resource.text?.includes('file.edit') === true,
    'fix the single-receipt read in src/integrations/resources/adapters/receipt.ts so a retained receipt resolves with its operation in the text')

  const listing = await resolveResource('mercury://receipt', ctx as never)
  check('R2 the listing carries children with seq titles',
    listing.state === 'ok' && (listing.resource.children?.length ?? 0) === 50,
    'fix the listing in src/integrations/resources/adapters/receipt.ts so it returns the last 50 receipts as children')

  const fallen = await resolveResource('mercury://receipt/1', ctx as never)
  check('R3 a fallen-off seq reads EXPIRED (ring bound named), never absent',
    fallen.state === 'expired' && fallen.note.includes('ring'),
    'fix the expired branch in src/integrations/resources/adapters/receipt.ts so a seq no longer retained answers expired with a note naming the bounded ring')

  const never = await resolveResource('mercury://receipt/rcpt-nonexistent', ctx as never)
  check('R4 an unknown id reads ABSENT', never.state === 'absent',
    'fix the unknown-id branch in src/integrations/resources/adapters/receipt.ts to answer absent')
}

section('T. task adapter (real durable ledger, hermetic store)')
{
  const { createTask, getTaskListId } = await import('../../src/engine/task-framework/tasks.ts')
  const id = await createTask(getTaskListId(), {
    subject: 'fixture task for refs',
    description: 'the resource plane proof reads this through mercury://task',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  } as never)
  const one = await resolveResource(`mercury://task/${id}`, ctx as never)
  check('T1 a ledger task resolves with subject + status',
    one.state === 'ok' && one.resource.text?.includes('fixture task for refs') === true,
    'fix the task adapter, src/integrations/resources/adapters/task.ts, so a ledger task resolves with its subject in the text')
  const listing = await resolveResource('mercury://task', ctx as never)
  check('T2 the ledger listing includes it',
    listing.state === 'ok' &&
    listing.resource.children?.some(c => c.title.includes('fixture task for refs')) === true,
    'fix the listing in the task adapter, src/integrations/resources/adapters/task.ts, so each ledger task appears as a child titled with its subject')
  const gone = await resolveResource('mercury://task/999999', ctx as never)
  check('T3 an unknown task id reads ABSENT', gone.state === 'absent',
    'fix the unknown-id branch in the task adapter, src/integrations/resources/adapters/task.ts, to answer absent')
}

section('A. artifact adapter (real store round trip)')
{
  const { storeArtifact } = await import('../../src/sessions/artifacts/store.ts')
  const { id } = await storeArtifact({
    scope: 'vanguard-proof',
    name: 'sample-report',
    content: 'artifact body line 1\nline 2\n',
    kind: 'report',
  })
  check('A1 fixture artifact stored', typeof id === 'string' && id !== null,
    'fix storeArtifact in src/sessions/artifacts/store.ts so it returns a string id')
  const one = await resolveResource(`mercury://artifact/vanguard-proof/${id}`, ctx as never)
  check('A2 the artifact resolves with sha version + body',
    one.state === 'ok' &&
    one.resource.text?.includes('artifact body line 1') === true &&
    (one.resource.version?.length ?? 0) === 12,
    'fix the read path in src/integrations/resources/adapters/artifact.ts so the artifact resolves with its body and a 12 character version')
  const listing = await resolveResource('mercury://artifact/vanguard-proof', ctx as never)
  check('A3 the scope listing includes it',
    listing.state === 'ok' && listing.resource.children?.some(c => c.title === 'sample-report') === true,
    'fix the scope listing in src/integrations/resources/adapters/artifact.ts so each stored artifact appears as a child titled with its name')
  const gone = await resolveResource('mercury://artifact/vanguard-proof/2020-nope', ctx as never)
  check('A4 an unknown artifact reads ABSENT with the prune note',
    gone.state === 'absent' && gone.note.includes('pruned'),
    'fix the not-found branch in src/integrations/resources/adapters/artifact.ts to answer absent with a note that says the artifact may have been pruned')
}

section('I. the Inspect tool end-to-end')
{
  const { InspectTool } = await import('../../src/tools/inspect/InspectTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const toolCtx = {
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      tasks: {
        b1234: {
          id: 'b1234',
          type: 'local_bash',
          status: 'running',
          description: 'fixture shell',
          startTime: Date.now() - 3000,
        },
      },
    }),
    setAppState: () => {},
    options: { tools: [], isNonInteractiveSession: true },
  }
  const filePath = join(workDir, 'sample.ts')
  const result = await (InspectTool as { call: Function }).call(
    { ref: `mercury://file/${filePath}?lines=1-3` },
    toolCtx,
  )
  check('I1 Inspect resolves a file ref through the ONE resolver',
    result.data.state === 'ok' &&
    result.data.result.includes('line 1') &&
    result.effect.operation === 'inspect.read',
    'fix call in src/tools/inspect/InspectTool.ts so a file ref goes through resolveResource and the effect operation is inspect.read')

  const agent = await (InspectTool as { call: Function }).call(
    { ref: 'mercury://agent/b1234' },
    toolCtx,
  )
  check('I2 the agent adapter reads session tasks through getAppState',
    agent.data.state === 'ok' && agent.data.result.includes('fixture shell'),
    'fix the agent adapter, src/integrations/resources/adapters/agent.ts, so it reads the session task rows from ctx.getAppState')

  const kinds = (await resourceAdapterKinds()).map(k => k.kind)
  check('I3 the kind census covers the built-in graph',
    ['file', 'run', 'receipt', 'task', 'artifact', 'health', 'agent']
      .every(k => kinds.includes(k)),
    'a built-in adapter is missing from the table built in src/integrations/resources/registry.ts (list in src/integrations/resources/kinds.ts)')
  check('I3b the retired party and workflow kinds stay out of the graph (never-reappear)',
    !kinds.includes('party') && !kinds.includes('workflow'),
    'remove the party or workflow adapter from the table built in src/integrations/resources/registry.ts and from src/integrations/resources/kinds.ts')

  process.env.MERCURY_REFS = '0'
  const off = await (InspectTool as { call: Function }).call(
    { ref: `mercury://file/${filePath}` },
    toolCtx,
  )
  check('I4 gate OFF: refs refuse to resolve + the tool leaves the catalog',
    off.data.state === 'unavailable' &&
    (InspectTool as { isEnabled: () => boolean }).isEnabled() === false,
    'with MERCURY_REFS=0 resolveResource in src/integrations/resources/registry.ts must answer unavailable and isEnabled in src/tools/inspect/InspectTool.ts must return false')
  delete process.env.MERCURY_REFS
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ resource plane: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ resource plane: every law holds')
