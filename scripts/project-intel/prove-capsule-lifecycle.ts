#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { rmSync } from 'node:fs'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

type AnyMsg = Record<string, unknown>
const userMsg = (text: string): AnyMsg => ({ type: 'user', message: { content: text } })
const attachMsg = (attachment: Record<string, unknown>): AnyMsg => ({ type: 'attachment', attachment })

async function main(): Promise<void> {
  delete process.env.MERCURY_PROJECT_INTEL
  const { materializeFixture } = await import('./fixtures/materialize.js')
  const producer = await import('../../src/engine/attachments/contextCapsule.js')
  const intel = await import('../../src/sessions/project-intel/snapshot.js')

  const dir = materializeFixture('ts')
  const bootstrap = await import('../../src/boot/process-state/processState.js')
  const setOriginalCwd = (bootstrap as unknown as { setOriginalCwd?: (p: string) => void }).setOriginalCwd
  if (typeof setOriginalCwd === 'function') setOriginalCwd(dir)
  else process.chdir(dir)

  const ctx = (agentId?: string) =>
    ({ agentId, readFileState: new Map(), options: {}, getAppState: () => ({}) }) as never

  const TASK = 'Change the rounding in src/core/pricing.ts and update tests/pricing.test.ts'

  section('(0) first request: input-carried task, empty messages')
  producer._resetContextCapsuleForTesting()
  const turn1 = await producer.getContextCapsuleAttachment(TASK, [] as never, ctx())
  check('turn-1 capsule attaches from input alone', turn1.length === 1, `${turn1.length} · getContextCapsuleAttachment in src/engine/attachments/contextCapsule.ts must derive the task from its input argument when messages is empty`)
  const turn1Carrier = await producer.getContextCapsuleAttachment('<system-reminder>noise</system-reminder>', [] as never, ctx())
  check('carrier input never scopes a capsule', turn1Carrier.length === 0, `${turn1Carrier.length} attached · getContextCapsuleAttachment in src/engine/attachments/contextCapsule.ts must ignore a system-reminder input as a task`)

  section('(1) new task attaches one capsule')
  producer._resetContextCapsuleForTesting()
  const first = await producer.getContextCapsuleAttachment(null, [userMsg(TASK)] as never, ctx())
  check('exactly one attachment', first.length === 1, `${first.length} · getContextCapsuleAttachment in src/engine/attachments/contextCapsule.ts must attach one capsule for a new task`)
  const a1 = first[0] as { type: string; digest: string; refs: string[]; markdown: string; delta: string | null }
  check('typed context_capsule with digest + refs + block', a1.type === 'context_capsule' && a1.digest.length === 16 && a1.refs.length > 0 && a1.markdown.includes('Working set'), `type=${a1.type} digest=${a1.digest} refs=${a1.refs?.length} · the attachment built by getContextCapsuleAttachment in src/engine/attachments/contextCapsule.ts needs a 16-char digest, refs and a Working set block`)
  check('first capsule has no delta', a1.delta === null, `delta=${String(a1.delta)} · the first capsule built in src/engine/attachments/contextCapsule.ts must carry delta null`)
  check('refs include the task-named primary', a1.refs.includes('mercury://file/src/core/pricing.ts'), `refs=${a1.refs.join(',')} · the capsule refs from src/engine/attachments/contextCapsule.ts must rank the file named in the task first`)

  section('(2) unchanged capsule never re-attaches')
  const again = await producer.getContextCapsuleAttachment(
    null,
    [userMsg(TASK), attachMsg(a1 as never)] as never,
    ctx(),
  )
  check('visible identical capsule ⇒ []', again.length === 0, `${again.length} · capsuleShouldEmit and priorCapsuleFromTranscript in src/engine/attachments/contextCapsule.ts must skip a capsule whose digest is already in the transcript`)

  section('(2b) unrelated edit ⇒ same SET ⇒ no re-attach (the churn law)')
  ;(await import('node:fs')).writeFileSync(
    (await import('node:path')).join(dir, 'UNRELATED.md'),
    'tree moved\n',
  )
  const afterTreeChange = await producer.getContextCapsuleAttachment(
    null,
    [userMsg(TASK), attachMsg(a1 as never)] as never,
    ctx(),
  )
  check(
    'identical working set after an unrelated edit ⇒ [] (digest is SET identity; stale-tolerant snapshot read)',
    afterTreeChange.length === 0,
    `${afterTreeChange.length} · the digest in src/engine/attachments/contextCapsule.ts must hash the working set, not the tree, so an unrelated file change does not re-attach`,
  )

  section('(3) changed working set re-attaches with a named delta')
  const TASK2 = 'Now refactor src/util/validate.ts error messages'
  const changed = await producer.getContextCapsuleAttachment(
    null,
    [userMsg(TASK), attachMsg(a1 as never), userMsg(TASK2)] as never,
    ctx(),
  )
  check('new capsule attached', changed.length === 1, `${changed.length} · capsuleShouldEmit in src/engine/attachments/contextCapsule.ts must emit when a later user message changes the working set`)
  const a2 = changed[0] as typeof a1
  check('digest changed', a2.digest !== a1.digest, `both ${a1.digest} · the digest in src/engine/attachments/contextCapsule.ts must change with the working set`)
  check('delta names additions/removals', typeof a2.delta === 'string' && /src\/util\/validate\.ts/.test(a2.delta ?? ''), `${a2.delta ?? 'null'} · the delta text built in src/engine/attachments/contextCapsule.ts must name the paths added to the working set`)

  section('(4) capsule gone from the window (compaction) ⇒ re-attach')
  const postCompact = await producer.getContextCapsuleAttachment(null, [userMsg(TASK2)] as never, ctx())
  check('re-attaches with the same digest as the live re-derivation', postCompact.length === 1 && (postCompact[0] as typeof a1).digest === a2.digest, `attached=${postCompact.length} · getContextCapsuleAttachment in src/engine/attachments/contextCapsule.ts must re-attach when priorCapsuleFromTranscript finds no capsule, with the same digest`)

  section('(5) instruction-only capsules are not attached')
  const vague = await producer.getContextCapsuleAttachment(null, [userMsg('Explain the architecture of this project')] as never, ctx())
  check('no path/working-state evidence ⇒ no attachment', vague.length === 0, `${vague.length} · capsuleShouldEmit in src/engine/attachments/contextCapsule.ts must refuse a task that names no path or working state`)

  section('(6) subagent thread derives from ITS OWN task')
  const childTask = 'Add summarizeOrder to src/services/reporting.ts using the pricing entrypoint'
  const child = await producer.getContextCapsuleAttachment(null, [userMsg(childTask)] as never, ctx('agent-123'))
  check('child attaches its own capsule', child.length === 1, `${child.length} · getContextCapsuleAttachment in src/engine/attachments/contextCapsule.ts must key its prior-capsule state by the agentId in the context`)
  const c1 = child[0] as typeof a1
  check('child refs scope to the child task (reporting.ts primary)', c1.refs.includes('mercury://file/src/services/reporting.ts'), `refs=${c1.refs?.join(',')} · a subagent capsule from src/engine/attachments/contextCapsule.ts must derive from the subagent task`)
  check('child capsule differs from the parent capsule', c1.digest !== a2.digest, `both ${c1.digest} · the subagent capsule from src/engine/attachments/contextCapsule.ts must not reuse the parent digest`)

  section('(7) projection + null transcript render')
  const { normalizeAttachmentForAPI } = await import('../../src/engine/messages/attachmentText.js')
  const projected = normalizeAttachmentForAPI(a1 as never)
  const text = JSON.stringify(projected)
  check('projection carries the block + digest needle + guidance', text.includes('Working set') && text.includes(`capsule-digest:${a1.digest}`) && text.includes('evidence-ranked'), 'normalizeAttachmentForAPI (capsuleRows) in src/engine/messages/attachmentText.ts must carry the block, the capsule-digest needle and the evidence-ranked guidance')
  const nullRender = await import('../../src/screen/messages/nullRenderingAttachments.js')
  check(
    'context_capsule renders null in the transcript',
    nullRender.isNullRenderingAttachment({ type: 'attachment', attachment: a1 } as never),
    'add context_capsule to the null-rendering list in src/screen/messages/nullRenderingAttachments.ts',
  )

  section('(8) continuation line carries digest + primary refs')
  const { ownerFromToolUseContext } = await import('../../src/engine/run-owner/resolveOwner.js')
  const mainOwner = String(ownerFromToolUseContext({ agentId: undefined }))
  const line = producer.capsuleContinuationLine(mainOwner)
  check('line present after a main-thread attach', typeof line === 'string' && line.includes('context capsule') && line.includes(a2.digest), `${line ?? 'null'} · capsuleContinuationLine in src/engine/attachments/contextCapsule.ts must return a line with the digest after a main-thread attach`)
  check('line names primary paths', (line ?? '').includes('src/util/validate.ts'), `${line ?? 'null'} · capsuleContinuationLine in src/engine/attachments/contextCapsule.ts must list the primary refs`)

  section('(9) gate off ⇒ inert')
  process.env.MERCURY_PROJECT_INTEL = '0'
  const off = await producer.getContextCapsuleAttachment(null, [userMsg(TASK)] as never, ctx())
  check('=0 ⇒ no attachment', off.length === 0, `${off.length} · getContextCapsuleAttachment in src/engine/attachments/contextCapsule.ts must return nothing when MERCURY_PROJECT_INTEL is 0`)
  delete process.env.MERCURY_PROJECT_INTEL

  section('(10) drain-path never blocks · local submissions never capsule')
  const { computeWorkingTreeDigest, computeWorkingTreeDigestAsync } = await import(
    '../../src/platform/verification/verificationState.js'
  )
  const fs = await import('node:fs')
  const copyA = `${dir}-digest-eq-a`
  const copyB = `${dir}-digest-eq-b`
  fs.cpSync(dir, copyA, { recursive: true })
  fs.cpSync(dir, copyB, { recursive: true })
  const dSync = computeWorkingTreeDigest(copyA)
  const dAsync = await computeWorkingTreeDigestAsync(copyB)
  check('async digest ≡ sync digest over identical trees', dSync !== null && dSync === dAsync, `${dSync} vs ${dAsync} · computeWorkingTreeDigestAsync must hash the same as computeWorkingTreeDigest, both in src/platform/verification/verificationState.ts`)
  fs.rmSync(copyA, { recursive: true, force: true })
  fs.rmSync(copyB, { recursive: true, force: true })
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
  enableConfigs()
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.js')
  const { getAttachments } = await import('../../src/engine/attachments/turnAttachments.js')
  const { createUserMessage } = await import('../../src/engine/message-shapes/factories.js')
  const { ReadTool } = await import('../../src/tools/read/ReadTool.js')
  const state = bootstrap as unknown as { setProjectRoot?: (p: string) => void; setCwdState?: (p: string) => void; setSessionTrustAccepted?: (v: boolean) => void }
  state.setProjectRoot?.(dir)
  state.setCwdState?.(dir)
  state.setSessionTrustAccepted?.(true)
  const orchestratorContext = (): never => {
    let appState = getDefaultAppState()
    return {
      options: { commands: [], tools: [ReadTool], engineModel: 'claude-fable-5-1', mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => appState,
      setAppState: (fn: (s: typeof appState) => typeof appState) => { appState = fn(appState) },
      abortController: new AbortController(),
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(100),
      loadedNestedMemoryPaths: new Set(),
      nestedMemoryAttachmentTriggers: new Set(),
    } as never
  }
  const openingTurn = [createUserMessage({ content: TASK })]
  producer._resetContextCapsuleForTesting()
  const local = await getAttachments(TASK, orchestratorContext(), [], openingTurn as never, undefined, { localSubmission: true })
  check('orchestrator skips the capsule on localSubmission: an opening turn (no assistant row yet) submitted locally attaches no capsule', !local.some(a => a.type === 'context_capsule'), `${local.map(a => a.type).join(',')} · the context_capsule entry in getAttachments, src/engine/attachments/turnAttachments.ts, must return nothing when options.localSubmission is set`)
  producer._resetContextCapsuleForTesting()
  const prompt = await getAttachments(TASK, orchestratorContext(), [], openingTurn as never)
  check('…while the same opening turn as a prompt attaches one (the control: the skip is the submission\'s, not the turn\'s)', prompt.filter(a => a.type === 'context_capsule').length === 1, `${prompt.map(a => a.type).join(',')} · the context_capsule entry in getAttachments, src/engine/attachments/turnAttachments.ts, must attach one capsule on an opening prompt turn without localSubmission`)

  rmSync(dir, { recursive: true, force: true })

  console.log('\n' + '═'.repeat(76))
  if (failures > 0) {
    console.log(`❌ ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('✅ CAPSULE LIFECYCLE PROOF PASSES')
  process.exit(0)
}

void main()
