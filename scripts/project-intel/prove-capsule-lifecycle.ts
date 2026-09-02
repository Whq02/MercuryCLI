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
  const producer = await import('../../src/utils/attachments/contextCapsule.js')
  const intel = await import('../../src/services/projectIntel/snapshot.js')

  const dir = materializeFixture('ts')
  const bootstrap = await import('../../src/bootstrap/state.js')
  const setOriginalCwd = (bootstrap as unknown as { setOriginalCwd?: (p: string) => void }).setOriginalCwd
  if (typeof setOriginalCwd === 'function') setOriginalCwd(dir)
  else process.chdir(dir)

  const ctx = (agentId?: string) =>
    ({ agentId, readFileState: new Map(), options: {}, getAppState: () => ({}) }) as never

  const TASK = 'Change the rounding in src/core/pricing.ts and update tests/pricing.test.ts'

  section('(0) first request: input-carried task, empty messages')
  producer._resetContextCapsuleForTesting()
  const turn1 = await producer.getContextCapsuleAttachment(TASK, [] as never, ctx())
  check('turn-1 capsule attaches from input alone', turn1.length === 1, String(turn1.length))
  const turn1Carrier = await producer.getContextCapsuleAttachment('<system-reminder>noise</system-reminder>', [] as never, ctx())
  check('carrier input never scopes a capsule', turn1Carrier.length === 0)

  section('(1) new task attaches one capsule')
  producer._resetContextCapsuleForTesting()
  const first = await producer.getContextCapsuleAttachment(null, [userMsg(TASK)] as never, ctx())
  check('exactly one attachment', first.length === 1, String(first.length))
  const a1 = first[0] as { type: string; digest: string; refs: string[]; markdown: string; delta: string | null }
  check('typed context_capsule with digest + refs + block', a1.type === 'context_capsule' && a1.digest.length === 16 && a1.refs.length > 0 && a1.markdown.includes('Working set'))
  check('first capsule has no delta', a1.delta === null)
  check('refs include the task-named primary', a1.refs.includes('mercury://file/src/core/pricing.ts'))

  section('(2) unchanged capsule never re-attaches')
  const again = await producer.getContextCapsuleAttachment(
    null,
    [userMsg(TASK), attachMsg(a1 as never)] as never,
    ctx(),
  )
  check('visible identical capsule ⇒ []', again.length === 0, String(again.length))

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
    String(afterTreeChange.length),
  )

  section('(3) changed working set re-attaches with a named delta')
  const TASK2 = 'Now refactor src/util/validate.ts error messages'
  const changed = await producer.getContextCapsuleAttachment(
    null,
    [userMsg(TASK), attachMsg(a1 as never), userMsg(TASK2)] as never,
    ctx(),
  )
  check('new capsule attached', changed.length === 1)
  const a2 = changed[0] as typeof a1
  check('digest changed', a2.digest !== a1.digest)
  check('delta names additions/removals', typeof a2.delta === 'string' && /src\/util\/validate\.ts/.test(a2.delta ?? ''), a2.delta ?? 'null')

  section('(4) capsule gone from the window (compaction) ⇒ re-attach')
  const postCompact = await producer.getContextCapsuleAttachment(null, [userMsg(TASK2)] as never, ctx())
  check('re-attaches with the same digest as the live re-derivation', postCompact.length === 1 && (postCompact[0] as typeof a1).digest === a2.digest)

  section('(5) instruction-only capsules are not attached')
  const vague = await producer.getContextCapsuleAttachment(null, [userMsg('Explain the architecture of this project')] as never, ctx())
  check('no path/working-state evidence ⇒ no attachment', vague.length === 0, String(vague.length))

  section('(6) subagent thread derives from ITS OWN task')
  const childTask = 'Add summarizeOrder to src/services/reporting.ts using the pricing entrypoint'
  const child = await producer.getContextCapsuleAttachment(null, [userMsg(childTask)] as never, ctx('agent-123'))
  check('child attaches its own capsule', child.length === 1)
  const c1 = child[0] as typeof a1
  check('child refs scope to the child task (reporting.ts primary)', c1.refs.includes('mercury://file/src/services/reporting.ts'))
  check('child capsule differs from the parent capsule', c1.digest !== a2.digest)

  section('(7) projection + null transcript render')
  const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.js')
  const projected = normalizeAttachmentForAPI(a1 as never)
  const text = JSON.stringify(projected)
  check('projection carries the block + digest needle + guidance', text.includes('Working set') && text.includes(`capsule-digest:${a1.digest}`) && text.includes('evidence-ranked'))
  const nullRender = await import('../../src/components/messages/nullRenderingAttachments.js')
  check(
    'context_capsule renders null in the transcript',
    nullRender.isNullRenderingAttachment({ type: 'attachment', attachment: a1 } as never),
  )

  section('(8) continuation line carries digest + primary refs')
  const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.js')
  const mainOwner = String(ownerFromToolUseContext({ agentId: undefined }))
  const line = producer.capsuleContinuationLine(mainOwner)
  check('line present after a main-thread attach', typeof line === 'string' && line.includes('context capsule') && line.includes(a2.digest), line ?? 'null')
  check('line names primary paths', (line ?? '').includes('src/util/validate.ts'))
  const contSrc = await import('node:fs').then(fs =>
    fs.readFileSync('src/services/run/runContinuationCapsule.ts', 'utf8'),
  )
  check('runContinuationCapsule composes capsuleContinuationLine', contSrc.includes('capsuleContinuationLine'))

  section('(9) gate off ⇒ inert')
  process.env.MERCURY_PROJECT_INTEL = '0'
  const off = await producer.getContextCapsuleAttachment(null, [userMsg(TASK)] as never, ctx())
  check('=0 ⇒ no attachment', off.length === 0)
  delete process.env.MERCURY_PROJECT_INTEL

  section('(10) drain-path never blocks · local submissions never capsule')
  const { computeWorkingTreeDigest, computeWorkingTreeDigestAsync } = await import(
    '../../src/utils/verification/verificationState.js'
  )
  const fs = await import('node:fs')
  const copyA = `${dir}-digest-eq-a`
  const copyB = `${dir}-digest-eq-b`
  fs.cpSync(dir, copyA, { recursive: true })
  fs.cpSync(dir, copyB, { recursive: true })
  const dSync = computeWorkingTreeDigest(copyA)
  const dAsync = await computeWorkingTreeDigestAsync(copyB)
  check('async digest ≡ sync digest over identical trees', dSync !== null && dSync === dAsync, `${dSync} vs ${dAsync}`)
  fs.rmSync(copyA, { recursive: true, force: true })
  fs.rmSync(copyB, { recursive: true, force: true })
  const producerSrc = fs.readFileSync('src/utils/attachments/contextCapsule.ts', 'utf8')
  check('producer rides getProjectSnapshotAsync', producerSrc.includes('getProjectSnapshotAsync(') && !/const read = getProjectSnapshot\(/.test(producerSrc))
  const orchSrc = fs.readFileSync('src/utils/attachments/orchestrator.ts', 'utf8')
  check('orchestrator skips the capsule on localSubmission', /localSubmission\s*\?\s*Promise\.resolve\(\[\]\)/.test(orchSrc))
  const inputSrc = fs.readFileSync('src/utils/processUserInput/processUserInput.ts', 'utf8')
  check('the input seam names non-prompt modes local', inputSrc.includes("localSubmission: mode !== 'prompt'"))

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
