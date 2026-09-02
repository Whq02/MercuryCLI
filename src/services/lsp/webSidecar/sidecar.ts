// ============================================================================
//  mercury-web sidecar — the zero-setup web-language lanes: ONE
//  in-bundle LSP stdio server driving the four BUNDLED pure-JS services
//  (vscode-html/css/json-languageservice + the yaml-language-server library
//  surface). Spawned by the existing LSP manager as `mercury-web` (bundle
//  re-entry `--lsp-web-sidecar`) — no new processes beyond the established
//  sidecar convention, no vendor payloads (the services live inside
//  mercury.mjs), no parallel client machinery.
//
//  Capabilities per language (HONEST — nothing invented):
//    html      hover · format · rangeFormat · documentSymbols
//              (the maintained service ships NO validator — diagnostics are
//              deliberately absent rather than fabricated)
//    css/scss/less · json/jsonc · yaml/yml
//              diagnostics (push + pull) · hover · format · rangeFormat
//              (+ documentSymbols where the service provides them)
//
//  LAW: schema resolution NEVER fetches the network — the schema request
//  service answers file:// reads only and refuses http(s) BY NAME (the
//  "downloads never implicit" law; a project that wants remote schemas gets
//  a precise message, never a silent fetch).
// ============================================================================

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
// The three vscode services are imported via their ESM builds EXPLICITLY:
// their package "main" is a UMD/CJS body whose define-wrapped relative
// requires survive bundling as RUNTIME requires (`Cannot find module
// './parser/cssParser'` from the single-file artifact — caught by the
// isolated-bundle repro). The esm trees inline cleanly.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — deep esm import (typings ride the package root)
import { getCSSLanguageService, getLESSLanguageService, getSCSSLanguageService } from 'vscode-css-languageservice/lib/esm/cssLanguageService.js'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — deep esm import (typings ride the package root)
import { getLanguageService as getHtmlLanguageService } from 'vscode-html-languageservice/lib/esm/htmlLanguageService.js'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — deep esm import (typings ride the package root)
import { getLanguageService as getJsonLanguageService } from 'vscode-json-languageservice/lib/esm/jsonLanguageService.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  RPC_SERVER_NOT_INITIALIZED,
  RPC_PARSE_ERROR,
  createFrameReader,
  createFrameWriter,
  type JsonRpcId,
  type JsonRpcMessage,
} from '../sidecarFraming.js'

// The yaml-language-server LIBRARY surface (lib/esm ships untyped for this
// import path — bridged structurally; the shapes are compile-checked at the
// call sites below).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no published typings for the lib/esm deep import
import { getLanguageService as getYamlLanguageService } from 'yaml-language-server/lib/esm/languageservice/yamlLanguageService.js'

type WebLanguage = 'html' | 'css' | 'scss' | 'less' | 'json' | 'jsonc' | 'yaml'

const EXT_TO_LANGUAGE: Record<string, WebLanguage> = {
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
}

// jsonc-BY-CONVENTION basenames (verify-wave finding #1): tsconfig-class
// files carry comments/trailing commas by universal convention — strict
// JSON diagnostics on them are PHANTOM errors an agent might "fix" by
// mutilating a valid file. Routed to the jsonc mode by basename, BEFORE the
// extension map.
const JSONC_BASENAME_PATTERNS = [
  /^tsconfig(\..+)?\.json$/i,
  /^jsconfig(\..+)?\.json$/i,
  /^\.eslintrc\.json$/i,
  /^\.babelrc(\.json)?$/i,
  /^\.swcrc$/i,
  /^(settings|launch|tasks|extensions|keybindings|devcontainer)\.json$/i,
]

export function webLanguageForUri(uri: string): WebLanguage | null {
  const p = uri.startsWith('file://') ? fileURLToPath(uri) : uri
  const base = path.basename(p)
  if (JSONC_BASENAME_PATTERNS.some(re => re.test(base))) return 'jsonc'
  return EXT_TO_LANGUAGE[path.extname(p).toLowerCase()] ?? null
}

/** file:// only — http(s) refuses BY NAME (downloads are never implicit). */
async function schemaRequest(uri: string): Promise<string> {
  if (uri.startsWith('file://')) {
    return fsp.readFile(fileURLToPath(uri), 'utf8')
  }
  return Promise.reject(
    new Error(
      `mercury-web does not fetch remote schemas (${uri.slice(0, 80)}) — downloads are never implicit; vendor the schema into the project and reference it by file path`,
    ),
  )
}

interface YamlServiceShape {
  configure(settings: unknown): void
  doValidation(doc: TextDocument, isKubernetes: boolean): Promise<unknown[]>
  doHover(doc: TextDocument, position: unknown): Promise<unknown>
  doFormat?(doc: TextDocument, options: Record<string, unknown>): unknown[]
  findDocumentSymbols2?(doc: TextDocument, context?: unknown): unknown[]
}

export interface WebSidecarOptions {
  log?: (line: string) => void
}

export async function runWebLspSidecar(
  input: Readable,
  output: Writable,
  opts: WebSidecarOptions = {},
): Promise<number> {
  const log = opts.log ?? (() => {})

  const htmlService = getHtmlLanguageService()
  const cssService = getCSSLanguageService()
  const scssService = getSCSSLanguageService()
  const lessService = getLESSLanguageService()
  const jsonService = getJsonLanguageService({ schemaRequestService: schemaRequest })
  const yamlService = (
    getYamlLanguageService as unknown as (
      schemaRequestService: (uri: string) => Promise<string>,
      workspaceContext: { resolveRelativePath(relative: string, resource: string): string },
    ) => YamlServiceShape
  )(schemaRequest, {
    resolveRelativePath: (relative: string, resource: string) =>
      pathToFileURL(path.resolve(path.dirname(fileURLToPath(resource)), relative)).toString(),
  })
  yamlService.configure({ validate: true, hover: true, completion: false, format: true })

  const docs = new Map<string, TextDocument>()
  let initialized = false
  let shutdownRequested = false

  const write = createFrameWriter(output)

  return new Promise<number>(resolvePromise => {
    let finished = false
    function finish(code: number): void {
      if (finished) return
      finished = true
      resolvePromise(code)
    }

    function respond(id: JsonRpcId, result: unknown): void {
      write({ jsonrpc: '2.0', id, result: result ?? null })
    }
    function respondError(id: JsonRpcId, code: number, message: string): void {
      write({ jsonrpc: '2.0', id, error: { code, message } })
    }
    function notify(method: string, params: unknown): void {
      write({ jsonrpc: '2.0', method, params })
    }

    function requireDoc(uri: string): TextDocument {
      const doc = docs.get(uri)
      if (!doc) {
        throw Object.assign(new Error(`document not open: ${uri}`), { rpcCode: RPC_INTERNAL_ERROR })
      }
      return doc
    }

    function languageIdOf(uri: string): WebLanguage {
      const lang = webLanguageForUri(uri)
      if (!lang) {
        throw Object.assign(new Error(`not a mercury-web language: ${uri}`), { rpcCode: RPC_INTERNAL_ERROR })
      }
      return lang
    }

    function cssServiceFor(lang: WebLanguage) {
      return lang === 'scss' ? scssService : lang === 'less' ? lessService : cssService
    }

    async function computeDiagnostics(doc: TextDocument): Promise<unknown[]> {
      const lang = languageIdOf(doc.uri)
      switch (lang) {
        case 'css':
        case 'scss':
        case 'less': {
          const service = cssServiceFor(lang)
          const sheet = service.parseStylesheet(doc)
          return service.doValidation(doc, sheet)
        }
        case 'json':
        case 'jsonc': {
          const parsed = jsonService.parseJSONDocument(doc)
          return jsonService.doValidation(doc, parsed, {
            comments: lang === 'jsonc' ? 'ignore' : 'error',
            trailingCommas: lang === 'jsonc' ? 'ignore' : 'error',
          })
        }
        case 'yaml':
          return yamlService.doValidation(doc, false)
        case 'html':
          // The maintained html service ships no validator — an empty set is
          // the HONEST answer (never invented rows).
          return []
      }
    }

    const publishTimers = new Map<string, ReturnType<typeof setTimeout>>()
    function schedulePublish(uri: string): void {
      const existing = publishTimers.get(uri)
      if (existing) clearTimeout(existing)
      publishTimers.set(
        uri,
        setTimeout(() => {
          publishTimers.delete(uri)
          const doc = docs.get(uri)
          if (!doc) return
          void computeDiagnostics(doc)
            .then(diagnostics => notify('textDocument/publishDiagnostics', { uri, diagnostics }))
            .catch(e => log(`publish failed for ${uri}: ${String(e)}`))
        }, 150),
      )
    }

    function formatOptionsOf(params: { options?: { tabSize?: number; insertSpaces?: boolean } }): {
      tabSize: number
      insertSpaces: boolean
    } {
      return {
        tabSize: params.options?.tabSize ?? 2,
        insertSpaces: params.options?.insertSpaces ?? true,
      }
    }

    async function formatEdits(
      doc: TextDocument,
      range: unknown | undefined,
      options: { tabSize: number; insertSpaces: boolean },
    ): Promise<unknown[]> {
      const lang = languageIdOf(doc.uri)
      const fullRange = {
        start: { line: 0, character: 0 },
        end: doc.positionAt(doc.getText().length),
      }
      switch (lang) {
        case 'html':
          return htmlService.format(doc, (range ?? fullRange) as never, {
            tabSize: options.tabSize,
            insertSpaces: options.insertSpaces,
            wrapLineLength: 120,
            endWithNewline: doc.getText().endsWith('\n'),
          } as never)
        case 'css':
        case 'scss':
        case 'less':
          return cssServiceFor(lang).format(doc, (range ?? fullRange) as never, {
            tabSize: options.tabSize,
            insertSpaces: options.insertSpaces,
          } as never)
        case 'json':
        case 'jsonc':
          return jsonService.format(doc, (range ?? fullRange) as never, {
            tabSize: options.tabSize,
            insertSpaces: options.insertSpaces,
          } as never)
        case 'yaml': {
          if (typeof yamlService.doFormat !== 'function') {
            throw Object.assign(new Error('the bundled yaml service exposes no formatter'), {
              rpcCode: RPC_INTERNAL_ERROR,
            })
          }
          // yaml formats whole-document only (prettier-backed) — a range ask
          // still returns the whole-document edit set, honestly.
          return yamlService.doFormat(doc, {
            tabWidth: options.tabSize,
          })
        }
      }
    }

    async function handleRequest(method: string, params: unknown): Promise<unknown> {
      if (!initialized && method !== 'initialize' && method !== 'shutdown') {
        throw Object.assign(new Error('server not initialized'), { rpcCode: RPC_SERVER_NOT_INITIALIZED })
      }
      switch (method) {
        case 'initialize': {
          initialized = true
          log('initialized: mercury-web (html/css/json/yaml bundled services)')
          return {
            capabilities: {
              textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
              hoverProvider: true,
              documentFormattingProvider: true,
              documentRangeFormattingProvider: true,
              documentSymbolProvider: true,
              diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
            },
            serverInfo: { name: 'mercury-web' },
          }
        }
        case 'shutdown':
          shutdownRequested = true
          return null
        case 'textDocument/hover': {
          const p = params as { textDocument: { uri: string }; position: unknown }
          const doc = requireDoc(p.textDocument.uri)
          const lang = languageIdOf(doc.uri)
          switch (lang) {
            case 'html':
              return htmlService.doHover(doc, p.position as never, htmlService.parseHTMLDocument(doc))
            case 'css':
            case 'scss':
            case 'less': {
              const service = cssServiceFor(lang)
              return service.doHover(doc, p.position as never, service.parseStylesheet(doc))
            }
            case 'json':
            case 'jsonc':
              return jsonService.doHover(doc, p.position as never, jsonService.parseJSONDocument(doc))
            case 'yaml':
              return yamlService.doHover(doc, p.position)
          }
          return null
        }
        case 'textDocument/formatting': {
          const p = params as { textDocument: { uri: string }; options?: { tabSize?: number; insertSpaces?: boolean } }
          const doc = requireDoc(p.textDocument.uri)
          return formatEdits(doc, undefined, formatOptionsOf(p))
        }
        case 'textDocument/rangeFormatting': {
          const p = params as {
            textDocument: { uri: string }
            range: unknown
            options?: { tabSize?: number; insertSpaces?: boolean }
          }
          const doc = requireDoc(p.textDocument.uri)
          return formatEdits(doc, p.range, formatOptionsOf(p))
        }
        case 'textDocument/documentSymbol': {
          const p = params as { textDocument: { uri: string } }
          const doc = requireDoc(p.textDocument.uri)
          const lang = languageIdOf(doc.uri)
          switch (lang) {
            case 'html':
              return htmlService.findDocumentSymbols(doc, htmlService.parseHTMLDocument(doc))
            case 'css':
            case 'scss':
            case 'less': {
              const service = cssServiceFor(lang)
              return service.findDocumentSymbols(doc, service.parseStylesheet(doc))
            }
            case 'json':
            case 'jsonc':
              return jsonService.findDocumentSymbols(doc, jsonService.parseJSONDocument(doc))
            case 'yaml':
              return typeof yamlService.findDocumentSymbols2 === 'function'
                ? yamlService.findDocumentSymbols2(doc)
                : []
          }
          return []
        }
        case 'textDocument/diagnostic': {
          const p = params as { textDocument: { uri: string } }
          const doc = requireDoc(p.textDocument.uri)
          return { kind: 'full', items: await computeDiagnostics(doc) }
        }
        default:
          throw Object.assign(new Error(`method not implemented: ${method}`), { rpcCode: RPC_METHOD_NOT_FOUND })
      }
    }

    function handleNotification(method: string, params: unknown): void {
      switch (method) {
        case 'initialized':
          return
        case 'exit':
          finish(shutdownRequested ? 0 : 1)
          return
        case 'textDocument/didOpen': {
          const p = params as { textDocument: { uri: string; languageId?: string; version?: number; text: string } }
          const lang = webLanguageForUri(p.textDocument.uri)
          if (!lang) return
          docs.set(
            p.textDocument.uri,
            TextDocument.create(p.textDocument.uri, lang, p.textDocument.version ?? 1, p.textDocument.text),
          )
          schedulePublish(p.textDocument.uri)
          return
        }
        case 'textDocument/didChange': {
          const p = params as {
            textDocument: { uri: string; version?: number }
            contentChanges: { text: string }[]
          }
          const existing = docs.get(p.textDocument.uri)
          const last = p.contentChanges[p.contentChanges.length - 1]
          if (!existing || !last) return
          docs.set(
            p.textDocument.uri,
            TextDocument.create(existing.uri, existing.languageId, p.textDocument.version ?? existing.version + 1, last.text),
          )
          schedulePublish(p.textDocument.uri)
          return
        }
        case 'textDocument/didSave':
          return
        case 'textDocument/didClose': {
          const p = params as { textDocument: { uri: string } }
          docs.delete(p.textDocument.uri)
          const timer = publishTimers.get(p.textDocument.uri)
          if (timer) clearTimeout(timer)
          publishTimers.delete(p.textDocument.uri)
          return
        }
        default:
          return
      }
    }

    const readChunk = createFrameReader(
      msg => {
        if (msg.method !== undefined) {
          if (msg.id !== undefined && msg.id !== null) {
            const id = msg.id
            void handleRequest(msg.method, msg.params)
              .then(result => respond(id, result))
              .catch((e: unknown) => {
                const rpcCode = (e as { rpcCode?: number }).rpcCode ?? RPC_INTERNAL_ERROR
                respondError(id, rpcCode, e instanceof Error ? e.message : String(e))
              })
          } else {
            try {
              handleNotification(msg.method, msg.params)
            } catch (e) {
              log(`notification ${msg.method} failed: ${String(e)}`)
            }
          }
        }
      },
      err => {
        log(`protocol error: ${err.message}`)
        write({ jsonrpc: '2.0', id: null, error: { code: RPC_PARSE_ERROR, message: err.message } })
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
