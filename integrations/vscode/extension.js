
'use strict'

const vscode = require('vscode')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const ACP_PROTOCOL_VERSION = 1


let output = null
function log(line) {
  if (output) output.appendLine(`${new Date().toISOString().slice(11, 19)} ${line}`)
}


class AcpClient {
  constructor(command, args, cwd, onNotification, onExit) {
    this.nextId = 1
    this.pending = new Map()
    this.onNotification = onNotification
    this.buffer = ''
    this.stderrTail = []
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.on('error', err => {
      log(`acp: failed to start: ${err.message}`)
      for (const { reject } of this.pending.values()) {
        reject(new Error(`mercury acp failed to start: ${err.message}`))
      }
      this.pending.clear()
      if (onExit) onExit(-1, err.message)
    })
    this.child.stdin.on('error', () => {})
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === '') continue
        log(`acp stderr: ${line}`)
        this.stderrTail.push(line)
        if (this.stderrTail.length > 20) this.stderrTail.shift()
      }
    })
    this.child.on('exit', code => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`mercury acp exited (${code})`))
      }
      this.pending.clear()
      if (onExit) onExit(code, this.stderrTail[this.stderrTail.length - 1] || '')
    })
  }

  onData(chunk) {
    this.buffer += chunk
    let idx = this.buffer.indexOf('\n')
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line !== '') this.onLine(line)
      idx = this.buffer.indexOf('\n')
    }
  }

  onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        this.pending.delete(msg.id)
        if (msg.error) {
          const detail = msg.error.data && msg.error.data.details ? `: ${msg.error.data.details}` : ''
          pending.reject(new Error(`${msg.error.message || 'ACP error'}${detail}`))
        } else pending.resolve(msg.result)
      }
      return
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      let responded = false
      const respond = response => {
        if (responded) return
        responded = true
        this.safeWrite(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: response }) + '\n')
      }
      Promise.resolve()
        .then(() => this.onNotification(msg.method, msg.params, respond))
        .catch(() => respond({ outcome: { outcome: 'cancelled' } }))
      return
    }
    if (msg.method !== undefined) {
      void this.onNotification(msg.method, msg.params, null)
    }
  }

  safeWrite(payload) {
    try {
      this.child.stdin.write(payload)
      return true
    } catch {
      return false
    }
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (!this.safeWrite(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')) {
        this.pending.delete(id)
        reject(new Error('mercury acp is not running'))
      }
    })
  }

  notify(method, params) {
    this.safeWrite(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  dispose() {
    try {
      this.child.kill('SIGTERM')
    } catch {
    }
  }
}


let client = null
let activeSessionId = null
let sessionModes = null
let chatPanel = null
const chatLog = []
const lastTurnChangedFiles = new Set()
let decorationType = null
let usageStatus = null
let extensionVersion = '0.0.0'
let agentVersion = null
let previewProvider = null

function workspaceCwd() {
  const folders = vscode.workspace.workspaceFolders
  return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd()
}

function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath)
}

function mercuryPath() {
  const config = vscode.workspace.getConfiguration('mercury')
  return config.get('path') || 'mercury'
}

function majorOf(version) {
  const m = /^(\d+)/.exec(String(version || ''))
  return m ? Number(m[1]) : null
}

async function ensureClient(context) {
  if (client) return client
  const parts = mercuryPath().split(' ').filter(Boolean)
  const command = parts[0]
  const args = [...parts.slice(1), 'acp', '--stdio']
  log(`acp: starting ${command} ${args.join(' ')} in ${workspaceCwd()}`)
  const started = new AcpClient(command, args, workspaceCwd(), handleAgentMessage, (code, lastLine) => {
    client = null
    activeSessionId = null
    sessionModes = null
    if (code !== 0 && code !== null) {
      const why = lastLine ? ` — ${lastLine}` : ''
      void vscode.window
        .showWarningMessage(`Mercury ACP server exited (${code})${why}`, 'Show Log', 'Open Settings')
        .then(pick => {
          if (pick === 'Show Log' && output) output.show(true)
          if (pick === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'mercury.path')
        })
    }
  })
  client = started
  context.subscriptions.push({ dispose: () => client && client.dispose() })
  let init
  try {
    init = await started.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'mercury-vscode', version: extensionVersion },
    })
  } catch (e) {
    started.dispose()
    client = null
    throw new Error(`Mercury did not answer the ACP handshake: ${e.message}. Check mercury.path (the launcher must be on PATH, or set the full path).`)
  }
  if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
    started.dispose()
    client = null
    throw new Error(
      `Mercury speaks ACP v${init.protocolVersion}; this extension speaks v${ACP_PROTOCOL_VERSION}. Reinstall the extension shipped with this Mercury: run \`mercury bridge install\`.`,
    )
  }
  agentVersion = init.agentInfo && init.agentInfo.version ? String(init.agentInfo.version) : null
  log(`acp: connected to ${init.agentInfo ? `${init.agentInfo.name} ${agentVersion}` : 'an agent with no agentInfo'}`)
  const agentMajor = majorOf(agentVersion)
  const extMajor = majorOf(extensionVersion)
  if (agentMajor !== null && extMajor !== null && agentMajor !== extMajor) {
    void vscode.window.showWarningMessage(
      `Mercury ${agentVersion} and this extension (${extensionVersion}) are different major versions — run \`mercury bridge install\` to match them.`,
    )
  }
  return started
}

async function ensureSession(context) {
  const c = await ensureClient(context)
  if (activeSessionId) return activeSessionId
  const created = await c.request('session/new', { cwd: workspaceCwd(), mcpServers: [] })
  activeSessionId = created.sessionId
  sessionModes = created.modes || null
  appendChat({ who: 'system', text: `session ${activeSessionId} started` })
  refreshAllViews()
  pushEditorContext()
  return activeSessionId
}


function firstLocation(update) {
  const loc = Array.isArray(update.locations) && update.locations.length > 0 ? update.locations[0] : null
  if (!loc) return ''
  const rel = vscode.workspace.asRelativePath(loc.path, false)
  return loc.line ? `${rel}:${loc.line}` : rel
}

async function handleAgentMessage(method, params, respond) {
  if (method === 'session/update' && params && params.update) {
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type === 'text') {
      appendChat({ who: 'mercury', text: update.content.text, coalesce: true })
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content && update.content.type === 'text') {
      appendChat({ who: 'thought', text: update.content.text, coalesce: true })
    } else if (update.sessionUpdate === 'user_message_chunk' && update.content && update.content.type === 'text') {
      appendChat({ who: 'you', text: update.content.text, coalesce: true })
    } else if (update.sessionUpdate === 'tool_call') {
      const where = firstLocation(update)
      appendChat({
        who: 'tool',
        toolCallId: update.toolCallId,
        status: update.status || 'in_progress',
        text: `${update.title}${where ? ` · ${where}` : ''}`,
      })
      if (update.kind === 'edit' || update.kind === 'delete' || update.kind === 'move') {
        for (const loc of update.locations || []) if (loc && loc.path) lastTurnChangedFiles.add(loc.path)
      }
    } else if (update.sessionUpdate === 'tool_call_update') {
      settleChatTool(update.toolCallId, update.status)
    } else if (update.sessionUpdate === 'plan') {
      const entries = update.entries || []
      const line = entries.map(e => `[${e.status}] ${e.content}`).join(' · ')
      appendChat({ who: 'system', text: entries.length > 0 ? `plan: ${line}` : 'plan cleared' })
      refreshAllViews()
    } else if (update.sessionUpdate === 'usage_update') {
      const k = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
      if (usageStatus) {
        usageStatus.text = `$(pulse) Mercury ${k(update.used)}/${k(update.size)}${update.cost ? ` · $${Number(update.cost.amount).toFixed(4)}` : ''}`
        usageStatus.tooltip = `Context: ${update.used} of ${update.size} tokens in use${update.cost ? ` · session cost $${Number(update.cost.amount).toFixed(4)}` : ''}`
        usageStatus.show()
      }
    } else if (update.sessionUpdate === 'current_mode_update') {
      if (sessionModes) sessionModes = { ...sessionModes, currentModeId: update.currentModeId }
      appendChat({ who: 'system', text: `mode → ${update.currentModeId}` })
    } else if (update.sessionUpdate === 'config_option_update') {
      const options = update.configOptions || []
      for (const option of options) {
        appendChat({ who: 'system', text: `${option.name}: ${option.currentValue}` })
      }
    }
    return
  }
  if (method === 'session/request_permission' && respond) {
    const toolCall = params.toolCall || {}
    const title = toolCall.title || 'a tool'
    const rawInput = toolCall.rawInput || {}
    const detail = JSON.stringify(rawInput, null, 2).slice(0, 1200)
    const diff = (toolCall.content || []).find(c => c && c.type === 'diff')
    let previewed = false
    if (diff && previewProvider) {
      try {
        await previewProvider.show(diff, `Mercury: ${title} · ${path.basename(diff.path)} (preview)`)
        previewed = true
      } catch (e) {
        log(`preview failed: ${e.message}`)
      }
    }
    const options = params.options || []
    const allowOnce = options.find(o => o.kind === 'allow_once')
    const allowAlways = options.find(o => o.kind === 'allow_always')
    const deny = options.find(o => o.kind && String(o.kind).startsWith('reject'))
    const buttons = ['Allow', ...(allowAlways ? ['Always Allow'] : []), 'Deny']
    const pick = await vscode.window.showInformationMessage(
      `Mercury asks: allow ${title}?`,
      { modal: true, detail: previewed ? `The diff is open beside this dialog.\n\n${detail}` : detail },
      ...buttons,
    )
    if (previewed) previewProvider.hide()
    if (pick === 'Allow' && allowOnce) {
      respond({ outcome: { outcome: 'selected', optionId: allowOnce.optionId } })
    } else if (pick === 'Always Allow' && allowAlways) {
      respond({ outcome: { outcome: 'selected', optionId: allowAlways.optionId } })
    } else if (deny) {
      respond({ outcome: { outcome: 'selected', optionId: deny.optionId } })
    } else {
      respond({ outcome: { outcome: 'cancelled' } })
    }
    return
  }
}


class PreviewProvider {
  constructor() {
    this.docs = new Map()
    this.emitter = new vscode.EventEmitter()
    this.onDidChange = this.emitter.event
    this.openUris = []
  }
  provideTextDocumentContent(uri) {
    return this.docs.get(uri.toString()) || ''
  }
  async show(diff, title) {
    const id = randomUUID().slice(0, 8)
    const name = path.basename(diff.path)
    const left = vscode.Uri.parse(`mercury-preview:/${id}/before/${name}`)
    const right = vscode.Uri.parse(`mercury-preview:/${id}/after/${name}`)
    this.docs.set(left.toString(), typeof diff.oldText === 'string' ? diff.oldText : '')
    this.docs.set(right.toString(), diff.newText || '')
    this.openUris = [left, right]
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, preserveFocus: true })
  }
  hide() {
    const uris = this.openUris
    this.openUris = []
    void closeTabsWhere(tab => {
      const input = tab.input
      return (
        input &&
        input.original &&
        input.modified &&
        uris.some(u => u.toString() === input.original.toString() || u.toString() === input.modified.toString())
      )
    })
    for (const u of uris) this.docs.delete(u.toString())
  }
}

async function closeTabsWhere(predicate) {
  const groups = vscode.window.tabGroups
  if (!groups || !groups.all) return 0
  const matching = []
  for (const group of groups.all) for (const tab of group.tabs) if (predicate(tab)) matching.push(tab)
  if (matching.length > 0) await groups.close(matching, true)
  return matching.length
}


let chatSeq = 0

function appendChat(entry) {
  const last = chatLog[chatLog.length - 1]
  if (entry.coalesce && last && last.who === entry.who && last.coalesce) {
    last.text += entry.text
    postToChat({ type: 'update', entry: last })
    return
  }
  const row = { id: ++chatSeq, at: Date.now(), ...entry }
  chatLog.push(row)
  if (chatLog.length > 600) chatLog.splice(0, chatLog.length - 600)
  postToChat({ type: 'append', entry: row })
}

function settleChatTool(toolCallId, status) {
  for (let i = chatLog.length - 1; i >= 0; i--) {
    const row = chatLog[i]
    if (row.who === 'tool' && row.toolCallId === toolCallId) {
      row.status = status
      postToChat({ type: 'update', entry: row })
      return
    }
  }
}

function postToChat(message) {
  if (chatPanel) void chatPanel.webview.postMessage(message)
}

function chatHtml(webview) {
  const nonce = randomUUID().replace(/-/g, '')
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body { font-family: var(--vscode-font-family); padding: 0 8px 56px; }
    .row { margin: 6px 0; } .who { opacity: 0.6; font-size: 11px; display: block; }
    pre { margin: 2px 0; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); }
    .you pre { color: var(--vscode-textLink-foreground); }
    .meta pre, .tool pre { opacity: 0.75; }
    .thought { opacity: 0.6; } .thought summary { cursor: pointer; font-size: 11px; }
    .tool .mark { display: inline-block; width: 1.2em; }
    .tool.failed pre { color: var(--vscode-errorForeground); }
    form { position: fixed; bottom: 0; left: 0; right: 0; display: flex; padding: 8px; gap: 6px;
           background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
    input { flex: 1; padding: 6px; background: var(--vscode-input-background);
            color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
    button { padding: 6px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; }
  </style></head><body>
  <div id="log"></div>
  <form id="f"><input id="t" placeholder="Ask Mercury…" autofocus /><button>Send</button></form>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const logEl = document.getElementById('log');
    const marks = { in_progress: '▸', pending: '▸', completed: '✓', failed: '✗' };
    function render(entry) {
      const row = document.createElement('div');
      row.id = 'row-' + entry.id;
      const cls = entry.who === 'you' ? 'you' : entry.who === 'mercury' ? 'mercury' : entry.who === 'tool' ? 'tool' : entry.who === 'thought' ? 'thought' : 'meta';
      row.className = 'row ' + cls + (entry.status === 'failed' ? ' failed' : '');
      if (entry.who === 'thought') {
        const d = document.createElement('details');
        const s = document.createElement('summary'); s.textContent = 'thinking';
        const p = document.createElement('pre'); p.textContent = entry.text;
        d.appendChild(s); d.appendChild(p); row.appendChild(d);
        return row;
      }
      const who = document.createElement('span'); who.className = 'who'; who.textContent = entry.who;
      const pre = document.createElement('pre');
      if (entry.who === 'tool') {
        const m = document.createElement('span'); m.className = 'mark'; m.textContent = marks[entry.status] || '▸';
        pre.appendChild(m); pre.appendChild(document.createTextNode(entry.text));
      } else pre.textContent = entry.text;
      row.appendChild(who); row.appendChild(pre);
      return row;
    }
    function atBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 40; }
    window.addEventListener('message', ev => {
      const msg = ev.data;
      const stick = atBottom();
      if (msg.type === 'reset') { logEl.textContent = ''; for (const e of msg.entries) logEl.appendChild(render(e)); }
      else if (msg.type === 'append') logEl.appendChild(render(msg.entry));
      else if (msg.type === 'update') { const old = document.getElementById('row-' + msg.entry.id); const fresh = render(msg.entry); if (old) old.replaceWith(fresh); else logEl.appendChild(fresh); }
      if (stick) window.scrollTo(0, document.body.scrollHeight);
    });
    document.getElementById('f').addEventListener('submit', e => {
      e.preventDefault();
      const t = document.getElementById('t');
      if (t.value.trim()) { vscodeApi.postMessage({ type: 'prompt', text: t.value }); t.value = ''; }
    });
    vscodeApi.postMessage({ type: 'ready' });
  </script></body></html>`
}

async function openChat(context) {
  if (!chatPanel) {
    chatPanel = vscode.window.createWebviewPanel('mercuryChat', 'Mercury', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    })
    chatPanel.onDidDispose(() => {
      chatPanel = null
    })
    chatPanel.webview.onDidReceiveMessage(async msg => {
      if (msg && msg.type === 'prompt' && typeof msg.text === 'string') {
        await sendPrompt(context, msg.text)
      } else if (msg && msg.type === 'ready') {
        postToChat({ type: 'reset', entries: chatLog })
      }
    })
    chatPanel.webview.html = chatHtml(chatPanel.webview)
  }
  chatPanel.reveal()
}

async function sendPrompt(context, text, extraBlocks) {
  let sessionId
  try {
    sessionId = await ensureSession(context)
  } catch (e) {
    appendChat({ who: 'system', text: `could not start a session: ${e.message}` })
    void vscode.window.showErrorMessage(e.message, 'Show Log').then(pick => pick === 'Show Log' && output && output.show(true))
    return
  }
  const c = await ensureClient(context)
  appendChat({ who: 'you', text })
  lastTurnChangedFiles.clear()
  const prompt = [{ type: 'text', text }, ...(extraBlocks || [])]
  try {
    const res = await c.request('session/prompt', { sessionId, prompt })
    if (res.stopReason !== 'end_turn') appendChat({ who: 'system', text: `turn ended: ${res.stopReason}` })
  } catch (e) {
    appendChat({ who: 'system', text: `turn failed: ${e.message}` })
  }
  refreshAllViews()
}


let contextTimer = null

function liveContextEnabled() {
  return vscode.workspace.getConfiguration('mercury').get('liveContext') !== false
}

function severityWord(severity) {
  return severity === 0 ? 'Error' : severity === 1 ? 'Warning' : severity === 2 ? 'Info' : 'Hint'
}

function openTextTabPaths(limit) {
  const out = []
  const groups = vscode.window.tabGroups
  if (!groups || !groups.all) return out
  for (const group of groups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (input && input.uri && input.uri.scheme === 'file' && !out.includes(input.uri.fsPath)) out.push(input.uri.fsPath)
      if (out.length >= limit) return out
    }
  }
  return out
}

function editorContextWire(sessionId) {
  const wire = { v: 1, sessionId, workspaceFolders: workspaceFolderPaths() }
  const editor = vscode.window.activeTextEditor
  if (editor && editor.document && editor.document.uri.scheme === 'file') {
    const doc = editor.document
    const active = { path: doc.uri.fsPath, languageId: doc.languageId }
    const sel = editor.selection
    if (sel && !sel.isEmpty) {
      active.selection = {
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        text: doc.getText(sel).slice(0, 8000),
      }
    }
    wire.activeFile = active
    const diags = vscode.languages.getDiagnostics(doc.uri) || []
    wire.diagnostics = diags.slice(0, 25).map(d => ({
      path: doc.uri.fsPath,
      line: d.range.start.line + 1,
      severity: severityWord(d.severity),
      message: d.message,
    }))
  }
  wire.openFiles = openTextTabPaths(30)
  return wire
}

function pushEditorContext() {
  if (!client || !activeSessionId || !liveContextEnabled()) return
  if (contextTimer) clearTimeout(contextTimer)
  contextTimer = setTimeout(() => {
    contextTimer = null
    if (!client || !activeSessionId) return
    client.notify('_mercury/editor_context', editorContextWire(activeSessionId))
  }, 250)
}


class SimpleTree {
  constructor(fetchRows) {
    this.fetchRows = fetchRows
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.emitter.event
  }
  refresh() {
    this.emitter.fire(undefined)
  }
  getTreeItem(item) {
    return item
  }
  async getChildren(element) {
    if (element) return []
    try {
      return await this.fetchRows()
    } catch (e) {
      const item = new vscode.TreeItem(`unavailable: ${e.message}`)
      return [item]
    }
  }
}

let sessionsTree = null
let workbenchTree = null
let artifactsTree = null
let attentionTree = null

function refreshAllViews() {
  if (sessionsTree) sessionsTree.refresh()
  if (workbenchTree) workbenchTree.refresh()
  if (artifactsTree) artifactsTree.refresh()
  if (attentionTree) attentionTree.refresh()
}

function treeItem(label, description, tooltip, command) {
  const item = new vscode.TreeItem(label)
  if (description) item.description = description
  if (tooltip) item.tooltip = tooltip
  if (command) item.command = command
  return item
}


async function showReviewComments(context) {
  const c = await ensureClient(context)
  const artifacts = await c.request('_mercury/artifacts', {})
  if (!decorationType) {
    decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
      after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorWarning.foreground') },
    })
  }
  let decorated = 0
  for (const editor of vscode.window.visibleTextEditors) {
    const relative = vscode.workspace.asRelativePath(editor.document.uri, false)
    const ranges = []
    for (const head of artifacts.heads || []) {
      const detail = await c.request('_mercury/artifact', { id: head.id })
      for (const comment of detail.comments || []) {
        const anchor = comment.anchor || {}
        if (anchor.t === 'diff-line' && anchor.path === relative && comment.state !== 'resolved') {
          const line = Math.max(0, (anchor.line || 1) - 1)
          if (line < editor.document.lineCount) {
            ranges.push({
              range: editor.document.lineAt(line).range,
              renderOptions: {
                after: { contentText: ` ⚑ ${comment.state === 'outdated' ? 'OUTDATED · ' : ''}${comment.body.slice(0, 80)}` },
              },
            })
            decorated++
          }
        }
      }
    }
    editor.setDecorations(decorationType, ranges)
  }
  vscode.window.setStatusBarMessage(`Mercury: ${decorated} review comment(s) decorated`, 5000)
}


function activate(context) {
  output = vscode.window.createOutputChannel('Mercury')
  context.subscriptions.push(output)
  extensionVersion = (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || '0.0.0'
  usageStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  usageStatus.command = 'mercury.openChat'
  context.subscriptions.push(usageStatus)
  previewProvider = new PreviewProvider()
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('mercury-preview', previewProvider))

  sessionsTree = new SimpleTree(async () => {
    const c = await ensureClient(context)
    const list = await c.request('session/list', {})
    return (list.sessions || []).slice(0, 30).map(s =>
      treeItem(
        s.title || s.sessionId.slice(0, 8),
        s.sessionId === activeSessionId ? 'active' : '',
        s.cwd,
        { command: 'mercury.resumeSession', title: 'resume', arguments: [s.sessionId] },
      ),
    )
  })
  workbenchTree = new SimpleTree(async () => {
    const c = await ensureClient(context)
    const snap = await c.request('_mercury/workbench', {})
    const rows = []
    for (const t of snap.threads || []) {
      rows.push(treeItem(t.title, `${t.kind} · ${t.phase}`, t.worktreePath || ''))
    }
    for (const lane of snap.lanes || []) {
      rows.push(treeItem(`lane ${lane.laneId}`, `${lane.source} · ${lane.status}`, lane.worktreePath || ''))
    }
    if (rows.length === 0) rows.push(treeItem(snap.unavailable ? `unavailable: ${snap.unavailable}` : 'no running work', '', ''))
    return rows
  })
  artifactsTree = new SimpleTree(async () => {
    const c = await ensureClient(context)
    const artifacts = await c.request('_mercury/artifacts', {})
    const rows = (artifacts.heads || []).map(h =>
      treeItem(
        h.title,
        `${h.kind} v${h.latestVersion} · ${h.status}${h.stale ? ' · STALE' : ''}`,
        `${h.openComments} open comment(s)`,
        { command: 'mercury.openArtifact', title: 'open', arguments: [h.id] },
      ),
    )
    if (rows.length === 0) rows.push(treeItem('no review artifacts for this workspace', '', ''))
    return rows
  })
  attentionTree = new SimpleTree(async () => {
    const c = await ensureClient(context)
    const snap = await c.request('_mercury/workbench', {})
    const attention = snap.attention
    if (!attention) {
      return [
        treeItem(
          snap.unavailable ? `workbench unavailable: ${snap.unavailable}` : 'attention unavailable',
          '',
          '',
        ),
      ]
    }
    const rows = []
    const BUCKETS = ['needs-you', 'ready-to-review', 'stalled', 'working', 'completed']
    for (const bucket of BUCKETS) {
      const items = (attention.buckets && attention.buckets[bucket]) || []
      if (items.length === 0) continue
      rows.push(treeItem(`${bucket.toUpperCase()} (${items.length})`, '', ''))
      for (const item of items) {
        rows.push(
          treeItem(
            `  ${item.title || item.subjectId}`,
            item.reasonLabel,
            `${bucket} · ${item.reasonCode} · ${item.owner} · ${item.sourceEventId}`,
          ),
        )
      }
    }
    for (const edge of attention.edges || []) {
      rows.push(treeItem(`  ${edge.from} —${edge.kind}→ ${edge.to}`, 'graph', edge.sourceEventId))
    }
    if (rows.length === 0) rows.push(treeItem('nothing needs you', `v${attention.version}`, ''))
    return rows
  })
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mercurySessions', sessionsTree),
    vscode.window.registerTreeDataProvider('mercuryWorkbench', workbenchTree),
    vscode.window.registerTreeDataProvider('mercuryArtifacts', artifactsTree),
    vscode.window.registerTreeDataProvider('mercuryAttention', attentionTree),
  )

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => pushEditorContext()),
    vscode.window.onDidChangeTextEditorSelection(() => pushEditorContext()),
    vscode.window.onDidChangeVisibleTextEditors(() => pushEditorContext()),
    vscode.languages.onDidChangeDiagnostics(() => pushEditorContext()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => pushEditorContext()),
  )

  const register = (name, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, fn))

  register('mercury.openChat', () => openChat(context))
  register('mercury.newSession', async () => {
    activeSessionId = null
    sessionModes = null
    await openChat(context)
    try {
      await ensureSession(context)
    } catch (e) {
      appendChat({ who: 'system', text: `could not start a session: ${e.message}` })
      void vscode.window.showErrorMessage(e.message, 'Show Log').then(pick => pick === 'Show Log' && output && output.show(true))
    }
  })
  register('mercury.resumeSession', async sessionId => {
    const c = await ensureClient(context)
    const picked =
      sessionId ||
      (await (async () => {
        const list = await c.request('session/list', {})
        const items = (list.sessions || []).map(s => ({
          label: s.title || s.sessionId.slice(0, 8),
          description: s.sessionId,
        }))
        const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Resume which Mercury session?' })
        return chosen ? chosen.description : null
      })())
    if (!picked) return
    await openChat(context)
    chatLog.length = 0
    postToChat({ type: 'reset', entries: chatLog })
    const loaded = await c.request('session/load', { sessionId: picked, cwd: workspaceCwd(), mcpServers: [] })
    activeSessionId = picked
    sessionModes = (loaded && loaded.modes) || null
    appendChat({ who: 'system', text: `resumed session ${picked}` })
    refreshAllViews()
    pushEditorContext()
  })
  register('mercury.cancelTurn', async () => {
    if (!client || !activeSessionId) return
    client.notify('session/cancel', { sessionId: activeSessionId })
  })
  register('mercury.askSelection', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const hasSelection = !editor.selection.isEmpty
    const selection = hasSelection ? editor.document.getText(editor.selection) : editor.document.getText()
    const relative = vscode.workspace.asRelativePath(editor.document.uri, false)
    const startLine = editor.selection.start.line + 1
    const endLine = editor.selection.end.line + 1
    const span = hasSelection ? `${relative}:${startLine}-${endLine}` : relative
    const question = await vscode.window.showInputBox({ prompt: `Ask Mercury about ${span}` })
    if (!question) return
    await openChat(context)
    await sendPrompt(context, question, [
      {
        type: 'resource',
        resource: {
          uri: hasSelection ? `${editor.document.uri.toString()}#L${startLine}-L${endLine}` : editor.document.uri.toString(),
          text: selection,
          mimeType: 'text/plain',
        },
      },
    ])
  })
  register('mercury.editSelection', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const relative = vscode.workspace.asRelativePath(editor.document.uri, false)
    const startLine = editor.selection.start.line + 1
    const endLine = editor.selection.end.line + 1
    const instruction = await vscode.window.showInputBox({
      prompt: `Edit ${relative}:${startLine}-${endLine} — what should change?`,
    })
    if (!instruction) return
    await editor.document.save()
    await openChat(context)
    await sendPrompt(
      context,
      `Edit ${relative} lines ${startLine}-${endLine}: ${instruction}. Change only what the instruction requires.`,
    )
    await vscode.commands.executeCommand('mercury.reviewLastTurn')
  })
  register('mercury.reviewLastTurn', async () => {
    const files = [...lastTurnChangedFiles]
    if (files.length === 0) {
      vscode.window.setStatusBarMessage('Mercury: no files changed last turn', 4000)
      return
    }
    for (const file of files.slice(0, 8)) {
      const uri = vscode.Uri.file(file)
      try {
        const gitUri = uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref: 'HEAD' }) })
        await vscode.commands.executeCommand('vscode.diff', gitUri, uri, `Mercury: ${vscode.workspace.asRelativePath(uri, false)} (last turn)`)
      } catch {
        await vscode.window.showTextDocument(uri)
      }
    }
  })
  register('mercury.openArtifact', async id => {
    const c = await ensureClient(context)
    const artifactId =
      id ||
      (await vscode.window.showInputBox({ prompt: 'Artifact id (ra-…)' }))
    if (!artifactId) return
    const detail = await c.request('_mercury/artifact', { id: artifactId })
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: detail.rendered || '(empty artifact)',
    })
    await vscode.window.showTextDocument(doc, { preview: true })
  })
  register('mercury.showReviewComments', () => showReviewComments(context))
  register('mercury.openTerminal', () => {
    const terminal = vscode.window.createTerminal({ name: 'Mercury', cwd: workspaceCwd() })
    terminal.sendText(mercuryPath())
    terminal.show()
  })
  register('mercury.setMode', async () => {
    if (!client || !activeSessionId) {
      vscode.window.setStatusBarMessage('Mercury: start or resume a session first', 4000)
      return
    }
    const modes = (sessionModes && sessionModes.availableModes) || []
    if (modes.length === 0) {
      vscode.window.setStatusBarMessage('Mercury: this session reported no modes', 4000)
      return
    }
    const picked = await vscode.window.showQuickPick(
      modes.map(m => ({
        label: m.name || m.id,
        description: m.id === (sessionModes && sessionModes.currentModeId) ? 'current' : '',
        detail: m.description || '',
        id: m.id,
      })),
      { placeHolder: 'Mercury session mode' },
    )
    if (picked) await client.request('session/set_mode', { sessionId: activeSessionId, modeId: picked.id })
  })
  register('mercury.showLog', () => output && output.show(true))
  register('mercury.refreshViews', refreshAllViews)
}

function deactivate() {
  if (client) client.dispose()
}

module.exports = { activate, deactivate }
