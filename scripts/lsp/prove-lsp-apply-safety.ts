// prove-lsp-apply-safety — table-tests the PURE WorkspaceEdit math
// (src/services/lsp/workspaceEditApply.ts) that the rename/codeActions apply
// path rides, plus the drift-abort + permission + partial-write contracts of
// the PRODUCTION mercuryOps pipeline driven through injected fakes (a fake
// LSPServerManager + a fake tool/context) — the real functions, not a
// reimplementation.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  applyEditsToText,
  formatEditPreview,
  normalizeWorkspaceEdit,
  offsetAtPosition,
} from '../../src/services/lsp/workspaceEditApply.js'

// F6 hygiene: production applies journal under the change-set home —
// pin it to a fixture dir so this proof never touches the operator machine.
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(path.join(tmpdir(), 'lsp-apply-cs-'))

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

//
// normalizeWorkspaceEdit
//

{
  const r = normalizeWorkspaceEdit({
    changes: { 'file:///a.ts': [{ range: r0(), newText: 'x' }] },
  })
  check('normalize: plain changes accepted', r.ok && r.files.length === 1)
}
{
  const r = normalizeWorkspaceEdit({
    documentChanges: [
      { textDocument: { uri: 'file:///a.ts', version: 3 }, edits: [{ range: r0(), newText: 'x' }] },
    ],
  })
  check('normalize: TextDocumentEdit accepted (version asserts ignored)', r.ok)
}
{
  const r = normalizeWorkspaceEdit({
    documentChanges: [{ kind: 'rename', oldUri: 'file:///a', newUri: 'file:///b' }],
  })
  check(
    'normalize: resource op REFUSED with named reason',
    !r.ok && !r.ok && (r as { reason: string }).reason.includes("resource operation 'rename'"),
  )
}
{
  const r = normalizeWorkspaceEdit({})
  check('normalize: empty edit refused', !r.ok)
}
{
  const r = normalizeWorkspaceEdit(null)
  check('normalize: null edit refused', !r.ok)
}

//
// applyEditsToText
//

{
  const text = 'const alpha = 1\nconst beta = alpha + alpha\n'
  const edits = [
    { range: rangeOf(text, 'alpha', 0), newText: 'omega' },
    { range: rangeOf(text, 'alpha', 1), newText: 'omega' },
    { range: rangeOf(text, 'alpha', 2), newText: 'omega' },
  ]
  // Shuffle order — application must be order-independent (sorted desc).
  const r = applyEditsToText(text, [edits[2]!, edits[0]!, edits[1]!])
  check(
    'apply: 3 same-file edits, shuffled input order, all land',
    r.ok && r.text === 'const omega = 1\nconst beta = omega + omega\n' && r.editCount === 3,
    r.ok ? r.text : r.reason,
  )
}
{
  const text = 'ab\ncd\n'
  const overlap = [
    { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } }, newText: 'X' },
    { range: { start: { line: 0, character: 1 }, end: { line: 1, character: 2 } }, newText: 'Y' },
  ]
  const r = applyEditsToText(text, overlap)
  check('apply: overlapping edits REFUSED', !r.ok && (r as { reason: string }).reason.includes('overlapping'))
}
{
  const text = 'line1\r\nline2\r\n'
  const r = applyEditsToText(text, [
    { range: rangeOf(text, 'line2'), newText: 'LINE2' },
  ])
  check('apply: CRLF text edits at correct offsets', r.ok && r.text === 'line1\r\nLINE2\r\n')
}
{
  const text = 'abc'
  check(
    'offsetAtPosition: clamps past-EOF line/char',
    offsetAtPosition(text, { line: 99, character: 99 }) === 3 &&
      offsetAtPosition(text, { line: 0, character: 99 }) === 3,
  )
}
{
  // Same-position pure insertions are tolerated adjacency.
  const text = 'ab'
  const r = applyEditsToText(text, [
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: 'X' },
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: 'Y' },
  ])
  check('apply: insertion adjacent to replacement allowed', r.ok && r.text === 'aXY')
}

//
// formatEditPreview — honest truncation
//

{
  const text = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i}`).join('\n')
  const edits = Array.from({ length: 20 }, (_, i) => ({
    range: rangeOf(text, `v${i} `),
    newText: `w${i} `,
  }))
  const preview = formatEditPreview(
    [{ uri: 'file:///big.ts', edits }],
    () => text,
    () => 'big.ts',
  )
  check(
    'preview: caps per-file lines and SAYS how many were dropped',
    preview.includes('more in this file') && preview.includes('20 edits'),
    preview.split('\n')[0],
  )
}

//
// PRODUCTION pipeline: drift-abort / permission refuse / post-write sync —
// runMercuryLspOp with injected fakes (real functions, fake I/O boundary).
//

// The write-permission path reaches config-backed feature gates
// (isScratchpadPath → the feature-gate cache) — arm the config latch first, the
// same call the daemon/bridge entrypoints make before permission work.
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const { runMercuryLspOp } = await import('../../src/tools/LSPTool/mercuryOps.js')

function fakeEnvFor(dir: string, opts: {
  renameEditFor: (file: string) => { changes: Record<string, { range: ReturnType<typeof r0>; newText: string }[]> }
  ctx?: unknown
}) {
  const target = path.join(dir, 'target.ts')
  const synced: string[] = []
  const savedFiles: string[] = []
  const manager = {
    isFileOpen: () => false,
    openFile: async () => {
      synced.push('open')
    },
    changeFile: async () => {
      synced.push('change')
    },
    saveFile: async (f: string) => {
      savedFiles.push(f)
    },
    // The sequenced composite (change→save) mercuryOps' post-apply
    // notify now routes through — mirror the real manager's semantics so the
    // proof exercises the production call shape.
    changeAndSaveFile: async (f: string) => {
      synced.push('change')
      savedFiles.push(f)
    },
    getServerForFile: () => undefined,
    sendRequest: async (_file: string, method: string) => {
      if (method === 'textDocument/rename') return opts.renameEditFor(target)
      return undefined
    },
  }
  const tool = { name: 'LSP', getPath: (i: { filePath: string }) => i.filePath }
  const context = {
    getAppState: () => ({ toolPermissionContext: opts.ctx ?? PERMISSIVE_CTX }),
  }
  return { target, manager, tool, context, savedFiles }
}

// Permission outcomes are driven through the REAL checkWritePermissionForTool
// with REAL ToolPermissionContext shapes: implement mode + a file inside the
// process cwd ⇒ allow (the same path the live implement mode takes);
// default mode ⇒ ask ⇒ the apply pipeline must refuse before any write.
const PERMISSIVE_CTX = {
  mode: 'implement',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
  shouldAvoidPermissionPrompts: false,
}
const ASKING_CTX = { ...PERMISSIVE_CTX, mode: 'default' }

function scratchDirInCwd(tag: string): string {
  return mkdtempSync(path.join(process.cwd(), `.tmp-lsp-proof-${tag}-`))
}

{
  // Happy path: rename apply writes the file and notifies the server —
  // REAL permission fn, implement mode, file inside process cwd.
  const dir = scratchDirInCwd('apply')
  const env = fakeEnvFor(dir, {
    renameEditFor: file => ({
      changes: {
        [pathToFileURL(file).href]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'xyz' },
        ],
      },
    }),
  })
  writeFileSync(env.target, 'const abc = 1\n')
  const out = await runMercuryLspOp({
    input: { operation: 'rename', filePath: env.target, line: 1, character: 7, newName: 'xyz', apply: true },
    absolutePath: env.target,
    cwd: dir,
    manager: env.manager as never,
    tool: env.tool as never,
    context: env.context as never,
  })
  const after = readFileSync(env.target, 'utf8')
  check(
    'production apply: writes edits + reports applied',
    out.applied === true && after === 'const xyz = 1\n' && env.savedFiles.length === 1,
    `applied=${out.applied} text=${JSON.stringify(after)}`,
  )
  rmSync(dir, { recursive: true, force: true })
}

{
  // Drift-abort: disk changes AFTER the snapshot round but BEFORE apply's
  // re-read ⇒ NOTHING written. Sequence inside prepareApply: request №1 →
  // sync (snapshot = clean) → request №2 (stabilization) → return; the
  // fake mutates disk during request №2, landing the drift exactly in the
  // snapshot→verify window the contract must catch.
  const dir = scratchDirInCwd('drift')
  const env = fakeEnvFor(dir, {
    renameEditFor: file => ({
      changes: {
        [pathToFileURL(file).href]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'xyz' },
        ],
      },
    }),
  })
  writeFileSync(env.target, 'const abc = 1\n')
  let renameCalls = 0
  const origSend = env.manager.sendRequest
  env.manager.sendRequest = async (f: string, m: string) => {
    const r = await origSend(f, m)
    if (m === 'textDocument/rename') {
      renameCalls++
      if (renameCalls === 2) {
        writeFileSync(env.target, 'const abc = 1 // drifted\n')
      }
    }
    return r
  }
  const out = await runMercuryLspOp({
    input: { operation: 'rename', filePath: env.target, line: 1, character: 7, newName: 'xyz', apply: true },
    absolutePath: env.target,
    cwd: dir,
    manager: env.manager as never,
    tool: env.tool as never,
    context: env.context as never,
  })
  const after = readFileSync(env.target, 'utf8')
  check(
    'production apply: DRIFT ABORTS with nothing written',
    out.applied === false &&
      out.result.includes('drift') &&
      after === 'const abc = 1 // drifted\n',
    `applied=${out.applied} result=${out.result.slice(0, 80)}`,
  )
  rmSync(dir, { recursive: true, force: true })
}

{
  // DEFAULT mode, in-scope: reaching call() means the harness permission
  // layer already approved this apply (the operator clicked allow on the
  // Edit-class prompt) — the raw re-check's 'ask' must NOT kill it (the
  // audit's permission-mode finding: the pre-fix pipeline refused approved
  // applies in default and bypass modes, making the feature implement-only).
  const dir = scratchDirInCwd('approved')
  const env = fakeEnvFor(dir, {
    ctx: ASKING_CTX,
    renameEditFor: file => ({
      changes: {
        [pathToFileURL(file).href]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'xyz' },
        ],
      },
    }),
  })
  writeFileSync(env.target, 'const abc = 1\n')
  const out = await runMercuryLspOp({
    input: { operation: 'rename', filePath: env.target, line: 1, character: 7, newName: 'xyz', apply: true },
    absolutePath: env.target,
    cwd: dir,
    manager: env.manager as never,
    tool: env.tool as never,
    context: env.context as never,
  })
  const after = readFileSync(env.target, 'utf8')
  check(
    'production apply: default mode + approved prompt + in-scope ⇒ APPLIES',
    out.applied === true && after === 'const xyz = 1\n',
    `applied=${out.applied} result=${out.result.slice(0, 90)}`,
  )
  rmSync(dir, { recursive: true, force: true })
}

{
  // OUT-OF-SCOPE stays refused in EVERY mode — one approval can never ride
  // a server's WorkspaceEdit to a file outside cwd+additional dirs.
  const dir = scratchDirInCwd('scope')
  const outside = mkdtempSync(path.join(tmpdir(), 'lsp-outside-'))
  const outsideFile = path.join(outside, 'victim.ts')
  writeFileSync(outsideFile, 'const abc = 1\n')
  const env = fakeEnvFor(dir, {
    ctx: PERMISSIVE_CTX, // even implement mode must not cross the scope
    renameEditFor: () => ({
      changes: {
        [pathToFileURL(outsideFile).href]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'xyz' },
        ],
      },
    }),
  })
  writeFileSync(env.target, 'const abc = 1\n')
  const out = await runMercuryLspOp({
    input: { operation: 'rename', filePath: env.target, line: 1, character: 7, newName: 'xyz', apply: true },
    absolutePath: env.target,
    cwd: dir,
    manager: env.manager as never,
    tool: env.tool as never,
    context: env.context as never,
  })
  check(
    'production apply: OUT-OF-SCOPE target ⇒ REFUSED, nothing written',
    out.applied === false &&
      out.result.includes('outside the session') &&
      readFileSync(outsideFile, 'utf8') === 'const abc = 1\n',
    `applied=${out.applied} result=${out.result.slice(0, 100)}`,
  )
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

{
  // Explicit DENY rules are absolute — they beat implement mode and scope.
  const dir = scratchDirInCwd('deny')
  // Deny-rule content is filesystem-anchored with the `//` prefix (a single
  // leading `/` on an already-absolute dir → `//Users/...`), matching how the
  // permission parser resolves absolute deny patterns to root.
  const env = fakeEnvFor(dir, {
    ctx: {
      ...PERMISSIVE_CTX,
      alwaysDenyRules: { session: [`Edit(/${dir}/**)`] },
    },
    renameEditFor: file => ({
      changes: {
        [pathToFileURL(file).href]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'xyz' },
        ],
      },
    }),
  })
  writeFileSync(env.target, 'const abc = 1\n')
  const out = await runMercuryLspOp({
    input: { operation: 'rename', filePath: env.target, line: 1, character: 7, newName: 'xyz', apply: true },
    absolutePath: env.target,
    cwd: dir,
    manager: env.manager as never,
    tool: env.tool as never,
    context: env.context as never,
  })
  check(
    'production apply: DENY rule ⇒ REFUSED even in implement mode, nothing written',
    out.applied === false &&
      out.result.includes('deny rule') &&
      readFileSync(env.target, 'utf8') === 'const abc = 1\n',
    `applied=${out.applied} result=${out.result.slice(0, 100)}`,
  )
  rmSync(dir, { recursive: true, force: true })
}

{
  // Non-stabilizing edit set (audit finding #1): a server that widens the
  // touched-file set EVERY round must exhaust the budget and refuse — the
  // only legitimate success exit is a response whose whole set was already
  // synced. The buggy variant applied from a pre-sync response here.
  const dir = scratchDirInCwd('grow')
  const extra = ['b.ts', 'c.ts', 'd.ts', 'e.ts'].map(n => path.join(dir, n))
  for (const f of extra) writeFileSync(f, 'export const x = 1\n')
  let call = 0
  const env = fakeEnvFor(dir, {
    renameEditFor: file => {
      call++
      const touched = [file, ...extra.slice(0, call)]
      const changes: Record<string, { range: ReturnType<typeof r0>; newText: string }[]> = {}
      for (const t of touched) {
        changes[pathToFileURL(t).href] = [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'xyz' },
        ]
      }
      return { changes }
    },
  })
  writeFileSync(env.target, 'const abc = 1\n')
  const out = await runMercuryLspOp({
    input: { operation: 'rename', filePath: env.target, line: 1, character: 7, newName: 'xyz', apply: true },
    absolutePath: env.target,
    cwd: dir,
    manager: env.manager as never,
    tool: env.tool as never,
    context: env.context as never,
  })
  const untouched =
    readFileSync(env.target, 'utf8') === 'const abc = 1\n' &&
    extra.every(f => readFileSync(f, 'utf8') === 'export const x = 1\n')
  check(
    'production apply: NON-STABILIZING edit set refused, nothing written',
    out.applied !== true && out.result.includes('did not stabilize') && untouched,
    `result=${out.result.slice(0, 90)}`,
  )
  rmSync(dir, { recursive: true, force: true })
}

// Permission ordering + drift ordering are additionally pinned structurally:
{
  const src = readFileSync(
    path.join(path.resolve(import.meta.dir, '../..'), 'src/tools/LSPTool/mercuryOps.ts'),
    'utf8',
  )
  // the write phase IS the shared change-set core — permission
  // precedes the commit walk, and the walk revalidates every target's
  // CURRENT bytes (locks held) before any staging or rename.
  const permIdx = src.indexOf('checkWritePermissionForTool(')
  const commitIdx = src.indexOf('runVerbatimTextCommit(')
  check(
    'structure: per-file permission check precedes the shared commit walk',
    permIdx !== -1 && commitIdx !== -1 && permIdx < commitIdx,
  )
  const core = readFileSync(
    path.join(path.resolve(import.meta.dir, '../..'), 'src/services/changeTransaction/changeSetCommit.ts'),
    'utf8',
  )
  const revalidateIdx = core.indexOf("diskState[i] !== 'original'")
  // the commit-step rename rides the win32 bounded-retry helper now
  // (renameWithWin32Retry) — the pinned invariant is unchanged: current-byte
  // revalidation precedes the (retrying) rename.
  const renameIdx = core.indexOf('await renameWithWin32Retry(')
  check(
    'structure: current-byte revalidation precedes every rename in the shared core',
    revalidateIdx !== -1 && renameIdx !== -1 && revalidateIdx < renameIdx,
  )
}

// helpers
function r0() {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
}
function rangeOf(text: string, needle: string, occurrence = 0) {
  let idx = -1
  for (let i = 0; i <= occurrence; i++) idx = text.indexOf(needle, idx + 1)
  if (idx === -1) throw new Error(`needle ${needle} missing`)
  const before = text.slice(0, idx)
  const line = (before.match(/\n/g) ?? []).length
  const lastNl = before.lastIndexOf('\n')
  const character = idx - (lastNl + 1)
  return {
    start: { line, character },
    end: { line, character: character + needle.length },
  }
}

if (failures > 0) {
  console.error(`prove-lsp-apply-safety: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-apply-safety: GREEN')
