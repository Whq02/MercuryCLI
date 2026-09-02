// prove-lsp-e2e — the IDE-hands bridge's flagship proof AND the committed
// evidence artifact behind MERCURY_LSP's behavioral default-ON (flagRegistry
// row → evidence: scripts/lsp/prove-lsp-e2e.ts).
//
// What it proves, END TO END, against the REAL sidecar (spawned exactly as
// the host spawns it — a child process speaking framed JSON-RPC over stdio,
// driving the workspace's own `typescript`):
//   1. initialize handshake advertises the full IDE-hands capability set
//   2. cross-file goToDefinition lands on the defining file+line
//   3. findReferences sees every use across files
//   4. documentSymbol / workspace/symbol name real symbols
//   5. push diagnostics arrive after didOpen of a broken file (the passive
//      channel the attachment system rides), AND pull diagnostics
//      (textDocument/diagnostic) return the same truth
//   6. rename returns a cross-file WorkspaceEdit with exact edit counts
//   7. codeActions on an unused-import diagnostic carries a literal edit
//   8. hover + call hierarchy answer at real positions
//   9. clean shutdown: exit notification ends the child with code 0
//
// Positions are DERIVED from the fixture text (indexOf), never hardcoded, so
// innocent fixture edits don't rot the proof.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = path.resolve(import.meta.dir, '../..')
const fixtureRoot = path.join(repoRoot, 'scripts/lsp/fixtures/proj')
const entry = path.join(repoRoot, 'src/services/lsp/tsSidecar/entry.ts')
const bun = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`

const libPath = path.join(fixtureRoot, 'src/lib.ts')
const appPath = path.join(fixtureRoot, 'src/app.ts')
const brokenPath = path.join(fixtureRoot, 'src/broken.ts')
const libText = readFileSync(libPath, 'utf8')
const appText = readFileSync(appPath, 'utf8')
const brokenText = readFileSync(brokenPath, 'utf8')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 0-based LSP position of the Nth occurrence of `needle` in `text`. */
function posOf(text: string, needle: string, occurrence = 0): { line: number; character: number } {
  let idx = -1
  for (let i = 0; i <= occurrence; i++) {
    idx = text.indexOf(needle, idx + 1)
    if (idx === -1) throw new Error(`fixture drift: needle '${needle}' occurrence ${occurrence} not found`)
  }
  const before = text.slice(0, idx)
  const line = (before.match(/\n/g) ?? []).length
  const lastNl = before.lastIndexOf('\n')
  return { line, character: idx - (lastNl + 1) }
}

function uriOf(p: string): string {
  return pathToFileURL(p).href
}

// --- minimal framed JSON-RPC client over child stdio ---

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

class SidecarClient {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, Pending>()
  private notificationWaiters: {
    method: string
    predicate: (params: unknown) => boolean
    resolve: (params: unknown) => void
  }[] = []
  readonly notifications: { method: string; params: unknown }[] = []
  exitCode: number | null = null
  private exitWaiters: ((code: number | null) => void)[] = []
  private buffer = Buffer.alloc(0)
  private expected: number | null = null
  stderr = ''

  constructor() {
    this.child = spawn(bun, ['run', entry], {
      cwd: fixtureRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MERCURY_LSP_DEBUG: '0' },
    })
    this.child.stdout.on('data', (c: Buffer) => this.feed(c))
    this.child.stderr.on('data', (c: Buffer) => {
      this.stderr += c.toString('utf8')
    })
    this.child.on('exit', code => {
      this.exitCode = code
      for (const w of this.exitWaiters) w(code)
      this.exitWaiters = []
    })
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.expected === null) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = this.buffer.subarray(0, headerEnd).toString('ascii')
        const m = /content-length:\s*(\d+)/i.exec(header)
        if (!m || !m[1]) throw new Error(`bad header: ${header}`)
        this.expected = Number(m[1])
        this.buffer = this.buffer.subarray(headerEnd + 4)
      }
      if (this.buffer.length < this.expected) return
      const body = this.buffer.subarray(0, this.expected).toString('utf8')
      this.buffer = this.buffer.subarray(this.expected)
      this.expected = null
      const msg = JSON.parse(body) as {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
        error?: { code: number; message: string }
      }
      if (msg.method !== undefined) {
        this.notifications.push({ method: msg.method, params: msg.params })
        this.notificationWaiters = this.notificationWaiters.filter(w => {
          if (w.method === msg.method && w.predicate(msg.params)) {
            w.resolve(msg.params)
            return false
          }
          return true
        })
        continue
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(`rpc ${msg.error.code}: ${msg.error.message}`))
          else p.resolve(msg.result)
        }
      }
    }
  }

  private write(msg: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8')
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new Error(`request ${method} timed out after ${timeoutMs}ms`))
        },
        timeoutMs,
      )
      this.pending.set(id, {
        resolve: v => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean,
    timeoutMs = 20_000,
  ): Promise<unknown> {
    const already = this.notifications.find(n => n.method === method && predicate(n.params))
    if (already) return Promise.resolve(already.params)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`notification ${method} not seen in ${timeoutMs}ms`)),
        timeoutMs,
      )
      this.notificationWaiters.push({
        method,
        predicate,
        resolve: p => {
          clearTimeout(timer)
          resolve(p)
        },
      })
    })
  }

  waitForExit(timeoutMs = 5000): Promise<number | null> {
    if (this.exitCode !== null) return Promise.resolve(this.exitCode)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`child did not exit in ${timeoutMs}ms`)),
        timeoutMs,
      )
      this.exitWaiters.push(code => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  }

  kill(): void {
    try {
      this.child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

interface Loc {
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

async function main(): Promise<void> {
  console.log('prove-lsp-e2e: spawning mercury-ts sidecar against the fixture project')
  const client = new SidecarClient()
  const overallTimer = setTimeout(() => {
    console.error('OVERALL TIMEOUT — dumping state')
    console.error('stderr:', client.stderr)
    client.kill()
    process.exit(1)
  }, 120_000)

  try {
    // 1. initialize
    const init = await client.request<{
      capabilities: Record<string, unknown>
      serverInfo?: { name: string; version?: string }
    }>('initialize', {
      processId: process.pid,
      rootUri: uriOf(fixtureRoot),
      workspaceFolders: [{ uri: uriOf(fixtureRoot), name: 'proj' }],
      initializationOptions: {},
      capabilities: {},
    })
    client.notify('initialized', {})
    check('initialize: serverInfo.name === mercury-ts', init.serverInfo?.name === 'mercury-ts')
    const caps = init.capabilities
    check(
      'initialize: rename+codeAction+diagnostic+callHierarchy capabilities',
      !!caps.renameProvider &&
        !!caps.codeActionProvider &&
        !!caps.diagnosticProvider &&
        caps.callHierarchyProvider === true &&
        caps.definitionProvider === true &&
        caps.referencesProvider === true &&
        caps.workspaceSymbolProvider === true,
      JSON.stringify(Object.keys(caps)),
    )

    // open app.ts
    client.notify('textDocument/didOpen', {
      textDocument: { uri: uriOf(appPath), languageId: 'typescript', version: 1, text: appText },
    })

    // 2. cross-file definition: makeGreeting usage in app.ts → lib.ts
    const useMakeGreeting = posOf(appText, 'makeGreeting(n)')
    const defs = await client.request<Loc[]>('textDocument/definition', {
      textDocument: { uri: uriOf(appPath) },
      position: useMakeGreeting,
    })
    const libDefLine = posOf(libText, 'export function makeGreeting').line
    check(
      'definition: makeGreeting resolves to lib.ts at the defining line',
      defs.length >= 1 &&
        defs.some(d => d.uri === uriOf(libPath) && d.range.start.line === libDefLine),
      JSON.stringify(defs),
    )

    // 3. references: makeGreeting from its definition (decl + app import + 2 calls)
    const refPos = posOf(libText, 'makeGreeting')
    const refs = await client.request<Loc[]>('textDocument/references', {
      textDocument: { uri: uriOf(libPath) },
      position: refPos,
      context: { includeDeclaration: true },
    })
    const refFiles = new Set(refs.map(r => r.uri))
    check(
      'references: ≥4 across both files',
      refs.length >= 4 && refFiles.has(uriOf(libPath)) && refFiles.has(uriOf(appPath)),
      `count=${refs.length} files=${[...refFiles].join(',')}`,
    )

    // 4a. documentSymbol on lib.ts
    const symbols = await client.request<{ name: string; children?: unknown[] }[]>(
      'textDocument/documentSymbol',
      { textDocument: { uri: uriOf(libPath) } },
    )
    const symbolNames = symbols.map(s => s.name)
    check(
      'documentSymbol: Greeting + makeGreeting + shoutGreeting',
      ['Greeting', 'makeGreeting', 'shoutGreeting'].every(n => symbolNames.includes(n)),
      symbolNames.join(','),
    )

    // 4b. workspace/symbol
    const wsSymbols = await client.request<{ name: string; location: Loc }[]>(
      'workspace/symbol',
      { query: 'Greeting' },
    )
    check(
      'workspace/symbol: finds Greeting-family symbols',
      wsSymbols.length >= 2 && wsSymbols.some(s => s.name === 'Greeting'),
      `count=${wsSymbols.length}`,
    )

    // 5. diagnostics — push after didOpen of broken.ts, and pull
    client.notify('textDocument/didOpen', {
      textDocument: { uri: uriOf(brokenPath), languageId: 'typescript', version: 1, text: brokenText },
    })
    const pushed = (await client.waitForNotification(
      'textDocument/publishDiagnostics',
      p => (p as { uri?: string }).uri === uriOf(brokenPath),
    )) as { diagnostics: { code?: number | string; message: string }[] }
    check(
      'push diagnostics: TS2322 arrives for broken.ts',
      pushed.diagnostics.some(d => Number(d.code) === 2322),
      JSON.stringify(pushed.diagnostics.map(d => d.code)),
    )
    const pulled = await client.request<{ kind: string; items: { code?: number | string }[] }>(
      'textDocument/diagnostic',
      { textDocument: { uri: uriOf(brokenPath) } },
    )
    check(
      'pull diagnostics: full report with TS2322 + unused-import 6133',
      pulled.kind === 'full' &&
        pulled.items.some(d => Number(d.code) === 2322) &&
        pulled.items.some(d => Number(d.code) === 6133),
      JSON.stringify(pulled.items.map(d => d.code)),
    )

    // 6. rename shoutGreeting → cross-file WorkspaceEdit
    const shoutDef = posOf(libText, 'shoutGreeting')
    const prep = await client.request<{ placeholder?: string } | null>(
      'textDocument/prepareRename',
      { textDocument: { uri: uriOf(libPath) }, position: shoutDef },
    )
    check('prepareRename: placeholder is shoutGreeting', prep?.placeholder === 'shoutGreeting')
    const renameEdit = await client.request<{
      changes: Record<string, { newText: string }[]>
    }>('textDocument/rename', {
      textDocument: { uri: uriOf(libPath) },
      position: shoutDef,
      newName: 'bellowGreeting',
    })
    const renameFiles = Object.keys(renameEdit.changes)
    const renameEditCount = Object.values(renameEdit.changes).reduce((n, e) => n + e.length, 0)
    check(
      'rename: 4 edits across lib.ts + app.ts (def + import + 2 calls)',
      renameFiles.length === 2 && renameEditCount === 4 &&
        Object.values(renameEdit.changes)
          .flat()
          .every(e => e.newText === 'bellowGreeting'),
      `files=${renameFiles.length} edits=${renameEditCount}`,
    )

    // 7. codeActions on the unused import (6133) — expect a literal-edit fix
    const importPos = posOf(brokenText, 'makeGreeting')
    const sixOneThreeThree = pulled.items.filter(d => Number(d.code) === 6133)
    const actions = await client.request<{ title: string; kind?: string; edit?: { changes?: Record<string, unknown[]> } }[]>(
      'textDocument/codeAction',
      {
        textDocument: { uri: uriOf(brokenPath) },
        range: { start: importPos, end: importPos },
        context: { diagnostics: sixOneThreeThree },
      },
    )
    check(
      'codeActions: ≥1 quickfix with a literal edit for the unused import',
      actions.length >= 1 &&
        actions.some(a => a.edit && Object.keys(a.edit.changes ?? {}).length > 0),
      JSON.stringify(actions.map(a => a.title)),
    )

    // 8a. hover
    const hover = await client.request<{ contents: { value: string } } | null>(
      'textDocument/hover',
      { textDocument: { uri: uriOf(appPath) }, position: useMakeGreeting },
    )
    check(
      'hover: signature names makeGreeting',
      !!hover && hover.contents.value.includes('makeGreeting'),
    )

    // 8b. call hierarchy: incoming calls to makeGreeting
    const prepItems = await client.request<
      { name: string; uri: string; selectionRange: { start: { line: number; character: number } } }[]
    >('textDocument/prepareCallHierarchy', {
      textDocument: { uri: uriOf(libPath) },
      position: refPos,
    })
    check('prepareCallHierarchy: item is makeGreeting', prepItems.length >= 1 && prepItems[0]!.name === 'makeGreeting')
    const incoming = await client.request<{ from: { name: string } }[]>(
      'callHierarchy/incomingCalls',
      { item: prepItems[0] },
    )
    const callers = incoming.map(c => c.from.name)
    check(
      'incomingCalls: greetCrew and greetOne call makeGreeting',
      callers.includes('greetCrew') && callers.includes('greetOne'),
      callers.join(','),
    )

    // 8c. typeDefinition: `g` in greetOne → Greeting in lib.ts
    check(
      'initialize: typeDefinition + fileOperations.willRename capabilities (slice 2)',
      caps.typeDefinitionProvider === true &&
        !!(caps.workspace as { fileOperations?: { willRename?: unknown } } | undefined)
          ?.fileOperations?.willRename,
    )
    const gUse = posOf(appText, 'shoutGreeting(g)')
    const typeDefs = await client.request<Loc[]>('textDocument/typeDefinition', {
      textDocument: { uri: uriOf(appPath) },
      position: { line: gUse.line, character: gUse.character + 'shoutGreeting('.length },
    })
    const greetingLine = posOf(libText, 'export interface Greeting').line
    check(
      'typeDefinition: g resolves to interface Greeting in lib.ts',
      typeDefs.length >= 1 &&
        typeDefs.some(d => d.uri === uriOf(libPath) && d.range.start.line === greetingLine),
      JSON.stringify(typeDefs),
    )

    // 8d. willRenameFiles: moving lib.ts → core/lib.ts
    // must produce the import-updating edit in app.ts BEFORE any move.
    const willRename = await client.request<{
      changes?: Record<string, { newText: string }[]>
    }>('workspace/willRenameFiles', {
      files: [
        {
          oldUri: uriOf(libPath),
          newUri: uriOf(path.join(fixtureRoot, 'src/core/lib.ts')),
        },
      ],
    })
    const appEdits = willRename?.changes?.[uriOf(appPath)] ?? []
    check(
      'willRenameFiles: app.ts import edit points at the new path',
      appEdits.length >= 1 && appEdits.some(e => e.newText.includes('core/lib')),
      JSON.stringify(willRename),
    )

    // 9. clean shutdown
    await client.request('shutdown', null, 5000)
    client.notify('exit', null)
    const code = await client.waitForExit()
    check('shutdown/exit: child exits 0', code === 0, `code=${code}`)
  } catch (e) {
    failures++
    console.error(`  FAIL (exception): ${e instanceof Error ? e.message : String(e)}`)
    console.error('  sidecar stderr:', client.stderr.slice(0, 2000))
  } finally {
    clearTimeout(overallTimer)
    client.kill()
  }

  if (failures > 0) {
    console.error(`prove-lsp-e2e: RED (${failures} failing)`)
    process.exit(1)
  }
  console.log('prove-lsp-e2e: GREEN')
}

await main()
