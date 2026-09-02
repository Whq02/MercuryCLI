'use strict'
// ============================================================================
//  The `vscode` module stub the editor-bridge provers activate the extension
//  under: enough of the extension API for activation, the tree views, the
//  chat surface, and the terminal bridge (documents, selection events,
//  diagnostics, the diff view, tabs, the environment collection). Every
//  call the extension makes is recorded on `state` so a prover can pin what
//  the extension DID, never a real editor.
// ============================================================================

function makeEmitter() {
  const listeners = new Set()
  return {
    event: listener => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire: value => {
      for (const l of [...listeners]) l(value)
    },
  }
}

class Uri {
  constructor(scheme, p, query) {
    this.scheme = scheme
    this.path = p
    this.fsPath = p
    this.query = query || ''
  }
  static file(p) {
    return new Uri('file', p, '')
  }
  static parse(s) {
    const m = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(String(s))
    if (!m) return new Uri('file', String(s), '')
    let rest = m[2]
    if (rest.startsWith('//')) rest = rest.slice(2)
    const q = rest.indexOf('?')
    return new Uri(m[1], q === -1 ? rest : rest.slice(0, q), q === -1 ? '' : rest.slice(q + 1))
  }
  with(change) {
    return new Uri(change.scheme || this.scheme, change.path || this.path, change.query !== undefined ? change.query : this.query)
  }
  toString() {
    return `${this.scheme}:${this.scheme === 'file' ? '//' : ''}${this.path}${this.query ? `?${this.query}` : ''}`
  }
}

class Position {
  constructor(line, character) {
    this.line = line
    this.character = character
  }
}
class Range {
  constructor(start, end) {
    this.start = start
    this.end = end
  }
}
class Selection extends Range {
  constructor(start, end) {
    super(start, end)
    this.isEmpty = start.line === end.line && start.character === end.character
  }
}

function makeDocument(uri, text, languageId) {
  const lines = text.split('\n')
  return {
    uri,
    fileName: uri.fsPath,
    languageId: languageId || 'plaintext',
    isDirty: false,
    isUntitled: false,
    lineCount: lines.length,
    getText(range) {
      if (!range) return text
      // The stub's selection text is the lines the range spans.
      return lines.slice(range.start.line, range.end.line + 1).join('\n')
    },
    positionAt(offset) {
      let line = 0
      let seen = 0
      for (const l of lines) {
        if (seen + l.length + 1 > offset) return new Position(line, offset - seen)
        seen += l.length + 1
        line++
      }
      return new Position(Math.max(0, lines.length - 1), 0)
    },
    lineAt(line) {
      const l = lines[line] || ''
      return { text: l, range: new Range(new Position(line, 0), new Position(line, l.length)) }
    },
    save: async () => true,
  }
}

function makeStub(options) {
  const opts = options || {}
  const workspacePath = opts.workspacePath || process.cwd()
  const state = {
    registered: [],
    executed: [],
    env: [],
    fsProviders: new Map(),
    contentProviders: new Map(),
    closedTabs: [],
    terminals: [],
    messages: [],
    outputLines: [],
  }
  const emitters = {
    activeEditor: makeEmitter(),
    selection: makeEmitter(),
    visibleEditors: makeEmitter(),
    diagnostics: makeEmitter(),
    workspaceFolders: makeEmitter(),
    configuration: makeEmitter(),
    tabs: makeEmitter(),
  }
  const docText = 'line one\nline two\nline three\nline four\nline five\n'
  const activeFile = opts.activeFile || `${workspacePath}/stub.ts`
  const doc = makeDocument(Uri.file(activeFile), docText, 'typescript')
  const editor = {
    document: doc,
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    revealRange() {},
  }
  const tabGroups = {
    all: [{ isActive: true, tabs: [] }],
    onDidChangeTabs: emitters.tabs.event,
    close: async tabs => {
      state.closedTabs.push(...(Array.isArray(tabs) ? tabs : [tabs]))
    },
  }
  const window = {
    createOutputChannel: () => ({
      appendLine: line => state.outputLines.push(line),
      show() {},
      dispose() {},
    }),
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
    createWebviewPanel: () => ({
      webview: { onDidReceiveMessage() {}, html: '', cspSource: 'stub', postMessage: async () => true },
      onDidDispose() {},
      reveal() {},
    }),
    registerTreeDataProvider: () => ({ dispose() {} }),
    showInformationMessage: async (...args) => {
      state.messages.push({ kind: 'info', args })
      return undefined
    },
    showWarningMessage: async (...args) => {
      state.messages.push({ kind: 'warning', args })
      return undefined
    },
    showErrorMessage: async (...args) => {
      state.messages.push({ kind: 'error', args })
      return undefined
    },
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    createTerminal: spec => {
      const terminal = { spec, sent: [], sendText: text => terminal.sent.push(text), show() {} }
      state.terminals.push(terminal)
      return terminal
    },
    createTextEditorDecorationType: () => ({ dispose() {} }),
    setStatusBarMessage: () => {},
    showTextDocument: async () => editor,
    visibleTextEditors: [editor],
    activeTextEditor: editor,
    onDidChangeActiveTextEditor: emitters.activeEditor.event,
    onDidChangeTextEditorSelection: emitters.selection.event,
    onDidChangeVisibleTextEditors: emitters.visibleEditors.event,
    tabGroups,
  }
  const workspace = {
    workspaceFolders: [{ name: 'stub', uri: Uri.file(workspacePath), index: 0 }],
    getConfiguration: () => ({
      get: key => (key === 'path' ? opts.mercuryPath || 'mercury' : true),
    }),
    asRelativePath: p => {
      const s = typeof p === 'string' ? p : p.fsPath
      return s.startsWith(`${workspacePath}/`) ? s.slice(workspacePath.length + 1) : s
    },
    openTextDocument: async spec => {
      if (spec && spec.fsPath) return makeDocument(spec, docText, 'typescript')
      return makeDocument(Uri.parse('untitled:stub'), (spec && spec.content) || '', (spec && spec.language) || 'plaintext')
    },
    textDocuments: [doc],
    onDidChangeWorkspaceFolders: emitters.workspaceFolders.event,
    onDidChangeConfiguration: emitters.configuration.event,
    registerFileSystemProvider: (scheme, provider) => {
      state.fsProviders.set(scheme, provider)
      return { dispose: () => state.fsProviders.delete(scheme) }
    },
    registerTextDocumentContentProvider: (scheme, provider) => {
      state.contentProviders.set(scheme, provider)
      return { dispose: () => state.contentProviders.delete(scheme) }
    },
  }
  const languages = {
    getDiagnostics: uri => {
      const diagnostic = {
        message: 'stub error',
        severity: 0,
        source: 'stub',
        range: new Range(new Position(1, 2), new Position(1, 8)),
      }
      if (uri) return uri.fsPath === activeFile ? [diagnostic] : []
      return [[doc.uri, [diagnostic]]]
    },
    onDidChangeDiagnostics: emitters.diagnostics.event,
  }
  const commands = {
    registerCommand: (name, fn) => {
      state.registered.push(name)
      state.commandFns = state.commandFns || new Map()
      state.commandFns.set(name, fn)
      return { dispose() {} }
    },
    executeCommand: async (name, ...args) => {
      state.executed.push({ name, args })
      if (state.onExecute) state.onExecute(name, args)
      return undefined
    },
  }
  class FileSystemError extends Error {
    static FileNotFound(uri) {
      return new FileSystemError(`not found: ${uri}`)
    }
    static NoPermissions(uri) {
      return new FileSystemError(`no permissions: ${uri}`)
    }
  }
  const vscode = {
    window,
    workspace,
    languages,
    commands,
    Uri,
    Position,
    Range,
    Selection,
    EventEmitter: class {
      constructor() {
        const e = makeEmitter()
        this.event = e.event
        this.fire = e.fire
      }
      dispose() {}
    },
    TreeItem: class {
      constructor(label) {
        this.label = label
      }
    },
    ThemeColor: class {
      constructor(id) {
        this.id = id
      }
    },
    ViewColumn: { Beside: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    FileType: { File: 1, Directory: 2 },
    FilePermission: { Readonly: 1 },
    FileSystemError,
    TextEditorRevealType: { InCenter: 2 },
  }
  const context = {
    subscriptions: [],
    extension: { packageJSON: { version: opts.extensionVersion || '1.2.3' } },
    environmentVariableCollection: {
      description: '',
      replace: (name, value) => {
        state.env.push({ op: 'replace', name, value })
        if (state.onEnv) state.onEnv(name, value)
      },
      clear: () => {
        state.env.push({ op: 'clear' })
        if (state.onEnv) state.onEnv(null, null)
      },
    },
  }
  return { vscode, context, state, emitters, editor, doc, Uri, Position, Selection }
}

module.exports = { makeStub, Uri, Position, Range, Selection }
