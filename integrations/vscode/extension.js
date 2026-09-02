// ============================================================================
//  Mercury VS Code bridge — a THIN client over `mercury acp --stdio` plus
//  the terminal bridge a Mercury session in the integrated terminal attaches
//  to. Zero dependencies: the ACP transport is hand-carried NDJSON JSON-RPC
//  (protocol v1, stable surface), the terminal bridge is an MCP server over
//  Server-Sent Events on node:http, so the .vsix stays small and no second
//  agent runtime exists here.
//
//  Two directions, one extension:
//    · editor → Mercury (ACP): chat, sessions, agents, artifacts, reviews —
//      every fact shown comes from Mercury (session/list, the _mercury/*
//      extension methods); the editor's own state (active file, selection,
//      open files, diagnostics) is PUSHED to the session as it changes.
//    · Mercury → editor (the terminal bridge): a session launched in this
//      window's terminal discovers this extension through its advertisement
//      file and MERCURY_IDE_PORT, reads the editor's selection and
//      diagnostics, opens files, and shows its edits as native diffs the
//      operator accepts or rejects in the editor.
// ============================================================================

'use strict'

const vscode = require('vscode')
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

/** The ACP protocol version this bridge speaks. */
const ACP_PROTOCOL_VERSION = 1
/** The display name the terminal bridge advertises. */
const IDE_NAME = 'VS Code'
/** The virtual scheme the in-editor diff preview lives on. */
const DIFF_SCHEME = 'mercury-diff'

// ── logging ─────────────────────────────────────────────────────────────────

let output = null
function log(line) {
  if (output) output.appendLine(`${new Date().toISOString().slice(11, 19)} ${line}`)
}

// ── NDJSON JSON-RPC client (ACP) ────────────────────────────────────────────

class AcpClient {
  constructor(command, args, cwd, onNotification, onExit) {
    this.nextId = 1
    this.pending = new Map()
    this.onNotification = onNotification
    this.buffer = ''
    this.stderrTail = []
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    // A bad mercury.path fires 'error' (never 'exit') — without this the
    // pending initialize hangs forever and the client wedges permanently.
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
    // stderr is Mercury's diagnostics channel: it goes to the output channel
    // whole, and its tail names the cause when the server exits.
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
      // Inbound request from the agent (session/request_permission). The
      // handler must ALWAYS settle the request — a thrown handler would
      // otherwise wedge the agent-side await until transport close.
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
      /* gone */
    }
  }
}

// ── extension state ─────────────────────────────────────────────────────────

let client = null
let activeSessionId = null
/** The session's modes as the server reported them (session/new · load ·
 *  current_mode_update) — the ONLY source the mode picker reads. */
let sessionModes = null
let chatPanel = null
const chatLog = []
const lastTurnChangedFiles = new Set()
let decorationType = null
let usageStatus = null
let bridgeStatus = null
let extensionVersion = '0.0.0'
let agentVersion = null
/** The pending permission ask's preview, closed when the ask settles. */
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
  // Version skew is named, never guessed around: a protocol the bridge does
  // not speak stops here with the exact next step; a different major of
  // Mercury keeps working with a warning that names both versions.
  if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
    started.dispose()
    client = null
    throw new Error(
      `Mercury speaks ACP v${init.protocolVersion}; this extension speaks v${ACP_PROTOCOL_VERSION}. Reinstall the extension shipped with this Mercury: run \`mercury editor install\`.`,
    )
  }
  agentVersion = init.agentInfo && init.agentInfo.version ? String(init.agentInfo.version) : null
  log(`acp: connected to ${init.agentInfo ? `${init.agentInfo.name} ${agentVersion}` : 'an agent with no agentInfo'}`)
  const agentMajor = majorOf(agentVersion)
  const extMajor = majorOf(extensionVersion)
  if (agentMajor !== null && extMajor !== null && agentMajor !== extMajor) {
    void vscode.window.showWarningMessage(
      `Mercury ${agentVersion} and this extension (${extensionVersion}) are different major versions — run \`mercury editor install\` to match them.`,
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

// ── inbound agent messages ──────────────────────────────────────────────────

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
      // Replayed history on session/load: the operator's own earlier words.
      appendChat({ who: 'you', text: update.content.text, coalesce: true })
    } else if (update.sessionUpdate === 'tool_call') {
      const where = firstLocation(update)
      appendChat({
        who: 'tool',
        toolCallId: update.toolCallId,
        status: update.status || 'in_progress',
        text: `${update.title}${where ? ` · ${where}` : ''}`,
      })
      // Only a MUTATING call names changed files — the protocol's own kind,
      // never a guess from the title: a Read's location must not surface in
      // "Review Last Turn".
      if (update.kind === 'edit' || update.kind === 'delete' || update.kind === 'move') {
        for (const loc of update.locations || []) if (loc && loc.path) lastTurnChangedFiles.add(loc.path)
      }
    } else if (update.sessionUpdate === 'tool_call_update') {
      settleChatTool(update.toolCallId, update.status)
    } else if (update.sessionUpdate === 'plan') {
      // The plan crosses whole (the agent replaces it each update).
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
    // Preview-before-apply: a mutating call carries its diff on the wire,
    // and the preview is the editor's own diff view against the file as it
    // stands — nothing touches disk until the operator allows it.
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

// ── the diff preview (a permission ask's native view) ───────────────────────

/** Two read-only virtual documents per preview — the file as it stands and
 *  the text the tool would write — opened in the editor's own diff view. */
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
    // An absent old text is a new file: the left side is empty by contract.
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

// ── chat panel ──────────────────────────────────────────────────────────────

let chatSeq = 0

function appendChat(entry) {
  const last = chatLog[chatLog.length - 1]
  // Streamed chunks of one voice coalesce into one row; anything else
  // starts a new row.
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

// ── live editor context → the session ───────────────────────────────────────

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

/** The editor's state as the `_mercury/editor_context` wire: pushed as it
 *  changes, read by Mercury at the next prompt. Absent parts are absent. */
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
  // Debounced: a selection drag fires per keystroke; the session only needs
  // the state it will read at the next prompt.
  contextTimer = setTimeout(() => {
    contextTimer = null
    if (!client || !activeSessionId) return
    client.notify('_mercury/editor_context', editorContextWire(activeSessionId))
  }, 250)
}

// ── tree views ──────────────────────────────────────────────────────────────

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

// ── review decorations ──────────────────────────────────────────────────────

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

// ── the terminal bridge — an MCP server a Mercury session attaches to ───────

/** The bridge home Mercury reads advertisements from: its config home
 *  (MERCURY_CONFIG_DIR wins, then MERCURY_HOME, else ~/.mercury), the `ide`
 *  subdirectory. The same resolution the harness runs. */
function bridgeHome() {
  const home = process.env.MERCURY_CONFIG_DIR || process.env.MERCURY_HOME || path.join(os.homedir(), '.mercury')
  return path.join(home, 'ide')
}

/** In-memory files behind the `mercury-diff` scheme: the file as it stands
 *  on the left (read-only), the proposed text on the right (editable — a
 *  save is the operator's acceptance, possibly with their own changes). */
class DiffFileSystem {
  constructor() {
    this.files = new Map()
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeFile = this.emitter.event
    this.onWrite = null
  }
  watch() {
    return { dispose() {} }
  }
  stat(uri) {
    const entry = this.files.get(uri.toString())
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri)
    return {
      type: vscode.FileType.File,
      ctime: entry.at,
      mtime: entry.at,
      size: entry.data.length,
      permissions: entry.readonly ? vscode.FilePermission.Readonly : undefined,
    }
  }
  readDirectory() {
    return []
  }
  createDirectory() {}
  readFile(uri) {
    const entry = this.files.get(uri.toString())
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri)
    return entry.data
  }
  writeFile(uri, content) {
    const entry = this.files.get(uri.toString())
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri)
    if (entry.readonly) throw vscode.FileSystemError.NoPermissions(uri)
    entry.data = content
    entry.at = Date.now()
    if (this.onWrite) this.onWrite(uri, Buffer.from(content).toString('utf8'))
  }
  delete(uri) {
    this.files.delete(uri.toString())
  }
  rename() {
    throw vscode.FileSystemError.NoPermissions('rename')
  }
  put(uri, text, readonly) {
    this.files.set(uri.toString(), { data: Buffer.from(text, 'utf8'), at: Date.now(), readonly })
  }
  drop(uri) {
    this.files.delete(uri.toString())
  }
}

const TOOL_SCHEMAS = [
  {
    name: 'openDiff',
    description: 'Open a native diff of a proposed file change; resolves when the operator saves (FILE_SAVED + the saved text), closes the tab (DIFF_REJECTED), or the tab is closed by close_tab (TAB_CLOSED).',
    inputSchema: {
      type: 'object',
      properties: {
        old_file_path: { type: 'string' },
        new_file_path: { type: 'string' },
        new_file_contents: { type: 'string' },
        tab_name: { type: 'string' },
      },
      required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close the diff tab opened by openDiff with this tab name.',
    inputSchema: { type: 'object', properties: { tab_name: { type: 'string' } }, required: ['tab_name'] },
  },
  { name: 'closeAllDiffTabs', description: 'Close every diff tab openDiff opened.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'openFile',
    description: 'Open a file in the editor; optionally select the span between startText and endText.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        preview: { type: 'boolean' },
        startText: { type: 'string' },
        endText: { type: 'string' },
        selectToEndOfLine: { type: 'boolean' },
        makeFrontmost: { type: 'boolean' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'getDiagnostics',
    description: 'Language diagnostics for one file (uri) or for every open file.',
    inputSchema: { type: 'object', properties: { uri: { type: 'string' } } },
  },
  { name: 'getOpenEditors', description: 'The open editor tabs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'getWorkspaceFolders', description: 'The workspace folders of this window.', inputSchema: { type: 'object', properties: {} } },
  { name: 'getCurrentSelection', description: 'The active editor selection (file, range, text).', inputSchema: { type: 'object', properties: {} } },
  { name: 'getLatestSelection', description: 'The most recent non-empty selection.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'checkDocumentDirty',
    description: 'Whether the file has unsaved changes in the editor.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
  },
  {
    name: 'saveDocument',
    description: 'Save the file if it is open in the editor.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
  },
]

function selectionWire(editor) {
  if (!editor || !editor.document) return { success: false, text: '', selection: null }
  const sel = editor.selection
  const doc = editor.document
  return {
    success: true,
    text: doc.getText(sel),
    filePath: doc.uri.fsPath,
    fileUrl: doc.uri.toString(),
    selection: {
      start: { line: sel.start.line, character: sel.start.character },
      end: { line: sel.end.line, character: sel.end.character },
      isEmpty: sel.isEmpty,
    },
  }
}

class TerminalBridge {
  constructor(context) {
    this.context = context
    this.server = null
    this.port = null
    this.lockPath = null
    this.streams = new Map()
    this.attachedPid = null
    this.fsProvider = new DiffFileSystem()
    this.diffs = new Map()
    this.latestSelection = null
    this.selectionTimer = null
    this.disposables = []
    this.disposables.push(vscode.workspace.registerFileSystemProvider(DIFF_SCHEME, this.fsProvider, { isCaseSensitive: true }))
    this.fsProvider.onWrite = (uri, text) => this.onDiffSaved(uri, text)
    if (vscode.window.tabGroups && vscode.window.tabGroups.onDidChangeTabs) {
      this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(e => this.onTabsChanged(e)))
    }
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (!e.selections[0].isEmpty) this.latestSelection = selectionWire(e.textEditor)
        this.queueSelection(e.textEditor)
      }),
    )
  }

  async start() {
    if (this.server) return
    const server = http.createServer((req, res) => this.onRequest(req, res))
    // Loopback only: the bridge is this machine's editor for this machine's
    // terminal; nothing listens on an outward interface.
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.server = server
    this.port = server.address().port
    this.writeAdvertisement()
    // The terminal integration: every terminal this window opens carries the
    // port, so a Mercury launched there singles out THIS editor.
    const env = this.context.environmentVariableCollection
    if (env) {
      env.replace('MERCURY_IDE_PORT', String(this.port))
      env.description = 'Mercury: the editor bridge port for terminals in this window'
    }
    log(`terminal bridge: listening on 127.0.0.1:${this.port}, advertised at ${this.lockPath}`)
    this.updateStatus()
  }

  writeAdvertisement() {
    const dir = bridgeHome()
    try {
      fs.mkdirSync(dir, { recursive: true })
      this.lockPath = path.join(dir, `${this.port}.lock`)
      fs.writeFileSync(
        this.lockPath,
        JSON.stringify({
          pid: process.pid,
          workspaceFolders: workspaceFolderPaths(),
          ideName: IDE_NAME,
          transport: 'sse',
        }),
      )
    } catch (e) {
      log(`terminal bridge: could not write the advertisement in ${dir}: ${e.message}`)
      void vscode.window.showWarningMessage(`Mercury terminal bridge: could not write ${dir} — a Mercury in this terminal will not find the editor. ${e.message}`)
    }
  }

  stop() {
    if (this.server) {
      for (const res of this.streams.values()) {
        try {
          res.end()
        } catch {
          /* gone */
        }
      }
      this.streams.clear()
      this.server.close()
      this.server = null
    }
    if (this.lockPath) {
      try {
        fs.unlinkSync(this.lockPath)
      } catch {
        /* already gone */
      }
      this.lockPath = null
    }
    const env = this.context.environmentVariableCollection
    if (env) env.clear()
    this.port = null
    this.attachedPid = null
    this.updateStatus()
  }

  dispose() {
    this.stop()
    for (const d of this.disposables) d.dispose()
  }

  updateStatus() {
    if (!bridgeStatus) return
    if (!this.port) {
      bridgeStatus.text = '$(debug-disconnect) Mercury'
      bridgeStatus.tooltip = 'Mercury terminal bridge is off (mercury.terminalBridge)'
    } else if (this.attachedPid) {
      bridgeStatus.text = '$(plug) Mercury attached'
      bridgeStatus.tooltip = `A Mercury session (pid ${this.attachedPid}) is attached to this editor on port ${this.port}`
    } else {
      bridgeStatus.text = '$(plug) Mercury'
      bridgeStatus.tooltip = `Mercury terminal bridge on port ${this.port} — open a terminal and run mercury; it attaches to this editor`
    }
    bridgeStatus.show()
  }

  // ── HTTP + SSE ──
  onRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/sse') {
      const id = randomUUID()
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(`event: endpoint\ndata: /message?sessionId=${id}\n\n`)
      this.streams.set(id, res)
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          /* closing */
        }
      }, 25000)
      req.on('close', () => {
        clearInterval(keepAlive)
        this.streams.delete(id)
        if (this.streams.size === 0) {
          this.attachedPid = null
          this.updateStatus()
        }
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/message') {
      const id = url.searchParams.get('sessionId')
      const stream = id ? this.streams.get(id) : null
      if (!stream) {
        res.writeHead(404).end('unknown session')
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => {
        body += chunk
        if (body.length > 8 * 1024 * 1024) req.destroy()
      })
      req.on('end', () => {
        res.writeHead(202).end('Accepted')
        let msg
        try {
          msg = JSON.parse(body)
        } catch {
          return
        }
        void this.onMessage(msg, stream)
      })
      return
    }
    res.writeHead(404).end('not found')
  }

  send(stream, msg) {
    try {
      stream.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`)
    } catch (e) {
      log(`terminal bridge: write failed: ${e.message}`)
    }
  }

  broadcast(method, params) {
    for (const stream of this.streams.values()) this.send(stream, { jsonrpc: '2.0', method, params })
  }

  async onMessage(msg, stream) {
    if (msg.method === undefined) return
    if (msg.id === undefined) {
      if (msg.method === 'ide_connected' && msg.params && typeof msg.params.pid === 'number') {
        this.attachedPid = msg.params.pid
        this.updateStatus()
        log(`terminal bridge: Mercury pid ${msg.params.pid} attached`)
      }
      return
    }
    const reply = result => this.send(stream, { jsonrpc: '2.0', id: msg.id, result })
    const fail = (code, message) => this.send(stream, { jsonrpc: '2.0', id: msg.id, error: { code, message } })
    try {
      switch (msg.method) {
        case 'initialize': {
          const requested = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18'
          reply({
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'mercury-vscode', version: extensionVersion },
          })
          return
        }
        case 'ping':
          reply({})
          return
        case 'tools/list':
          reply({ tools: TOOL_SCHEMAS })
          return
        case 'tools/call': {
          const name = msg.params && msg.params.name
          const args = (msg.params && msg.params.arguments) || {}
          reply(await this.callTool(name, args))
          return
        }
        default:
          fail(-32601, `method not found: ${msg.method}`)
      }
    } catch (e) {
      fail(-32603, e.message)
    }
  }

  // ── tools ──
  async callTool(name, args) {
    const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
    const error = message => ({ content: [{ type: 'text', text: message }], isError: true })
    switch (name) {
      case 'openDiff':
        return this.openDiff(args)
      case 'close_tab': {
        const entry = this.diffs.get(args.tab_name)
        if (!entry) return text('TAB_CLOSED')
        this.settleDiff(args.tab_name, [{ type: 'text', text: 'TAB_CLOSED' }])
        return text('TAB_CLOSED')
      }
      case 'closeAllDiffTabs': {
        const names = [...this.diffs.keys()]
        for (const n of names) this.settleDiff(n, [{ type: 'text', text: 'TAB_CLOSED' }])
        return text(`closed ${names.length} diff tab(s)`)
      }
      case 'openFile': {
        if (typeof args.filePath !== 'string') return error('filePath required')
        const uri = vscode.Uri.file(args.filePath)
        const doc = await vscode.workspace.openTextDocument(uri)
        const editor = await vscode.window.showTextDocument(doc, {
          preview: args.preview !== false,
          preserveFocus: args.makeFrontmost === false,
        })
        if (typeof args.startText === 'string' && args.startText !== '') {
          const all = doc.getText()
          const start = all.indexOf(args.startText)
          if (start !== -1) {
            let end = start + args.startText.length
            if (typeof args.endText === 'string' && args.endText !== '') {
              const endAt = all.indexOf(args.endText, end)
              if (endAt !== -1) end = endAt + args.endText.length
            }
            let endPos = doc.positionAt(end)
            if (args.selectToEndOfLine) endPos = doc.lineAt(endPos.line).range.end
            const range = new vscode.Range(doc.positionAt(start), endPos)
            editor.selection = new vscode.Selection(range.start, range.end)
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
          }
        }
        return text(`opened ${args.filePath}`)
      }
      case 'getDiagnostics': {
        const wanted = typeof args.uri === 'string' ? vscode.Uri.parse(args.uri) : null
        const entries = wanted ? [[wanted, vscode.languages.getDiagnostics(wanted)]] : vscode.languages.getDiagnostics()
        const files = []
        for (const [uri, diags] of entries) {
          if (!diags || diags.length === 0) continue
          files.push({
            uri: uri.toString(),
            diagnostics: diags.map(d => ({
              message: d.message,
              severity: severityWord(d.severity),
              range: {
                start: { line: d.range.start.line, character: d.range.start.character },
                end: { line: d.range.end.line, character: d.range.end.character },
              },
              ...(d.source ? { source: d.source } : {}),
            })),
          })
        }
        return text(files)
      }
      case 'getOpenEditors': {
        const tabs = []
        const groups = vscode.window.tabGroups
        for (const group of (groups && groups.all) || []) {
          for (const tab of group.tabs) {
            const input = tab.input
            if (!input || !input.uri) continue
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === input.uri.toString())
            tabs.push({
              uri: input.uri.toString(),
              filePath: input.uri.scheme === 'file' ? input.uri.fsPath : undefined,
              label: tab.label,
              isActive: tab.isActive && group.isActive,
              isDirty: tab.isDirty,
              ...(doc ? { languageId: doc.languageId } : {}),
            })
          }
        }
        return text({ tabs })
      }
      case 'getWorkspaceFolders':
        return text({
          success: true,
          folders: (vscode.workspace.workspaceFolders || []).map(f => ({ name: f.name, uri: f.uri.toString(), path: f.uri.fsPath })),
          rootPath: workspaceCwd(),
        })
      case 'getCurrentSelection':
        return text(selectionWire(vscode.window.activeTextEditor))
      case 'getLatestSelection':
        return text(this.latestSelection || selectionWire(vscode.window.activeTextEditor))
      case 'checkDocumentDirty': {
        if (typeof args.filePath !== 'string') return error('filePath required')
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === args.filePath)
        return text({ success: true, filePath: args.filePath, isOpen: Boolean(doc), isDirty: Boolean(doc && doc.isDirty), isUntitled: Boolean(doc && doc.isUntitled) })
      }
      case 'saveDocument': {
        if (typeof args.filePath !== 'string') return error('filePath required')
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === args.filePath)
        if (!doc) return text({ success: false, message: 'not open in the editor' })
        const saved = await doc.save()
        return text({ success: saved, filePath: args.filePath })
      }
      default:
        return error(`unknown tool: ${name}`)
    }
  }

  // ── openDiff — the editor's own diff view, the operator's own verdict ──
  async openDiff(args) {
    const oldPath = typeof args.old_file_path === 'string' ? args.old_file_path : ''
    const tabName = typeof args.tab_name === 'string' && args.tab_name !== '' ? args.tab_name : `Mercury diff ${this.diffs.size + 1}`
    const newText = typeof args.new_file_contents === 'string' ? args.new_file_contents : ''
    let oldText = ''
    try {
      oldText = fs.readFileSync(oldPath, 'utf8')
    } catch {
      oldText = ''
    }
    if (this.diffs.has(tabName)) this.settleDiff(tabName, [{ type: 'text', text: 'TAB_CLOSED' }])
    const id = randomUUID().slice(0, 8)
    const name = path.basename(args.new_file_path || oldPath || 'file')
    const left = vscode.Uri.parse(`${DIFF_SCHEME}:/${id}/before/${name}`)
    const right = vscode.Uri.parse(`${DIFF_SCHEME}:/${id}/after/${name}`)
    this.fsProvider.put(left, oldText, true)
    this.fsProvider.put(right, newText, false)
    const entry = { left, right, resolve: null, settled: false }
    entry.done = new Promise(resolve => {
      entry.resolve = resolve
    })
    this.diffs.set(tabName, entry)
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right, tabName, { preview: false })
    } catch (e) {
      this.diffs.delete(tabName)
      this.fsProvider.drop(left)
      this.fsProvider.drop(right)
      return { content: [{ type: 'text', text: `could not open the diff: ${e.message}` }], isError: true }
    }
    const content = await entry.done
    return { content }
  }

  settleDiff(tabName, content) {
    const entry = this.diffs.get(tabName)
    if (!entry || entry.settled) return
    entry.settled = true
    this.diffs.delete(tabName)
    entry.resolve(content)
    void closeTabsWhere(tab => {
      const input = tab.input
      return input && input.original && input.modified && input.modified.toString() === entry.right.toString()
    }).finally(() => {
      this.fsProvider.drop(entry.left)
      this.fsProvider.drop(entry.right)
    })
  }

  onDiffSaved(uri, text) {
    for (const [tabName, entry] of this.diffs) {
      if (entry.right.toString() === uri.toString()) {
        this.settleDiff(tabName, [
          { type: 'text', text: 'FILE_SAVED' },
          { type: 'text', text },
        ])
        return
      }
    }
  }

  onTabsChanged(e) {
    for (const tab of e.closed || []) {
      const input = tab.input
      if (!input || !input.modified) continue
      for (const [tabName, entry] of this.diffs) {
        if (entry.right.toString() === input.modified.toString() && !entry.settled) {
          this.settleDiff(tabName, [{ type: 'text', text: 'DIFF_REJECTED' }])
        }
      }
    }
  }

  // ── pushes to the attached session ──
  queueSelection(editor) {
    if (this.streams.size === 0) return
    if (this.selectionTimer) clearTimeout(this.selectionTimer)
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null
      if (!editor || !editor.document || editor.document.uri.scheme !== 'file') return
      const wire = selectionWire(editor)
      this.broadcast('selection_changed', {
        text: wire.text,
        filePath: wire.filePath,
        fileUrl: wire.fileUrl,
        selection: wire.selection,
      })
    }, 100)
  }

  mention(editor) {
    if (!editor || !editor.document || editor.document.uri.scheme !== 'file') return false
    if (this.streams.size === 0) return false
    const sel = editor.selection
    this.broadcast('at_mentioned', {
      filePath: editor.document.uri.fsPath,
      lineStart: sel.start.line + 1,
      lineEnd: sel.end.line + 1,
    })
    return true
  }
}

let terminalBridge = null

function terminalBridgeEnabled() {
  return vscode.workspace.getConfiguration('mercury').get('terminalBridge') !== false
}

async function applyTerminalBridgeSetting(context) {
  if (!terminalBridge) terminalBridge = new TerminalBridge(context)
  if (terminalBridgeEnabled()) {
    try {
      await terminalBridge.start()
    } catch (e) {
      log(`terminal bridge: could not start: ${e.message}`)
      void vscode.window.showWarningMessage(`Mercury terminal bridge could not start: ${e.message}`)
    }
  } else {
    terminalBridge.stop()
  }
}

// ── activation ──────────────────────────────────────────────────────────────

function activate(context) {
  output = vscode.window.createOutputChannel('Mercury')
  context.subscriptions.push(output)
  extensionVersion = (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || '0.0.0'
  usageStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  usageStatus.command = 'mercury.openChat'
  bridgeStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49)
  bridgeStatus.command = 'mercury.openTerminal'
  context.subscriptions.push(usageStatus, bridgeStatus)
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
    // Attention/graph consume CORE state — the versioned wire the ACP server
    // projects from the same owners the TUI reads. No local derivation.
    const c = await ensureClient(context)
    const snap = await c.request('_mercury/workbench', {})
    const attention = snap.attention
    if (!attention) {
      // Absence is named honestly: a disabled workbench is not "dormant".
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

  // The editor's state reaches the session as it changes — push, not poll.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => pushEditorContext()),
    vscode.window.onDidChangeTextEditorSelection(() => pushEditorContext()),
    vscode.window.onDidChangeVisibleTextEditors(() => pushEditorContext()),
    vscode.languages.onDidChangeDiagnostics(() => pushEditorContext()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      pushEditorContext()
      if (terminalBridge && terminalBridge.port) terminalBridge.writeAdvertisement()
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mercury.terminalBridge')) void applyTerminalBridgeSetting(context)
    }),
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
    // The transcript replays as session updates during the load (the chat
    // fills with what the session already said); nothing re-runs.
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
    // The selection rides as an embedded resource whose uri names the span —
    // the model reads a range of the file, never a file that ends there.
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
    // The edit applies through Mercury's own tools; the permission ask
    // carries the diff and opens it natively before anything is written.
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
        // Native diff vs git HEAD via the built-in git content provider.
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
    const terminal = vscode.window.createTerminal({
      name: 'Mercury',
      cwd: workspaceCwd(),
      // The bridge port rides the environment collection for every terminal;
      // this one carries it explicitly too, for a window whose collection
      // was set after the shell started.
      ...(terminalBridge && terminalBridge.port ? { env: { MERCURY_IDE_PORT: String(terminalBridge.port) } } : {}),
    })
    terminal.sendText(mercuryPath())
    terminal.show()
  })
  register('mercury.mentionInTerminal', () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    if (!terminalBridge || !terminalBridge.port) {
      vscode.window.setStatusBarMessage('Mercury: the terminal bridge is off (mercury.terminalBridge)', 4000)
      return
    }
    if (!terminalBridge.mention(editor)) {
      vscode.window.setStatusBarMessage('Mercury: no session is attached — run mercury in a terminal of this window first', 5000)
    }
  })
  register('mercury.setMode', async () => {
    if (!client || !activeSessionId) {
      vscode.window.setStatusBarMessage('Mercury: start or resume a session first', 4000)
      return
    }
    // The modes are the session's own (session/new · session/load report
    // them; current_mode_update keeps the current one) — never a local list.
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

  void applyTerminalBridgeSetting(context)
  context.subscriptions.push({ dispose: () => terminalBridge && terminalBridge.dispose() })
}

function deactivate() {
  if (client) client.dispose()
  if (terminalBridge) terminalBridge.dispose()
}

module.exports = { activate, deactivate }
