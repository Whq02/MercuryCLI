#!/usr/bin/env bun
// prove-lsp-rename-fanout — the pathRename willRenameFiles fan-out (parity
// spec 04 C1 + the acceptance criterion "renaming updates imports across
// two mock servers with the coalescing rule byte-asserted"):
//   F. BOTH claimants of the file type are asked workspace/willRenameFiles
//      (contract data), their edit sets merge, and the byte result proves
//      the coalescing rule: the precedence claimant wins the OVERLAP, the
//      later claimant keeps its disjoint edit, the yield is surfaced
//   D. workspace/didRenameFiles notifies EVERY advertising claimant after
//      the move
//   P. preview (apply omitted) computes the same fan-out and writes NOTHING
//   R. a DIRECTORY rename finds its claimants through the contained files'
//      extensions, moves the tree, remaps read-state, and notifies
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(import.meta.dir, '../..')
const scripted = path.join(repo, 'scripts/lsp/fixtures/scripted-rename-server.mjs')

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-fanout-')))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'lsp-fanout-home-'))
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(path.join(tmpdir(), 'lsp-fanout-cs-'))
delete process.env.MERCURY_LSP
process.chdir(scratch)

const importsFile = path.join(scratch, 'imports.zz')
writeFileSync(importsFile, "import OLD from './moving'\nimport OLD2 from './moving'\n")
const movingFile = path.join(scratch, 'moving.zz')
writeFileSync(movingFile, 'export const thing = 1\n')
const importsUri = pathToFileURL(importsFile).href

const logA = path.join(scratch, 'a.log')
const logB = path.join(scratch, 'b.log')
const logC = path.join(scratch, 'c.log')
const CAPS = JSON.stringify({ workspace: { fileOperations: { willRename: {}, didRename: {} } } })
const editsA = JSON.stringify({
  changes: {
    [importsUri]: [
      { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } }, newText: 'AAA' },
    ],
  },
})
const editsB = JSON.stringify({
  changes: {
    [importsUri]: [
      // Overlaps A's edit — must YIELD to the precedence claimant.
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: 'XXX' },
      // Disjoint — must land.
      { range: { start: { line: 1, character: 7 }, end: { line: 1, character: 11 } }, newText: 'BBBB' },
    ],
  },
})

process.env.MERCURY_LSP_SERVERS = JSON.stringify({
  serverA: {
    command: process.execPath,
    args: [scripted],
    extensionToLanguage: { '.zz': 'zed' },
    env: { RENAME_CAPS: CAPS, RENAME_EDITS: editsA, RENAME_LOG: logA },
  },
  serverB: {
    command: process.execPath,
    args: [scripted],
    extensionToLanguage: { '.zz': 'zed' },
    env: { RENAME_CAPS: CAPS, RENAME_EDITS: editsB, RENAME_LOG: logB },
  },
  serverC: {
    command: process.execPath,
    args: [scripted],
    extensionToLanguage: { '.yy': 'yed' },
    env: { RENAME_CAPS: CAPS, RENAME_EDITS: 'null', RENAME_LOG: logC },
  },
})

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const mgrModule = await import('../../src/services/lsp/manager.js')
mgrModule.initializeLspServerManager()
await mgrModule.waitForInitialization()
const manager = mgrModule.getLspServerManager()!
const { runMercuryLspOp } = await import('../../src/tools/LSPTool/mercuryOps.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')

const permCtx = {
  ...getEmptyToolPermissionContext(),
  additionalWorkingDirectories: new Map([[scratch, { source: 'session' }]]),
}
const readFileState = new Map<string, { content: string; timestamp: number }>()
const ctx = {
  readFileState,
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: permCtx }),
} as never

const drive = (input: Record<string, unknown>, absolutePath: string) =>
  runMercuryLspOp({
    input: input as never,
    absolutePath,
    cwd: scratch,
    manager,
    tool: { name: 'LSP', getPath: (i: { filePath?: string } | undefined) => i?.filePath } as never,
    context: ctx,
  })

const logLines = (p: string): string[] => {
  try {
    return readFileSync(p, 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

console.log('— P. preview computes the fan-out, writes nothing —')
{
  const before = readFileSync(importsFile, 'utf8')
  const r = await drive({ operation: 'pathRename', filePath: movingFile, newPath: path.join(scratch, 'moved.zz') }, movingFile)
  check('preview names both claimants', /serverA \+ .*serverB|env:serverA \+ env:serverB/.test(r.result), r.result.slice(0, 240))
  check('preview surfaces the overlap yield', /yielded to/.test(r.result), r.result.slice(0, 400))
  check('preview writes nothing, moves nothing', readFileSync(importsFile, 'utf8') === before && existsSync(movingFile))
  check('both servers were ASKED willRenameFiles', logLines(logA).includes('workspace/willRenameFiles') && logLines(logB).includes('workspace/willRenameFiles'))
}

console.log('— F. the applied fan-out, byte-asserted —')
{
  const moved = path.join(scratch, 'moved.zz')
  const r = await drive({ operation: 'pathRename', filePath: movingFile, newPath: moved, apply: true }, movingFile)
  check('apply succeeded', r.effect.outcome === 'succeeded', r.result.slice(0, 300))
  check('the file moved', !existsSync(movingFile) && existsSync(moved))
  const after = readFileSync(importsFile, 'utf8')
  check(
    'coalescing byte-assert: precedence claimant wins the overlap, the disjoint edit lands',
    after === "import AAA from './moving'\nimport BBBB from './moving'\n",
    JSON.stringify(after),
  )
  check('the yield note names the loser and the winner', /serverB: 1 overlapping edit\(s\).*yielded/.test(r.result), r.result.slice(0, 400))
  check('changedPaths carries the import file + both endpoints', r.effect.changedPaths.length === 3, JSON.stringify(r.effect.changedPaths))
}

console.log('— D. didRenameFiles fans to every advertising claimant —')
{
  const a = logLines(logA)
  const b = logLines(logB)
  check('serverA notified', a.includes('workspace/didRenameFiles'), a.join(','))
  check('serverB notified', b.includes('workspace/didRenameFiles'), b.join(','))
}

console.log('— R. directory rename claims through contained extensions —')
{
  const dir = path.join(scratch, 'pkg')
  mkdirSync(dir)
  const inner = path.join(dir, 'inner.yy')
  writeFileSync(inner, 'y\n')
  readFileState.set(inner, { content: 'y\n', timestamp: Date.now() })
  const dest = path.join(scratch, 'pkg2')
  const r = await drive({ operation: 'pathRename', filePath: dir, newPath: dest, apply: true }, dir)
  check('directory move succeeded', r.effect.outcome === 'succeeded', r.result.slice(0, 300))
  check('the tree moved', !existsSync(dir) && existsSync(path.join(dest, 'inner.yy')))
  // Notification delivery is async by protocol design — poll briefly.
  let c = logLines(logC)
  for (let i = 0; i < 40 && !c.includes('workspace/didRenameFiles'); i++) {
    await new Promise(r => setTimeout(r, 50))
    c = logLines(logC)
  }
  check('the contained-extension claimant was asked and notified', c.includes('workspace/willRenameFiles') && c.includes('workspace/didRenameFiles'), c.join(','))
  check('read-state followed the tree', readFileState.has(path.join(dest, 'inner.yy')) && !readFileState.has(inner))
}

await mgrModule.shutdownLspServerManager()
console.log('')
if (failures > 0) {
  console.error(`prove-lsp-rename-fanout: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-rename-fanout: GREEN — every claimant asked, overlaps yield to precedence, notifications fan out')
