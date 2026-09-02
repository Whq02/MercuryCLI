#!/usr/bin/env bun
// ============================================================================
//  prove-restored-read-is-full — a read that covered the whole file is
//  registered as a FULL read whatever window the caller asked for
//  (release-hardening audit rank 59).
//
//  The gap: the post-compact restore read every file through the read tool
//  with POST_COMPACT_MAX_TOKENS_PER_FILE as `limit` — a line window — and
//  the tool recorded that limit verbatim, so every restored entry was a
//  partial-window read. The edit path admits a full-read entry on content
//  equality when only the mtime moved (a checkout, stash pop, formatter or
//  no-change save that rewrote identical bytes); a partial entry gets no
//  such fallback. Validation passed (the window re-read matched), the tool
//  was admitted and any prompt answered — then execution threw "File has
//  been unexpectedly modified" and the edit was lost, for a file nobody
//  changed, only after a compaction.
//
//    L1 the model's own read with a window larger than the file registers
//       a full read (offset 0, no limit)
//    L2 a window that does NOT cover the file stays partial
//    L3 the compact restore road registers a full read for a small file
//
//  PROVE_SRC names another checkout's src (the A/B control: L1 and L3 read
//  red at the pre-fix tree).
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'restored-read-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.NODE_ENV
delete process.env.MERCURY_SIMPLE
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const bootstrap = await import(join(SRC, 'bootstrap/state.ts'))
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const { getDefaultAppState } = await import(join(SRC, 'state/AppStateStore.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(SRC, 'utils/fileStateCache.ts'))
const { FileReadTool } = await import(join(SRC, 'tools/FileReadTool/FileReadTool.ts'))
const { generateFileAttachment } = await import(join(SRC, 'utils/attachments/fileAttachments.ts'))
const compact = await import(join(SRC, 'services/compact/compact.ts'))

type Entry = { content: string; timestamp: number; offset: number | undefined; limit: number | undefined }
function makeCtx(): { readFileState: Map<string, Entry> } & Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>) }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [],
      mainLoopModel: 'claude-opus-5',
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100) as Map<string, Entry>,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

const file = join(SCRATCH, 'five.ts')
writeFileSync(file, 'one\ntwo\nthree\nfour\nfive\n')
const entryOf = (ctx: { readFileState: Map<string, Entry> }): Entry | undefined => {
  for (const [path, entry] of ctx.readFileState.entries()) if (path.endsWith('five.ts')) return entry
  return undefined
}

console.log('L1 a window larger than the file is a full read')
{
  const ctx = makeCtx()
  await FileReadTool.call({ file_path: file, limit: 5000 } as never, ctx as never)
  const entry = entryOf(ctx)
  check('the read registered', entry !== undefined && entry.content.includes('three'))
  check('offset 0, no limit — a full-read entry', entry?.offset === 0 && entry?.limit === undefined, JSON.stringify({ offset: entry?.offset, limit: entry?.limit }))
}

console.log('L2 a window that does not cover the file stays partial')
{
  const ctx = makeCtx()
  await FileReadTool.call({ file_path: file, offset: 2, limit: 2 } as never, ctx as never)
  const entry = entryOf(ctx)
  check('the window is recorded', entry?.limit === 2 && entry?.offset === 2, JSON.stringify({ offset: entry?.offset, limit: entry?.limit }))
}

console.log('L3 the compact restore road registers a full read')
{
  const ctx = makeCtx()
  const attachment = await generateFileAttachment(file, ctx as never, 'compact', { limit: compact.POST_COMPACT_MAX_TOKENS_PER_FILE })
  check('the restore produced a file attachment', (attachment as { type?: string } | null)?.type === 'file', JSON.stringify(attachment)?.slice(0, 120))
  const entry = entryOf(ctx)
  check('the restored entry is a full read (the edit fallback applies)', entry !== undefined && entry.offset === 0 && entry.limit === undefined, JSON.stringify({ offset: entry?.offset, limit: entry?.limit }))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-restored-read-is-full: ALL PASS' : `\nprove-restored-read-is-full: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
