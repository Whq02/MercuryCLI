#!/usr/bin/env bun
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = join(process.env.TMPDIR ?? '/tmp', `preserved-reads-${process.pid}`)
delete process.env.NODE_ENV
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const RESTORE_OWNER = 'restorePreservedReads in src/engine/compaction/fold/foldAttachments.ts, re-exported by src/engine/compaction/foldConversation.ts'

const compact = await import(join(SRC, 'engine/compaction/foldConversation.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(SRC, 'platform/files/fileStateCache.ts'))
const { createAssistantMessage, createUserMessage } = await import(join(SRC, 'engine/messages/messages.ts'))
const { FILE_UNCHANGED_STUB } = await import(join(SRC, 'tools/kit/names/read.ts'))

type Entry = { content: string; timestamp: number; offset: number | undefined; limit: number | undefined }
const restore = compact.restorePreservedReads as
  | ((context: unknown, ledger: Array<[string, Entry]>, preserved: unknown[]) => string[])
  | undefined
check('the restore owner is exported', typeof restore === 'function', 'export ' + RESTORE_OWNER)

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
check('the full read is re-registered', readFileState.get(A)?.content === 'alpha' && readFileState.get(A)?.timestamp === 111, JSON.stringify(readFileState.get(A)) + ' | ' + RESTORE_OWNER + ' must put the ledger entry of a preserved Read back into readFileState')
check('…as a FULL read (offset 0, no limit)', readFileState.get(A)?.offset === 0 && readFileState.get(A)?.limit === undefined, JSON.stringify(readFileState.get(A)) + ' | ' + RESTORE_OWNER + ' must keep offset 0 and no limit for a full read')
check('the partial read is re-registered with its window intact', readFileState.get(B)?.offset === 5 && readFileState.get(B)?.limit === 3, JSON.stringify(readFileState.get(B)) + ' | ' + RESTORE_OWNER + ' must keep the offset and limit of a partial read')
check('the restore names what it restored', restored.length === 2 && restored.includes(A) && restored.includes(B), restored.join(',') + ' | ' + RESTORE_OWNER + ' must return the paths it re-registered, here the two preserved reads a.ts and b.ts')

console.log('L2 a read the tail does not preserve is left to the re-attachment road')
check('c.ts is not re-registered here', readFileState.get(C) === undefined, RESTORE_OWNER + ' must restore only files whose Read is in the preserved tail')

console.log('L3 an unchanged-file stub is not a preserved read')
check('d.ts (its content compacted away) is not re-registered here', readFileState.get(D) === undefined, RESTORE_OWNER + ' must skip a preserved Read whose result is the unchanged-file stub (FILE_UNCHANGED_STUB)')


console.log(failures === 0 ? '\nprove-preserved-reads-reregistered: ALL PASS' : `\nprove-preserved-reads-reregistered: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
