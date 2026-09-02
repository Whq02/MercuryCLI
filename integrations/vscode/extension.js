// ============================================================================
//  Mercury VS Code bridge — a THIN client over `mercury acp
//  --stdio`. Zero dependencies: the ACP transport is hand-carried NDJSON
//  JSON-RPC (~protocol v1, stable surface), so the .vsix stays small and no
//  second agent runtime exists here. Every fact shown comes from Mercury —
//  sessions from session/list, agents/lanes/artifacts from the _mercury/*
//  extension methods (the WorkbenchProjection + review-artifact owners).
// ============================================================================

'use strict'

const vscode = require('vscode')
const { spawn } = require('node:child_process')

// ── NDJSON JSON-RPC client ──────────────────────────────────────────────────

class AcpClient {
  constructor(command, args, cwd, onNotification, onExit) {
    this.nextId = 1
    this.pending = new Map()
    this.onNotification = onNotification
    this.buffer = ''
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    // A bad mercury.path fires 'error' (never 'exit') — without this the
    // pending initialize hangs forever and the client wedges permanently.
    this.child.on('error', err => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`mercury acp failed to start: ${err.message}`))
      }
      this.pending.clear()
      if (onExit) onExit(-1)
    })
    this.child.stdin.on('error', () => {})
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => {})
    this.child.on('exit', code => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`mercury acp exited (${code})`))
      }
      this.pending.clear()
      if (onExit) onExit(code)
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
        if (msg.error) pending.reject(new Error(msg.error.message || 'ACP error'))
        else pending.resolve(msg.result)
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
let chatPanel = null
const chatLog = []
const lastTurnChangedFiles = new Set()
let decorationType = null

function workspaceCwd() {
  const folders = vscode.workspace.workspaceFolders
  return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd()
}

async function ensureClient(context) {
  if (client) return client
  const config = vscode.workspace.getConfiguration('mercury')
  const path = config.get('path') || 'mercury'
  const parts = path.split(' ').filter(Boolean)
  const command = parts[0]
  const args = [...parts.slice(1), 'acp', '--stdio']
  client = new AcpClient(command, args, workspaceCwd(), handleAgentMessage, code => {
    client = null
    activeSessionId = null
    if (code !== 0 && code !== null) {
      void vscode.window.showWarningMessage(`Mercury ACP server exited (${code}). Check mercury.path.`)
    }
  })
  context.subscriptions.push({ dispose: () => client && client.dispose() })
  await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  return client
}

async function ensureSession(context) {
  const c = await ensureClient(context)
  if (activeSessionId) return activeSessionId
  const created = await c.request('session/new', { cwd: workspaceCwd(), mcpServers: [] })
  activeSessionId = created.sessionId
  appendChat('system', `session ${activeSessionId} started`)
  refreshAllViews()
  return activeSessionId
}

// ── inbound agent messages ──────────────────────────────────────────────────

async function handleAgentMessage(method, params, respond) {
  if (method === 'session/update' && params && params.update) {
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type === 'text') {
      appendChat('mercury', update.content.text)
    } else if (update.sessionUpdate === 'tool_call') {
      appendChat('tool', `▸ ${update.title}`)
      const input = update.rawInput || {}
      // Only MUTATING tools count as changed files — a Read/Grep file_path
      // must not surface in "Review Last Turn".
      const MUTATING = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
      if (typeof input.file_path === 'string' && MUTATING.includes(String(update.title))) {
        lastTurnChangedFiles.add(input.file_path)
      }
    } else if (update.sessionUpdate === 'tool_call_update') {
      appendChat('tool', `  ${update.status === 'failed' ? '✗' : '✓'} ${update.toolCallId}`)
    } else if (update.sessionUpdate === 'plan') {
      // The plan crosses whole (the agent replaces it each update).
      const entries = update.entries || []
      const line = entries.map(e => `[${e.status}] ${e.content}`).join(' · ')
      appendChat('system', entries.length > 0 ? `plan: ${line}` : 'plan cleared')
      refreshAllViews()
    } else if (update.sessionUpdate === 'usage_update') {
      vscode.window.setStatusBarMessage(
        `Mercury: ${update.used}/${update.size} tokens${update.cost ? ` · $${Number(update.cost.amount).toFixed(4)}` : ''}`,
        8000,
      )
    } else if (update.sessionUpdate === 'current_mode_update') {
      appendChat('system', `mode → ${update.currentModeId}`)
    } else if (update.sessionUpdate === 'config_option_update') {
      const options = update.configOptions || []
      for (const option of options) {
        appendChat('system', `${option.name}: ${option.currentValue}`)
      }
    }
    return
  }
  if (method === 'session/request_permission' && respond) {
    const title = (params.toolCall && params.toolCall.title) || 'a tool'
    const rawInput = (params.toolCall && params.toolCall.rawInput) || {}
    const detail = JSON.stringify(rawInput, null, 2).slice(0, 1200)
    // Preview-before-apply: the ask SHOWS the exact tool input (file + new
    // content for edits) before anything touches disk.
    const pick = await vscode.window.showInformationMessage(
      `Mercury asks: allow ${title}?`,
      { modal: true, detail },
      'Allow',
      'Deny',
    )
    const options = params.options || []
    const allowOption = options.find(o => o.kind && String(o.kind).startsWith('allow'))
    const denyOption = options.find(o => o.kind && String(o.kind).startsWith('reject'))
    if (pick === 'Allow' && allowOption) {
      respond({ outcome: { outcome: 'selected', optionId: allowOption.optionId } })
    } else if (denyOption) {
      respond({ outcome: { outcome: 'selected', optionId: denyOption.optionId } })
    } else {
      respond({ outcome: { outcome: 'cancelled' } })
    }
    return
  }
}

// ── chat panel ──────────────────────────────────────────────────────────────

function appendChat(who, text) {
  chatLog.push({ who, text, at: Date.now() })
  if (chatLog.length > 400) chatLog.splice(0, chatLog.length - 400)
  renderChat()
}

function chatHtml() {
  const rows = chatLog
    .map(entry => {
      const safe = String(entry.text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const cls = entry.who === 'you' ? 'you' : entry.who === 'mercury' ? 'mercury' : 'meta'
      return `<div class="row ${cls}"><span class="who">${entry.who}</span><pre>${safe}</pre></div>`
    })
    .join('\n')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-font-family); padding: 0 8px 48px; }
    .row { margin: 6px 0; } .who { opacity: 0.6; font-size: 11px; display:block; }
    pre { margin: 2px 0; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); }
    .you pre { color: var(--vscode-textLink-foreground); }
    .meta pre { opacity: 0.7; }
    form { position: fixed; bottom: 0; left: 0; right: 0; display: flex; padding: 8px; gap: 6px;
           background: var(--vscode-editor-background); }
    input { flex: 1; padding: 6px; background: var(--vscode-input-background);
            color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
  </style></head><body>
  <div id="log">${rows}</div>
  <form id="f"><input id="t" placeholder="Ask Mercury…" autofocus /><button>Send</button></form>
  <script>
    const vscodeApi = acquireVsCodeApi();
    document.getElementById('f').addEventListener('submit', e => {
      e.preventDefault();
      const t = document.getElementById('t');
      if (t.value.trim()) { vscodeApi.postMessage({ type: 'prompt', text: t.value }); t.value = ''; }
    });
    window.scrollTo(0, document.body.scrollHeight);
  </script></body></html>`
}

function renderChat() {
  if (chatPanel) chatPanel.webview.html = chatHtml()
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
      }
    })
  }
  renderChat()
  chatPanel.reveal()
}

async function sendPrompt(context, text, extraBlocks) {
  const sessionId = await ensureSession(context)
  const c = await ensureClient(context)
  appendChat('you', text)
  lastTurnChangedFiles.clear()
  const prompt = [{ type: 'text', text }, ...(extraBlocks || [])]
  try {
    const res = await c.request('session/prompt', { sessionId, prompt })
    appendChat('system', `turn ${res.stopReason}`)
  } catch (e) {
    appendChat('system', `turn failed: ${e.message}`)
  }
  refreshAllViews()
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

// ── activation ──────────────────────────────────────────────────────────────

function activate(context) {
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
    if (rows.length === 0) rows.push(treeItem('no running work', '', ''))
    return rows
  })
  artifactsTree = new SimpleTree(async () => {
    const c = await ensureClient(context)
    const artifacts = await c.request('_mercury/artifacts', {})
    return (artifacts.heads || []).map(h =>
      treeItem(
        h.title,
        `${h.kind} v${h.latestVersion} · ${h.status}${h.stale ? ' · STALE' : ''}`,
        `${h.openComments} open comment(s)`,
        { command: 'mercury.openArtifact', title: 'open', arguments: [h.id] },
      ),
    )
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

  const register = (name, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, fn))

  register('mercury.openChat', () => openChat(context))
  register('mercury.newSession', async () => {
    activeSessionId = null
    await ensureSession(context)
    await openChat(context)
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
    await c.request('session/load', { sessionId: picked, cwd: workspaceCwd(), mcpServers: [] })
    activeSessionId = picked
    appendChat('system', `resumed session ${picked} (no replay — transcript-backed)`)
    await openChat(context)
    refreshAllViews()
  })
  register('mercury.cancelTurn', async () => {
    if (!client || !activeSessionId) return
    client.notify('session/cancel', { sessionId: activeSessionId })
  })
  register('mercury.askSelection', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const selection = editor.document.getText(editor.selection) || editor.document.getText()
    const relative = vscode.workspace.asRelativePath(editor.document.uri, false)
    const question = await vscode.window.showInputBox({ prompt: `Ask Mercury about ${relative}` })
    if (!question) return
    await openChat(context)
    await sendPrompt(context, question, [
      {
        type: 'resource',
        resource: { uri: editor.document.uri.toString(), text: selection, mimeType: 'text/plain' },
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
    // The edit applies through Mercury's own tools; the permission dialog is
    // the preview gate (it shows the exact file + content before any write).
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
        await vscode.commands.executeCommand('vscode.diff', gitUri, uri, `Mercury: ${file} (last turn)`)
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
    const config = vscode.workspace.getConfiguration('mercury')
    const path = config.get('path') || 'mercury'
    const terminal = vscode.window.createTerminal({ name: 'Mercury', cwd: workspaceCwd() })
    terminal.sendText(path)
    terminal.show()
  })
  register('mercury.setMode', async () => {
    if (!client || !activeSessionId) return
    const mode = await vscode.window.showQuickPick(['default', 'acceptEdits', 'plan', 'auto'], {
      placeHolder: 'Mercury session mode',
    })
    if (mode) await client.request('session/set_mode', { sessionId: activeSessionId, modeId: mode })
  })
  register('mercury.refreshViews', refreshAllViews)
}

function deactivate() {
  if (client) client.dispose()
}

module.exports = { activate, deactivate }
