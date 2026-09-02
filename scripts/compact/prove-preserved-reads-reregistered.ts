#!/usr/bin/env bun
// ============================================================================
//  prove-preserved-reads-reregistered — a full compaction re-registers the
//  reads its verbatim tail preserves (release-hardening audit rank 58).
//
//  The gap: the fold cleared the read-file ledger whole, then re-attached
//  the files NOT in the kept tail (which re-registered them through the
//  read tool) and — correctly — skipped re-attaching the files whose bytes
//  the tail already carries. Nothing re-registered those. Right after the
//  compaction the agent could see the file in the preserved tail and edit
//  it; FileEditTool refused "Read the file before editing it", FileWriteTool
//  refused the overwrite the same way, and the agent re-read every file it
//  was actively working on — a full re-read per file on a spinning disk,
//  re-spending the tokens the compaction reclaimed, on exactly the most
//  recently touched files.
//
//    L1 a preserved read's WHOLE ledger entry comes back (offset and limit
//       included — a partial read stays partial)
//    L2 a read the tail does not preserve is not re-registered here (the
//       re-attachment road owns it)
//    L3 an unchanged-file stub in the tail is not a preserved read (its
//       content was compacted away; the re-attachment re-injects it)
//    L4 both fold sites hand the ledger to the assembly and the assembly
//       restores (source pins)
//
//  PROVE_SRC names another checkout's src (the A/B control: red at the
//  pre-fix tree — no restore owner).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = join(process.env.TMPDIR ?? '/tmp', `preserved-reads-${process.pid}`)
delete process.env.NODE_ENV
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const compact = await import(join(SRC, 'services/compact/compact.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(SRC, 'utils/fileStateCache.ts'))
const { createAssistantMessage, createUserMessage } = await import(join(SRC, 'utils/messages.ts'))
const { FILE_UNCHANGED_STUB } = await import(join(SRC, 'tools/FileReadTool/prompt.ts'))

type Entry = { content: string; timestamp: number; offset: number | undefined; limit: number | undefined }
const restore = compact.restorePreservedReads as
  | ((context: unknown, ledger: Array<[string, Entry]>, preserved: unknown[]) => string[])
  | undefined
check('the restore owner is exported', typeof restore === 'function')

const readUse = (id: string, file_path: string): unknown =>
  createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path } }] as never })
const readResult = (tool_use_id: string, text: string): unknown =>
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id, content: text }] as never })

const A = '/rig/src/a.ts'
const B = '/rig/src/b.ts'
const C = '/rig/src/c.ts'
const D = '/rig/src/d.ts'
const ledger: Array<[string, Entry]> = [
  [A, { content: 'alpha', timestamp: 111, offset: 0, limit: undefined }],
  [B, { content: 'bravo', timestamp: 222, offset: 5, limit: 3 }],
  [C, { content: 'charlie', timestamp: 333, offset: 0, limit: undefined }],
  [D, { content: 'delta', timestamp: 444, offset: 0, limit: undefined }],
]
const preserved = [
  readUse('t-a', A),
  readResult('t-a', 'alpha'),
  readUse('t-b', B),
  readResult('t-b', 'bravo'),
  readUse('t-d', D),
  readResult('t-d', FILE_UNCHANGED_STUB as string),
]
const readFileState = createFileStateCacheWithSizeLimit(100) as Map<string, Entry>
const context = { readFileState } as unknown

console.log('L1 a preserved read comes back whole')
const restored = restore?.(context, ledger, preserved) ?? []
check('the full read is re-registered', readFileState.get(A)?.content === 'alpha' && readFileState.get(A)?.timestamp === 111, JSON.stringify(readFileState.get(A)))
check('…as a FULL read (offset 0, no limit)', readFileState.get(A)?.offset === 0 && readFileState.get(A)?.limit === undefined)
check('the partial read is re-registered with its window intact', readFileState.get(B)?.offset === 5 && readFileState.get(B)?.limit === 3, JSON.stringify(readFileState.get(B)))
check('the restore names what it restored', restored.length === 2 && restored.includes(A) && restored.includes(B), restored.join(','))

console.log('L2 a read the tail does not preserve is left to the re-attachment road')
check('c.ts is not re-registered here', readFileState.get(C) === undefined)

console.log('L3 an unchanged-file stub is not a preserved read')
check('d.ts (its content compacted away) is not re-registered here', readFileState.get(D) === undefined)

console.log('L4 the fold sites (source pins)')
{
  const src = readFileSync(join(SRC, 'services/compact/compact.ts'), 'utf8')
  const handoffs = (src.match(/assembleAttachments\(snapshot, context, [^,]+, 'compact_(full|partial)', ledgerBeforeFold\)/g) ?? []).length
  check('both fold sites hand the ledger to the assembly', handoffs === 2, `${handoffs} site(s)`)
  check('the assembly restores the preserved reads', src.includes('restorePreservedReads(context, ledger, preserved)'))
  check('the ceiling refusal still hands the whole ledger back (rank 26 stands)', src.includes('for (const [path, state] of ledgerBeforeFold) context.readFileState.set(path, state)'))
}

console.log(failures === 0 ? '\nprove-preserved-reads-reregistered: ALL PASS' : `\nprove-preserved-reads-reregistered: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
