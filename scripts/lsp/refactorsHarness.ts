import { cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

export type Checker = {
  check: (name: string, ok: boolean, detail?: string) => void
  section: (title: string) => void
  finish: () => never
}

export function makeChecker(label: string): Checker {
  let failures = 0
  return {
    check(name, ok, detail) {
      if (ok) console.log(`  ok  ${name}`)
      else {
        failures++
        console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
      }
    },
    section(title) {
      console.log(`\n${title}`)
    },
    finish() {
      if (failures > 0) {
        console.error(`${label}: RED (${failures})`)
        process.exit(1)
      }
      console.log(`${label}: GREEN`)
      process.exit(0)
    },
  }
}

export type OpInput = Record<string, unknown> & { operation: string }

export type OpOutput = {
  result: string
  resultCount?: number
  fileCount?: number
  applied?: boolean
  effect: { outcome: string; changedPaths: string[]; evidence: string; details?: Record<string, unknown> }
  edits?: Array<{
    file: string
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
    before: string
    after: string
  }>
  plan?: string
}

export type Workspace = {
  root: string
  abs: (rel: string) => string
  text: (rel: string) => string
  digest: (rel: string) => string
  digests: (rels: string[]) => Record<string, string>
  position: (rel: string, needle: string, occurrence?: number) => { line: number; character: number }
  read: (rel: string) => void
  readFileState: Map<string, { content: string; timestamp: number; offset: number | undefined; limit: number | undefined }>
  fileHistory: () => { snapshots: Array<{ trackedFileBackups: Record<string, unknown> }> }
  op: (input: OpInput, rel?: string) => Promise<OpOutput>
  planOf: (output: OpOutput) => string | undefined
  shutdown: () => Promise<void>
}

export async function bootWorkspace(messageId?: string): Promise<Workspace> {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const repo = path.resolve(import.meta.dir, '../..')
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-refactors-')))
  const root = path.join(scratch, 'ws')
  mkdirSync(root)
  for (const fixture of ['refactors', 'refactors-js']) {
    cpSync(path.join(repo, 'scripts/lsp/fixtures', fixture), path.join(root, fixture), { recursive: true })
  }
  symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  const home = path.join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_CHANGESET_DIR = path.join(scratch, 'changesets')
  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_LSP_SERVERS
  process.env.MERCURY_LSP_SIDECAR_ENTRY = path.join(repo, 'src/services/lsp/tsSidecar/entry.ts')
  process.chdir(root)

  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const state = await import('../../src/bootstrap/state.js')
  state.setIsInteractive(true)
  const mgrModule = await import('../../src/services/lsp/manager.js')
  mgrModule.initializeLspServerManager()
  await mgrModule.waitForInitialization()
  const manager = mgrModule.getLspServerManager()
  if (!manager) throw new Error(`manager init failed: ${JSON.stringify(mgrModule.getInitializationStatus())}`)
  const { runMercuryLspOp } = await import('../../src/tools/LSPTool/mercuryOps.js')
  const { LSPTool } = await import('../../src/tools/LSPTool/LSPTool.js')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')

  const readFileState = new Map<string, { content: string; timestamp: number; offset: number | undefined; limit: number | undefined }>()
  let fileHistoryState = {
    snapshots: [{ messageId: messageId ?? 'none', trackedFileBackups: {} as Record<string, unknown>, timestamp: new Date() }],
    trackedFiles: new Set<string>(),
    snapshotSequence: 1,
  }
  const permission = {
    ...getEmptyToolPermissionContext(),
    additionalWorkingDirectories: new Map([[root, { path: root, source: 'cliArg' }]]),
  }
  const context = {
    abortController: new AbortController(),
    readFileState,
    getAppState: () => ({ toolPermissionContext: permission }),
    setAppState: () => {},
    updateFileHistoryState: (updater: (prev: typeof fileHistoryState) => typeof fileHistoryState) => {
      fileHistoryState = updater(fileHistoryState)
    },
    updateAttributionState: () => {},
    messages: [],
    setResponseLength: () => {},
    agentId: undefined,
    options: { tools: [], isNonInteractiveSession: false },
  }

  const abs = (rel: string): string => path.resolve(root, rel)
  const text = (rel: string): string => readFileSync(abs(rel), 'utf8')
  const digest = (rel: string): string => createHash('sha256').update(readFileSync(abs(rel))).digest('hex')
  return {
    root,
    abs,
    text,
    digest,
    digests: rels => Object.fromEntries(rels.map(rel => [rel, digest(rel)])),
    position(rel, needle, occurrence = 0) {
      const content = text(rel)
      let index = -1
      for (let i = 0; i <= occurrence; i++) {
        index = content.indexOf(needle, index + 1)
        if (index === -1) throw new Error(`fixture drift: '${needle}' occurrence ${occurrence} not in ${rel}`)
      }
      const before = content.slice(0, index)
      const line = (before.match(/\n/g) ?? []).length + 1
      const character = index - (before.lastIndexOf('\n') + 1) + 1
      return { line, character }
    },
    read(rel) {
      const file = abs(rel)
      readFileState.set(file, {
        content: readFileSync(file, 'utf8'),
        timestamp: Math.floor(statSync(file).mtimeMs),
        offset: undefined,
        limit: undefined,
      })
    },
    readFileState,
    fileHistory: () => fileHistoryState,
    op: (input, rel) =>
      runMercuryLspOp({
        input: input as never,
        absolutePath: rel !== undefined ? abs(rel) : root,
        cwd: root,
        manager,
        tool: LSPTool as never,
        context: context as never,
        ...(messageId !== undefined ? { messageId: messageId as never } : {}),
      }) as Promise<OpOutput>,
    planOf: output => output.plan ?? /plan: (lsp-[0-9a-f]{12})/.exec(output.result)?.[1],
    shutdown: () => mgrModule.shutdownLspServerManager(),
  }
}

export function touch(file: string, content: string): void {
  writeFileSync(file, content)
}
