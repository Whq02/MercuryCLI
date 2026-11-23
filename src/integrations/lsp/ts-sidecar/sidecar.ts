
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import type { Readable, Writable } from 'node:stream'
import {
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  RPC_SERVER_NOT_INITIALIZED,
  createFrameReader,
  createFrameWriter,
  type JsonRpcId,
} from '../sidecarFraming.js'
import { type TsModule, type LspPosition, type LspDiagnostic, offsetAt, spanToRange, toUri, fromUri, diagnosticSeverityOf } from './sidecar/lsp.js'
import { type Project, SidecarState } from './sidecar/state.js'
import { definitionRequest, implementationRequest, typeDefinitionRequest, referencesRequest, hoverRequest, documentSymbolRequest, workspaceSymbolRequest } from './sidecar/requests/navigation.js'
import { prepareCallHierarchyRequest, incomingCallsRequest, outgoingCallsRequest } from './sidecar/requests/callHierarchy.js'
import { formattingRequest, rangeFormattingRequest } from './sidecar/requests/formatting.js'
import { willRenameFilesRequest, prepareRenameRequest, renameRequest } from './sidecar/requests/rename.js'
import { codeActionRequest, codeActionResolveRequest } from './sidecar/requests/codeActions.js'
import { moveToFileRequest } from './sidecar/requests/moveToFile.js'
import { diagnosticRequest } from './sidecar/requests/diagnostic.js'
import { handleNotification } from './sidecar/notifications.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export function resolveWorkspaceTypescript(root: string): string | undefined {
  let dir = path.resolve(root)
  for (let i = 0; i < 40; i++) {
    const candidate = path.join(dir, 'node_modules', 'typescript', 'lib', 'typescript.js')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function loadTypescript(tsPath: string): TsModule {
  const req = createRequire(tsPath)
  const target: string = tsPath
  return req(target) as TsModule
}

const DIAGNOSTIC_CAP_PER_FILE = 200

interface SidecarOptions {
  typescriptPath?: string
  log?: (line: string) => void
}

export function runTsLspSidecar(
  input: Readable,
  output: Writable,
  opts: SidecarOptions = {},
): Promise<number> {
  const log = opts.log ?? (() => {})
  const write = createFrameWriter(output)

  let state: SidecarState | undefined
  let shutdownRequested = false
  const pendingPublishes = new Map<string, ReturnType<typeof setTimeout>>()

  return new Promise<number>(resolve => {
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      for (const timer of pendingPublishes.values()) stopTimeout(timer)
      resolve(code)
    }

    function respond(id: JsonRpcId, result: unknown): void {
      write({ jsonrpc: '2.0', id, result })
    }
    function respondError(id: JsonRpcId, code: number, message: string): void {
      write({ jsonrpc: '2.0', id, error: { code, message } })
    }
    function notify(method: string, params: unknown): void {
      write({ jsonrpc: '2.0', method, params })
    }


    function computeDiagnostics(file: string): LspDiagnostic[] {
      if (!state) return []
      const norm = state.normalize(file)
      const project = state.projectFor(norm)
      const text = state.textOf(norm) ?? ''
      const all = [
        ...project.service.getSyntacticDiagnostics(norm),
        ...project.service.getSemanticDiagnostics(norm),
      ]
      const out: LspDiagnostic[] = []
      for (const d of all.slice(0, DIAGNOSTIC_CAP_PER_FILE)) {
        const start = d.start ?? 0
        const length = d.length ?? 0
        out.push({
          range: spanToRange(text, start, length),
          severity: diagnosticSeverityOf(state.ts, d.category),
          code: d.code,
          source: 'mercury-ts',
          message: state.ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        })
      }
      return out
    }

    function schedulePublish(file: string): void {
      if (!state) return
      const norm = state.normalize(file)
      const existing = pendingPublishes.get(norm)
      if (existing) stopTimeout(existing)
      pendingPublishes.set(
        norm,
        startTimeout(() => {
          pendingPublishes.delete(norm)
          try {
            notify('textDocument/publishDiagnostics', {
              uri: toUri(norm),
              diagnostics: computeDiagnostics(norm),
            })
          } catch (e) {
            log(`publishDiagnostics failed for ${norm}: ${String(e)}`)
          }
        }, 150),
      )
    }


    function requireState(): SidecarState {
      if (!state) {
        throw Object.assign(new Error('server not initialized'), {
          rpcCode: RPC_SERVER_NOT_INITIALIZED,
        })
      }
      return state
    }

    function docContext(params: unknown): {
      st: SidecarState
      file: string
      text: string
      project: Project
      offset: number
    } {
      const st = requireState()
      const p = params as {
        textDocument: { uri: string }
        position?: LspPosition
      }
      const file = st.normalize(fromUri(p.textDocument.uri))
      const text = st.textOf(file) ?? ''
      const project = st.projectFor(file)
      const offset = p.position ? offsetAt(text, p.position) : 0
      return { st, file, text, project, offset }
    }

    function handleRequest(method: string, params: unknown): unknown {
      switch (method) {
        case 'initialize': {
          const p = params as {
            rootUri?: string | null
            rootPath?: string | null
            workspaceFolders?: { uri: string }[] | null
            initializationOptions?: { typescriptPath?: string } | null
          }
          const firstFolder = p.workspaceFolders?.[0]?.uri
          const root = path.resolve(
            firstFolder
              ? fromUri(firstFolder)
              : p.rootUri
                ? fromUri(p.rootUri)
                : (p.rootPath ?? process.cwd()),
          )
          const tsPath =
            opts.typescriptPath ??
            p.initializationOptions?.typescriptPath ??
            resolveWorkspaceTypescript(root)
          if (!tsPath) {
            throw Object.assign(
              new Error(
                `no resolvable 'typescript' package from workspace root ${root}`,
              ),
              { rpcCode: RPC_INTERNAL_ERROR },
            )
          }
          const ts = loadTypescript(tsPath)
          state = new SidecarState(ts, root)
          log(`initialized: typescript@${ts.version} root=${root}`)
          return {
            capabilities: {
              textDocumentSync: {
                openClose: true,
                change: 1,
                save: { includeText: false },
              },
              definitionProvider: true,
              referencesProvider: true,
              hoverProvider: true,
              documentFormattingProvider: true,
              documentRangeFormattingProvider: true,
              documentSymbolProvider: true,
              workspaceSymbolProvider: true,
              implementationProvider: true,
              typeDefinitionProvider: true,
              callHierarchyProvider: true,
              renameProvider: { prepareProvider: true },
              codeActionProvider: {
                codeActionKinds: [
                  'quickfix',
                  'refactor',
                  'source.organizeImports',
                  'source.removeUnusedImports',
                  'source.addMissingImports',
                  'source.removeUnused',
                ],
                resolveProvider: true,
              },
              diagnosticProvider: {
                interFileDependencies: true,
                workspaceDiagnostics: false,
              },
              workspace: {
                fileOperations: {
                  willRename: {
                    filters: [
                      {
                        pattern: {
                          glob: '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}',
                        },
                      },
                    ],
                  },
                },
              },
            },
            serverInfo: { name: 'mercury-ts', version: ts.version },
          }
        }

        case 'shutdown':
          shutdownRequested = true
          return null

        case 'textDocument/definition':
          return definitionRequest(params, docContext)
        case 'textDocument/implementation':
          return implementationRequest(params, docContext)
        case 'textDocument/typeDefinition':
          return typeDefinitionRequest(params, docContext)
        case 'workspace/willRenameFiles':
          return willRenameFilesRequest(params, requireState)
        case 'textDocument/formatting':
          return formattingRequest(params, requireState)
        case 'textDocument/rangeFormatting':
          return rangeFormattingRequest(params, requireState)
        case 'textDocument/references':
          return referencesRequest(params, docContext)
        case 'textDocument/hover':
          return hoverRequest(params, docContext)
        case 'textDocument/documentSymbol':
          return documentSymbolRequest(params, docContext)
        case 'workspace/symbol':
          return workspaceSymbolRequest(params, requireState)
        case 'textDocument/prepareCallHierarchy':
          return prepareCallHierarchyRequest(params, docContext)
        case 'callHierarchy/incomingCalls':
          return incomingCallsRequest(params, requireState)
        case 'callHierarchy/outgoingCalls':
          return outgoingCallsRequest(params, requireState)
        case 'textDocument/prepareRename':
          return prepareRenameRequest(params, docContext)
        case 'textDocument/rename':
          return renameRequest(params, docContext)
        case 'textDocument/codeAction':
          return codeActionRequest(params, docContext)
        case 'codeAction/resolve':
          return codeActionResolveRequest(params, requireState)
        case 'mercury/moveToFile':
          return moveToFileRequest(params, docContext)
        case 'textDocument/diagnostic':
          return diagnosticRequest(params, docContext, computeDiagnostics)

        default:
          throw Object.assign(new Error(`method not found: ${method}`), {
            rpcCode: RPC_METHOD_NOT_FOUND,
          })
      }
    }

    const readChunk = createFrameReader(
      msg => {
        if (msg.method !== undefined) {
          if (msg.id !== undefined && msg.id !== null) {
            try {
              respond(msg.id, handleRequest(msg.method, msg.params))
            } catch (e) {
              const rpcCode =
                (e as { rpcCode?: number }).rpcCode ?? RPC_INTERNAL_ERROR
              respondError(
                msg.id,
                rpcCode,
                e instanceof Error ? e.message : String(e),
              )
            }
          } else {
            try {
              handleNotification(msg.method, msg.params, requireState, schedulePublish, finish, shutdownRequested)
            } catch (e) {
              log(`notification ${msg.method} failed: ${String(e)}`)
            }
          }
        }
      },
      err => {
        log(`protocol error: ${err.message}`)
        write({
          jsonrpc: '2.0',
          id: null,
          error: { code: RPC_PARSE_ERROR, message: err.message },
        })
      },
    )

    input.on('data', (chunk: Buffer) => {
      try {
        readChunk(chunk)
      } catch (e) {
        log(`fatal read error: ${String(e)}`)
        finish(1)
      }
    })
    input.on('end', () => finish(0))
    input.on('close', () => finish(0))
    input.on('error', () => finish(1))
  })
}
