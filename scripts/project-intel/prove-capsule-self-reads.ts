#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { rmSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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
  const capsuleModule = await import('../../src/services/projectIntel/capsule.js')
  const dir = materializeFixture('ts')
  const bootstrap = await import('../../src/bootstrap/state.js')
  bootstrap.setOriginalCwd(dir)

  const reads = new Map<string, unknown>()
  const ctx = () => ({ agentId: undefined, readFileState: reads, options: {}, getAppState: () => ({}) }) as never
  const read = (rel: string): void => void reads.set(join(dir, rel), {})

  const TASK = 'Change the rounding in src/core/pricing.ts and update tests/pricing.test.ts'
  const TASK2 = 'Now refactor src/util/validate.ts error messages'
  type Capsule = { digest: string; refs: string[]; markdown: string; delta: string | null }

  producer._resetContextCapsuleForTesting()
  const first = await producer.getContextCapsuleAttachment(null, [userMsg(TASK)] as never, ctx())
  check('the task attaches one capsule at the start of the turn', first.length === 1, String(first.length))
  const a1 = first[0] as unknown as Capsule

  read('src/services/reporting.ts')
  const assembled = capsuleModule.assembleContextCapsule({ workspace: dir, task: TASK, recentFiles: ['src/services/reporting.ts'] })
  const seen = assembled?.items.find(item => item.path === 'src/services/reporting.ts')
  check('premise: a file the model read itself enters the working set as a recent change and moves the digest', seen?.reason === capsuleModule.RECENTLY_OBSERVED_REASON && assembled?.digest !== a1.digest, `${seen?.reason} ${assembled?.digest} ${a1.digest}`)

  const prior = [userMsg(TASK), attachMsg(a1 as never)] as never
  const afterOne = await producer.getContextCapsuleAttachment(null, prior, ctx())
  check('one read by the model itself re-attaches nothing', afterOne.length === 0, String(afterOne.length))

  for (const rel of ['src/api/handlers.ts', 'src/api/server.ts', 'src/services/checkout.ts', 'src/services/invoicing.ts', 'src/core/rules.ts']) read(rel)
  const afterMany = await producer.getContextCapsuleAttachment(null, prior, ctx())
  check('six reads by the model itself re-attach nothing', afterMany.length === 0, String(afterMany.length))

  const staleRefs = a1.refs.filter(ref => ref !== 'mercury://file/MERCURY.md' && ref !== 'mercury://file/README.md' && ref !== 'mercury://file/docs/ARCHITECTURE.md')
  const missing = a1.refs.filter(ref => !staleRefs.includes(ref))
  const staleA1 = { ...a1, digest: 'stale', refs: staleRefs }
  const withNew = await producer.getContextCapsuleAttachment(null, [userMsg(TASK), attachMsg(staleA1 as never)] as never, ctx())
  check('a ref the model has not been shown, and did not read itself, still re-attaches', missing.length > 0 && withNew.length === 1, `${missing.length} missing, ${withNew.length} attached`)

  const next = await producer.getContextCapsuleAttachment(null, [userMsg(TASK), attachMsg(a1 as never), userMsg(TASK2)] as never, ctx())
  check('the next task attaches a capsule', next.length === 1, String(next.length))
  const a2 = next[0] as unknown as Capsule
  check('and it lists the files the model read meanwhile', ['src/services/reporting.ts', 'src/api/handlers.ts'].every(rel => a2.refs.includes(`mercury://file/${rel}`)), a2.refs.join(' '))

  check('the capsule is still not painted', (await import('../../src/components/messages/nullRenderingAttachments.js')).isNullRenderingAttachment({ type: 'attachment', attachment: { type: 'context_capsule' } } as never))

  rmSync(dir, { recursive: true, force: true })

  if (failures > 0) {
    console.log(`\n❌ ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ CAPSULE SELF-READS PROOF PASSES')
  process.exit(0)
}

void main()
