#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
process.env.MERCURY_CONFIG_DIR = path.join(scratch, 'home')
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
process.env.MERCURY_CHANGESET_DIR = path.join(scratch, 'changesets')
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
const responseB = path.join(scratch, 'response-b.json')
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
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: 'XXX' },
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
    env: { RENAME_CAPS: CAPS, RENAME_EDITS: editsB, RENAME_LOG: logB, RENAME_RESPONSE_FILE: responseB },
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

const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(scratch)
const permCtx = getEmptyToolPermissionContext()
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
  readFileState.set(importsFile, { content: readFileSync(importsFile, 'utf8'), timestamp: Date.now() })
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
  let c = logLines(logC)
  for (let i = 0; i < 40 && !c.includes('workspace/didRenameFiles'); i++) {
    await new Promise(r => setTimeout(r, 50))
    c = logLines(logC)
  }
  check('the contained-extension claimant was asked and notified', c.includes('workspace/willRenameFiles') && c.includes('workspace/didRenameFiles'), c.join(','))
  check('read-state followed the tree', readFileState.has(path.join(dest, 'inner.yy')) && !readFileState.has(inner))
}

console.log('— X. a participating failure aborts the whole move —')
const invalidResponses = [
  ['throwing', { error: { code: -32603, message: 'fixture refuses the rename' } }, /fixture refuses the rename/],
  ['malformed-document', { result: { documentChanges: [null] } }, /malformed/],
  ['malformed-changes', { result: { changes: { [importsUri]: 'not an edit list' } } }, /malformed/],
  ['malformed-range', { result: { changes: { [importsUri]: [{ newText: 'bad' }] } } }, /malformed/],
  ['malformed-result', { result: 7 }, /malformed/],
] as const
for (const [name, response, reason] of invalidResponses) {
  writeFileSync(responseB, JSON.stringify(response))
  for (const apply of [false, true]) {
    const source = path.join(scratch, `${name}-${apply}.zz`)
    const destination = path.join(scratch, `${name}-${apply}-moved.zz`)
    writeFileSync(source, 'export const untouched = 1\n')
    writeFileSync(importsFile, "import OLD from './moving'\nimport OLD2 from './moving'\n")
    const originals = new Map([source, importsFile, path.join(scratch, 'moved.zz'), path.join(scratch, 'pkg2/inner.yy')]
      .map(file => [file, readFileSync(file)]))
    readFileState.set(importsFile, { content: readFileSync(importsFile, 'utf8'), timestamp: Date.now() })
    const aRequests = logLines(logA).filter(line => line === 'workspace/willRenameFiles').length
    const bRequests = logLines(logB).filter(line => line === 'workspace/willRenameFiles').length
    const notifications = [logA, logB].map(log => logLines(log).filter(line => line === 'workspace/didRenameFiles').length)
    let r: Awaited<ReturnType<typeof drive>> | undefined
    try {
      r = await drive({ operation: 'pathRename', filePath: source, newPath: destination, apply }, source)
    } catch (error) {
      check(`${name}/${apply}: returns a typed failure`, false, String(error))
    }
    check(`${name}/${apply}: both participants were asked`,
      logLines(logA).filter(line => line === 'workspace/willRenameFiles').length > aRequests &&
      logLines(logB).filter(line => line === 'workspace/willRenameFiles').length > bRequests)
    check(`${name}/${apply}: abort names the failed participant and error`,
      r?.effect.outcome === 'failed' && /serverB/.test(r.result) && reason.test(r.result), r?.result)
    check(`${name}/${apply}: result promises unchanged files`, /all files (?:are )?unchanged/i.test(r?.result ?? ''), r?.result)
    check(`${name}/${apply}: every file is byte-identical and no destination exists`,
      [...originals].every(([file, bytes]) => existsSync(file) && readFileSync(file).equals(bytes)) && !existsSync(destination))
    check(`${name}/${apply}: no changed paths or rename notifications`,
      r?.effect.changedPaths.length === 0 && [logA, logB].every((log, i) =>
        logLines(log).filter(line => line === 'workspace/didRenameFiles').length === notifications[i]))
  }
}

await mgrModule.shutdownLspServerManager()
process.chdir(repo)
rmSync(scratch, { recursive: true, force: true })
console.log('')
if (failures > 0) {
  console.error(`prove-lsp-rename-fanout: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-rename-fanout: GREEN — every claimant asked, overlaps yield to precedence, notifications fan out')
