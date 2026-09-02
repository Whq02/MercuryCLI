#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-vscode-bridge.ts — PROOF: the VS Code
//  bridge:
//
//    (1) manifest truth — package.json declares the four views + the full
//        command set with a conservative engines floor and ZERO runtime
//        dependencies (a thin bridge carries no second runtime); every
//        keybinding and menu names a contributed command; every setting
//        carries a description.
//    (2) activation truth — extension.js activates under the stubbed
//        `vscode` module (scripts/editor-bridge/fixtures/vscode-stub.cjs)
//        and registers EXACTLY the commands the manifest contributes (no
//        phantom contributions, no dead commands).
//    (2b) client robustness + the follow-along wire (structural): spawn
//        failures handled, stdin writes guarded, inbound requests always
//        settle, stderr reaches the log, the handshake checks the protocol
//        version, changed files come from the tool_call KIND, the mode
//        picker reads the session's own modes, the permission ask previews
//        the diff natively, the editor context is pushed (never polled).
//    (2c) the terminal bridge, END TO END against a real MCP client over
//        SSE: the extension advertises itself where Mercury looks (the
//        config home's ide/<port>.lock with pid · workspaceFolders ·
//        ideName · transport), stamps MERCURY_IDE_PORT into the terminal
//        environment, answers initialize/tools/list/tools/call
//        (getWorkspaceFolders · getDiagnostics · openFile), pushes
//        selection_changed and at_mentioned, runs openDiff through the
//        editor's diff view to FILE_SAVED (with the operator's text) and
//        TAB_CLOSED, and withdraws the advertisement on deactivate.
//    (3) the .vsix builds deterministically (hand-built stable-OPC zip, no
//        downloads) with every required member; two builds are
//        byte-identical; the staged manifest carries the harness version.
//    (4) `mercury editor status` runs E2E from the dist bundle and answers
//        honestly on a machine without the `code` CLI (the manual path).
//    (5) the packager's TOP_ALLOWLIST admits mercury-vscode.vsix on both
//        platforms (the distribution contract).
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-vscode-bridge.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const NODE = execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-vsix-'))
const children: ChildProcess[] = []
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

const EXTENSION = join(process.cwd(), 'integrations/vscode/extension.js')
const HARNESS = join(process.cwd(), 'scripts/editor-bridge/fixtures/vscode-bridge-harness.cjs')

const manifest = JSON.parse(readFileSync('integrations/vscode/package.json', 'utf8')) as {
  engines: { vscode: string }
  main: string
  dependencies?: Record<string, string>
  contributes: {
    views: Record<string, Array<{ id: string }>>
    commands: Array<{ command: string }>
    keybindings?: Array<{ command: string; key: string }>
    menus?: Record<string, Array<{ command: string }>>
    configuration?: { properties: Record<string, { description?: string }> }
  }
}

section('(1) manifest truth')
{
  check('engines floor declared', /^\^1\.\d+\.\d+$/.test(manifest.engines.vscode), manifest.engines.vscode)
  check('zero runtime dependencies', manifest.dependencies === undefined)
  const viewIds = Object.values(manifest.contributes.views).flat().map(v => v.id)
  check(
    'the four views are contributed',
    ['mercurySessions', 'mercuryWorkbench', 'mercuryArtifacts', 'mercuryAttention'].every(id => viewIds.includes(id)),
    viewIds.join(','),
  )
  const commands = manifest.contributes.commands.map(c => c.command)
  for (const required of [
    'mercury.openChat',
    'mercury.newSession',
    'mercury.resumeSession',
    'mercury.cancelTurn',
    'mercury.askSelection',
    'mercury.editSelection',
    'mercury.reviewLastTurn',
    'mercury.openArtifact',
    'mercury.showReviewComments',
    'mercury.openTerminal',
    'mercury.mentionInTerminal',
    'mercury.setMode',
    'mercury.showLog',
    'mercury.refreshViews',
  ]) {
    check(`command contributed: ${required}`, commands.includes(required))
  }
  check('main points at extension.js', manifest.main === './extension.js' && existsSync('integrations/vscode/extension.js'))
  const keyCommands = (manifest.contributes.keybindings ?? []).map(k => k.command)
  check('keybindings exist and name contributed commands', keyCommands.length >= 4 && keyCommands.every(c => commands.includes(c)), keyCommands.join(','))
  const menuCommands = Object.values(manifest.contributes.menus ?? {}).flat().map(m => m.command)
  check('menus name contributed commands', menuCommands.length >= 3 && menuCommands.every(c => commands.includes(c)), menuCommands.join(','))
  const settings = manifest.contributes.configuration?.properties ?? {}
  check(
    'every setting carries a description (path · liveContext · terminalBridge)',
    ['mercury.path', 'mercury.liveContext', 'mercury.terminalBridge'].every(k => typeof settings[k]?.description === 'string' && settings[k]!.description!.length > 20),
    Object.keys(settings).join(','),
  )
}

section('(2) activation truth under the stubbed vscode module')
{
  const result = execFileSync(NODE, [join(process.cwd(), 'scripts/editor-bridge/fixtures/vscode-activation-probe.cjs'), EXTENSION], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'activation-home'), MERCURY_STUB_WORKSPACE: scratch },
  })
  const parsed = JSON.parse(result.trim().split('\n').pop()!) as { registered: string[]; subscriptions: number }
  check('activate ran + pushed disposables', parsed.subscriptions > 0)
  const contributed = new Set(manifest.contributes.commands.map(c => c.command))
  const registered = new Set(parsed.registered)
  const phantom = [...contributed].filter(c => !registered.has(c))
  const dead = [...registered].filter(c => !contributed.has(c))
  check('every contributed command registers', phantom.length === 0, phantom.join(','))
  check('no unregistered phantom commands', dead.length === 0, dead.join(','))
}

section('(2b) client robustness + the follow-along wire (structural)')
{
  const ext = readFileSync('integrations/vscode/extension.js', 'utf8')
  check("spawn failures are handled (child.on('error'))", ext.includes("this.child.on('error'"))
  check('stdin writes are guarded (safeWrite)', ext.includes('safeWrite(payload)'))
  check('inbound requests ALWAYS settle (responded-once + catch)', ext.includes('let responded = false') && ext.includes(".catch(() => respond({ outcome: { outcome: 'cancelled' } }))"))
  check('stderr reaches the log and names the exit cause', ext.includes("this.child.stderr.on('data'") && ext.includes('stderrTail'))
  check('the handshake checks the protocol version and names the next step', ext.includes('init.protocolVersion !== ACP_PROTOCOL_VERSION') && ext.includes('mercury editor install'))
  check(
    'changed files come from the tool_call KIND, never the title',
    ext.includes("update.kind === 'edit' || update.kind === 'delete' || update.kind === 'move'") && !ext.includes("['Write', 'Edit', 'MultiEdit', 'NotebookEdit']"),
  )
  check('the mode picker reads the session\'s own modes', ext.includes('sessionModes.availableModes') && !ext.includes("['default', 'acceptEdits', 'plan', 'auto']"))
  check('the permission ask previews the diff natively', ext.includes("c.type === 'diff'") && ext.includes("'vscode.diff'") && ext.includes('mercury-preview'))
  check('the editor context is PUSHED (a notification on change, debounced)', ext.includes("client.notify('_mercury/editor_context'") && ext.includes('onDidChangeTextEditorSelection(() => pushEditorContext())'))
  check('the chat webview renders incrementally with a CSP (no whole re-render per chunk)', ext.includes('Content-Security-Policy') && ext.includes("postToChat({ type: 'append'") && !ext.includes('chatPanel.webview.html = chatHtml()'))
  check('thoughts cross to the chat', ext.includes("'agent_thought_chunk'"))
  const child = readFileSync('src/services/acp/childSession.ts', 'utf8')
  check('the ACP child pipe is crash-isolated', child.includes("this.child.on('error'") && child.includes('private writeFrame'))
}

section('(2c) the terminal bridge — a real MCP client over SSE')
{
  const configHome = join(scratch, 'config-home')
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const editedFile = join(workspace, 'stub.ts')
  writeFileSync(editedFile, 'line one\nline two\nline three\nline four\nline five\n')

  const harness = spawn(NODE, [HARNESS, EXTENSION], {
    env: { ...process.env, MERCURY_CONFIG_DIR: configHome, MERCURY_STUB_WORKSPACE: workspace },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  children.push(harness)
  const events: Array<Record<string, unknown>> = []
  let buffer = ''
  harness.stdout!.setEncoding('utf8')
  harness.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line !== '') {
        try {
          events.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          /* not a harness line */
        }
      }
      idx = buffer.indexOf('\n')
    }
  })
  const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (cond()) return true
      await new Promise(r => setTimeout(r, 25))
    }
    return cond()
  }
  const send = (command: string): void => {
    harness.stdin!.write(`${command}\n`)
  }

  const ready = await until(() => events.some(e => e.event === 'ready'), 15_000)
  check('the extension activated under the stub', ready, JSON.stringify(events).slice(0, 200))
  const gotEnv = await until(() => events.some(e => e.event === 'env' && e.name === 'MERCURY_IDE_PORT'), 15_000)
  const envEvent = events.find(e => e.event === 'env' && e.name === 'MERCURY_IDE_PORT')
  const port = Number(envEvent?.value ?? 0)
  check('MERCURY_IDE_PORT is stamped into the terminal environment', gotEnv && port > 0, JSON.stringify(envEvent ?? null))

  const lockDir = join(configHome, 'ide')
  const lockNames = existsSync(lockDir) ? readdirSync(lockDir).filter(n => n.endsWith('.lock')) : []
  check('one advertisement file exists in the config home\'s ide/ (where Mercury looks)', lockNames.length === 1 && lockNames[0] === `${port}.lock`, lockNames.join(','))
  const lock = lockNames.length === 1 ? (JSON.parse(readFileSync(join(lockDir, lockNames[0]!), 'utf8')) as Record<string, unknown>) : {}
  check(
    'the advertisement carries pid · workspaceFolders · ideName · transport sse',
    lock.pid === harness.pid && Array.isArray(lock.workspaceFolders) && (lock.workspaceFolders as string[]).includes(workspace) && lock.ideName === 'VS Code' && lock.transport === 'sse',
    JSON.stringify(lock),
  )

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
  const mcp = new Client({ name: 'mercury-bridge-prover', version: '0.0.0' })
  const notifications: Array<{ method: string; params?: unknown }> = []
  mcp.fallbackNotificationHandler = async n => {
    notifications.push(n as { method: string; params?: unknown })
  }
  let connected = false
  try {
    await mcp.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)))
    connected = true
  } catch (e) {
    check('the MCP client connected over SSE', false, (e as Error).message)
  }
  if (connected) {
    check('the MCP client connected over SSE', true)
    const info = mcp.getServerVersion()
    check('serverInfo names the bridge', info?.name === 'mercury-vscode', JSON.stringify(info ?? null))
    await mcp.notification({ method: 'ide_connected', params: { pid: process.pid } })

    const tools = (await mcp.listTools()).tools.map(t => t.name)
    for (const name of ['openDiff', 'close_tab', 'closeAllDiffTabs', 'openFile', 'getDiagnostics', 'getOpenEditors', 'getWorkspaceFolders', 'getCurrentSelection', 'getLatestSelection', 'checkDocumentDirty', 'saveDocument']) {
      check(`tool listed: ${name}`, tools.includes(name))
    }

    const textOf = (result: unknown): string => {
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
      return content.find(c => c.type === 'text')?.text ?? ''
    }
    const folders = JSON.parse(textOf(await mcp.callTool({ name: 'getWorkspaceFolders', arguments: {} }))) as { success: boolean; folders: Array<{ path: string }> }
    check('getWorkspaceFolders answers the window\'s folders', folders.success === true && folders.folders[0]?.path === workspace, JSON.stringify(folders))

    const diags = JSON.parse(textOf(await mcp.callTool({ name: 'getDiagnostics', arguments: {} }))) as Array<{ uri: string; diagnostics: Array<{ severity: string; message: string; range: { start: { line: number } } }> }>
    check(
      'getDiagnostics answers the wire shape (uri · severity word · range)',
      diags.length === 1 && diags[0]!.uri.startsWith('file://') && diags[0]!.diagnostics[0]?.severity === 'Error' && diags[0]!.diagnostics[0]?.range.start.line === 1,
      JSON.stringify(diags),
    )
    const one = JSON.parse(textOf(await mcp.callTool({ name: 'getDiagnostics', arguments: { uri: `file://${editedFile}` } }))) as unknown[]
    check('getDiagnostics narrows to one file', one.length === 1)

    const opened = textOf(await mcp.callTool({ name: 'openFile', arguments: { filePath: editedFile, preview: false, startText: 'line two', endText: 'line three', selectToEndOfLine: false, makeFrontmost: false } }))
    check('openFile opens the file', opened.includes('opened'), opened)

    send('select')
    const gotSelection = await until(() => notifications.some(n => n.method === 'selection_changed'), 5_000)
    const sel = notifications.find(n => n.method === 'selection_changed')?.params as { text?: string; filePath?: string; selection?: { start: { line: number }; end: { line: number } } } | undefined
    check(
      'the operator\'s selection is PUSHED as selection_changed (text · filePath · range)',
      gotSelection && sel?.text === 'line three\nline four' && sel?.filePath === editedFile && sel?.selection?.start.line === 2 && sel?.selection?.end.line === 3,
      JSON.stringify(sel ?? null),
    )

    send('mention')
    const gotMention = await until(() => notifications.some(n => n.method === 'at_mentioned'), 5_000)
    const mention = notifications.find(n => n.method === 'at_mentioned')?.params as { filePath?: string; lineStart?: number; lineEnd?: number } | undefined
    check('Send Selection to the Terminal pushes at_mentioned with 1-based lines', gotMention && mention?.filePath === editedFile && mention?.lineStart === 3 && mention?.lineEnd === 4, JSON.stringify(mention ?? null))

    // openDiff → the editor's diff view → the operator saves (with their
    // own edit) → FILE_SAVED + the saved text.
    const diffDone = mcp.callTool({ name: 'openDiff', arguments: { old_file_path: editedFile, new_file_path: editedFile, new_file_contents: 'proposed\n', tab_name: 'Mercury diff T1' } })
    const diffOpened = await until(() => events.some(e => e.event === 'diff' && e.title === 'Mercury diff T1'), 5_000)
    const diffEvent = events.find(e => e.event === 'diff' && e.title === 'Mercury diff T1')
    check('openDiff opened the editor\'s diff view on the mercury-diff scheme', diffOpened && String(diffEvent?.left).startsWith('mercury-diff:') && String(diffEvent?.right).startsWith('mercury-diff:'), JSON.stringify(diffEvent ?? null))
    send('save')
    const saved = (await diffDone) as { content: Array<{ type: string; text?: string }> }
    check('a save settles openDiff as FILE_SAVED with the operator\'s text', saved.content[0]?.text === 'FILE_SAVED' && saved.content[1]?.text === 'operator edited\n', JSON.stringify(saved.content))

    // openDiff → close_tab from Mercury → TAB_CLOSED.
    const diff2 = mcp.callTool({ name: 'openDiff', arguments: { old_file_path: editedFile, new_file_path: editedFile, new_file_contents: 'second\n', tab_name: 'Mercury diff T2' } })
    await until(() => events.some(e => e.event === 'diff' && e.title === 'Mercury diff T2'), 5_000)
    const closed = textOf(await mcp.callTool({ name: 'close_tab', arguments: { tab_name: 'Mercury diff T2' } }))
    const second = (await diff2) as { content: Array<{ type: string; text?: string }> }
    check('close_tab settles the open diff as TAB_CLOSED', closed === 'TAB_CLOSED' && second.content[0]?.text === 'TAB_CLOSED', JSON.stringify(second.content))

    const dirty = JSON.parse(textOf(await mcp.callTool({ name: 'checkDocumentDirty', arguments: { filePath: editedFile } }))) as { success: boolean; isDirty: boolean }
    check('checkDocumentDirty answers', dirty.success === true && dirty.isDirty === false)
    const unknown = (await mcp.callTool({ name: 'noSuchTool', arguments: {} })) as { isError?: boolean }
    check('an unknown tool is an error result, never a hang', unknown.isError === true)
    await mcp.close().catch(() => {})
  }

  send('deactivate')
  const gone = await until(() => events.some(e => e.event === 'deactivated'), 5_000)
  const after = existsSync(lockDir) ? readdirSync(lockDir).filter(n => n.endsWith('.lock')) : []
  check('deactivate withdraws the advertisement', gone && after.length === 0, after.join(','))
  check('deactivate clears the terminal environment', events.some(e => e.event === 'env' && e.name === null))
  await until(() => harness.exitCode !== null, 5_000)
}

section('(3) deterministic .vsix build')
{
  execFileSync('bash', ['scripts/vscode/build-vsix.sh'], { stdio: 'pipe', timeout: 60_000 })
  const first = createHash('sha256').update(readFileSync('dist/mercury-vscode.vsix')).digest('hex')
  copyFileSync('dist/mercury-vscode.vsix', join(scratch, 'first.vsix'))
  execFileSync('bash', ['scripts/vscode/build-vsix.sh'], { stdio: 'pipe', timeout: 60_000 })
  const second = createHash('sha256').update(readFileSync('dist/mercury-vscode.vsix')).digest('hex')
  check('two builds byte-identical', first === second)
  const listing = execFileSync('unzip', ['-l', 'dist/mercury-vscode.vsix'], { encoding: 'utf8' })
  for (const member of [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/package.json',
    'extension/extension.js',
    'extension/LICENSE.txt',
  ]) {
    check(`vsix member: ${member}`, listing.includes(member))
  }
  // The staged manifest carries the harness version — the one number the
  // status verb, the /ide up-to-date check and the skew check all read.
  const staged = execFileSync('unzip', ['-p', 'dist/mercury-vscode.vsix', 'extension/package.json'], { encoding: 'utf8' })
  const harnessVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
  check('the staged manifest carries the harness version', (JSON.parse(staged) as { version: string }).version === harnessVersion, `${(JSON.parse(staged) as { version: string }).version} vs ${harnessVersion}`)
}

section('(4) mercury editor status — honest E2E from the dist bundle')
{
  if (!existsSync('dist/mercury.mjs')) {
    check('dist present for the editor E2E', false, 'run bun run build.ts')
  } else {
    const out = execFileSync(NODE, ['dist/mercury.mjs', 'editor', 'status'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: '/usr/bin:/bin' }, // hide any code CLI — the manual path is the covered one
    })
    check('status exits 0 without the code CLI', true)
    check('vsix located or honestly named missing', out.includes('vsix:'))
    check('manual instructions offered without code', out.includes('manual install') || out.includes('editor CLI:'))
    let badExit = 0
    try {
      execFileSync(NODE, ['dist/mercury.mjs', 'editor', 'bogus'], {
        encoding: 'utf8',
        timeout: 60_000,
      })
    } catch (e) {
      badExit = (e as { status?: number }).status ?? 0
    }
    check('unknown action exits 2 with usage', badExit === 2)
  }
}

section('(5) the distribution contract')
{
  const packager = readFileSync('scripts/release/package.mjs', 'utf8')
  // The allowlist moved to the ONE member-role authority (payloadContract.mjs,
  // UPDATE-RELIABILITY U2) — assert the derived lists, not packager source text.
  const { topAllowlist, readCompatFloor } = await import('../release/payloadContract.mjs')
  const floor = readCompatFloor()
  check(
    'the member-role authority admits the vsix on BOTH platforms',
    topAllowlist('windows-x64', floor).includes('mercury-vscode.vsix') && topAllowlist('linux-x64', floor).includes('mercury-vscode.vsix'),
  )
  check('the packager builds + stages the vsix', packager.includes('build-vsix.sh') && packager.includes("join(pkgDir, 'mercury-vscode.vsix')"))
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ VS Code bridge proofs green')
