#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'repeated-target-home-'))
process.env.MERCURY_SIMPLE = '1'
const csHome = mkdtempSync(path.join(tmpdir(), 'repeated-target-cs-'))
process.env.MERCURY_CHANGESET_DIR = csHome

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const OUTER_BOUND_MS = 4_000
type Bounded<T> = { wedged: true; elapsedMs: number } | { wedged: false; elapsedMs: number; value?: T; error?: unknown }
async function bounded<T>(work: Promise<T>): Promise<Bounded<T>> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  const outer = new Promise<{ wedged: true }>(resolve => {
    timer = setTimeout(() => resolve({ wedged: true }), OUTER_BOUND_MS)
  })
  const settled = work.then(
    value => ({ wedged: false as const, value }),
    (error: unknown) => ({ wedged: false as const, error }),
  )
  const outcome = await Promise.race([settled, outer])
  if (timer !== null) clearTimeout(timer)
  return { ...outcome, elapsedMs: Date.now() - started }
}
const wedgedDetail = (o: Bounded<unknown>): string =>
  o.wedged ? `still pending after ${OUTER_BOUND_MS}ms` : `${o.elapsedMs}ms${'error' in o && o.error ? ` ${String((o.error as Error).message ?? o.error)}` : ''}`

const { runTextChangeSetCommit, commitPlanDigest } = await import(
  '../../src/services/changeTransaction/changeSetCommit.ts'
)
const { sha256Hex } = await import('../../src/services/changeTransaction/changeSetPlan.ts')

section('§1 the commit core refuses a repeated target by name — never a wedge')
{
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'repeated-target-files-')))
  const file = path.join(dir, 'a.ts')
  writeFileSync(file, 'const a = 1\n')
  const targetFor = (to: string) => {
    const originalBytes = readFileSync(file)
    const plannedBytes = Buffer.from(to, 'utf8')
    return {
      canonicalPath: file,
      originalDigest: sha256Hex(originalBytes),
      plannedDigest: sha256Hex(plannedBytes),
      originalBytes,
      plannedBytes,
      mode: 0o644,
    }
  }
  const journalDir = path.join(csHome, 'journal')
  const bundleRoot = path.join(csHome, 'bundles')

  const twice = [targetFor('const a = 2\n'), targetFor('const a = 2\n')]
  const repeated = await bounded(
    runTextChangeSetCommit({
      ownerKey: 'owner-repeated',
      source: 'changeset',
      planDigest: commitPlanDigest(twice),
      targets: twice,
      journalDir,
      bundleRoot,
    }),
  )
  check(
    'a set naming one canonical path twice is refused by name, in milliseconds',
    !repeated.wedged &&
      repeated.error instanceof Error &&
      /appears more than once/.test(repeated.error.message) &&
      repeated.error.message.includes(file),
    wedgedDetail(repeated),
  )
  check('nothing was written', readFileSync(file, 'utf8') === 'const a = 1\n')

  const once = [targetFor('const a = 3\n')]
  const later = await bounded(
    runTextChangeSetCommit({
      ownerKey: 'owner-later',
      source: 'changeset',
      planDigest: commitPlanDigest(once),
      targets: once,
      journalDir,
      bundleRoot,
    }),
  )
  check(
    'a later single-target commit to the same path lands (no orphaned lock chain)',
    !later.wedged && later.value?.kind === 'committed' && readFileSync(file, 'utf8') === 'const a = 3\n',
    wedgedDetail(later),
  )
  rmSync(dir, { recursive: true, force: true })
}

section('§2 the LSP apply folds two spellings of one document into one target')
{
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { runMercuryLspOp } = await import('../../src/tools/LSPTool/mercuryOps.js')

  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'repeated-target-lsp-')))
  const target = path.join(dir, 'target.ts')
  writeFileSync(target, 'const abc = 1\nconst def = abc\n')
  const plain = pathToFileURL(target).href
  const encoded = plain.replace(/target\.ts$/, 't%61rget.ts')
  check('the fixture really spells one file two ways', encoded !== plain && encoded.endsWith('t%61rget.ts'))
  const line0 = { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'xyz' }
  const line1 = { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } }, newText: 'xyz' }

  const savedFiles: string[] = []
  const manager = {
    isFileOpen: () => false,
    openFile: async () => {},
    changeFile: async () => {},
    saveFile: async (f: string) => {
      savedFiles.push(f)
    },
    changeAndSaveFile: async (f: string) => {
      savedFiles.push(f)
    },
    getServerForFile: () => undefined,
    sendRequest: async (_file: string, method: string) => {
      if (method === 'textDocument/rename') return { changes: { [plain]: [line0], [encoded]: [line1, line0] } }
      return undefined
    },
  }
  const tool = { name: 'LSP', getPath: (i: { filePath: string }) => i.filePath }
  const permissionContext = {
    mode: 'implement',
    additionalWorkingDirectories: new Map([[dir, { path: dir, source: 'session' }]]),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    shouldAvoidPermissionPrompts: false,
  }
  const context = { getAppState: () => ({ toolPermissionContext: permissionContext }) }

  const applied = await bounded(
    runMercuryLspOp({
      input: { operation: 'rename', filePath: target, line: 1, character: 7, newName: 'xyz', apply: true },
      absolutePath: target,
      cwd: dir,
      manager: manager as never,
      tool: tool as never,
      context: context as never,
    }),
  )
  const after = readFileSync(target, 'utf8')
  check(
    'the apply returns applied — both spellings folded into one target',
    !applied.wedged && applied.value?.applied === true,
    wedgedDetail(applied),
  )
  check(
    'both edit sets landed and the shared edit landed once',
    after === 'const xyz = 1\nconst def = xyz\n',
    JSON.stringify(after),
  )
  check('one document was notified once', savedFiles.length === 1, `saved=${savedFiles.length}`)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' prove-changeset-repeated-target: all green' : ` prove-changeset-repeated-target: ${failures} FAILURE(S)`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
