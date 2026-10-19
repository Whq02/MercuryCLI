#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run bun run build.ts first`)
  process.exit(1)
}
const node = process.execPath.includes('bun') ? 'node' : process.execPath

const configHome = mkdtempSync(join(tmpdir(), 'acp-ide-routing-config-'))
const projDir = mkdtempSync(join(tmpdir(), 'acp-ide-routing-proj-'))
const daemonDir = mkdtempSync(join(tmpdir(), 'acp-ide-routing-daemon-'))
process.env.MERCURY_CONFIG_DIR = configHome
const servers: ChildProcess[] = []
process.on('exit', () => {
  for (const s of servers) {
    try {
      s.kill('SIGKILL')
    } catch {
      continue
    }
  }
  for (const dir of [configHome, projDir, daemonDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      continue
    }
  }
})

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configHome, [projDir])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')

interface ClientHandlers {
  onReadTextFile?: (params: { sessionId: string; path: string; line?: number | null; limit?: number | null }) => { content: string } | Promise<{ content: string }>
  onWriteTextFile?: (params: { sessionId: string; path: string; content: string }) => Record<string, never> | Promise<Record<string, never>>
  onTerminalCreate?: (params: { sessionId: string; command: string; cwd?: string | null }) => { terminalId: string } | Promise<{ terminalId: string }>
  onTerminalOutput?: (params: { sessionId: string; terminalId: string }) => { output: string; truncated: boolean; exitStatus?: { exitCode?: number | null } | null }
  onTerminalWaitForExit?: (params: { sessionId: string; terminalId: string }) => { exitCode?: number | null } | Promise<{ exitCode?: number | null }>
  onTerminalKill?: (params: { sessionId: string; terminalId: string }) => Record<string, never>
  onTerminalRelease?: (params: { sessionId: string; terminalId: string }) => Record<string, never>
  onRequestPermission?: (params: Record<string, unknown>) => { outcome: { outcome: 'selected'; optionId: string } }
}

function connectClient(server: ChildProcess, handlers: ClientHandlers = {}) {
  const updates: Array<Record<string, unknown>> = []
  const permissionAsks: Array<Record<string, unknown>> = []
  const fsReads: Array<{ path: string; line?: number | null; limit?: number | null }> = []
  const fsWrites: Array<{ path: string; content: string }> = []
  const termCalls: Array<{ op: string; payload: Record<string, unknown> }> = []

  const app = acp
    .client({ name: 'ide-routing-proof' })
    .onNotification('session/update', ctx => {
      updates.push(ctx.params.update as unknown as Record<string, unknown>)
    })
    .onRequest('session/request_permission', ctx => {
      const p = ctx.params as unknown as Record<string, unknown>
      permissionAsks.push(p)
      if (handlers.onRequestPermission) return handlers.onRequestPermission(p)
      return { outcome: { outcome: 'selected' as const, optionId: 'allow' } }
    })
    .onRequest('fs/read_text_file', async ctx => {
      fsReads.push({ path: ctx.params.path, line: ctx.params.line, limit: ctx.params.limit })
      if (!handlers.onReadTextFile) throw new Error('fs/read_text_file not configured')
      return handlers.onReadTextFile(ctx.params)
    })
    .onRequest('fs/write_text_file', async ctx => {
      fsWrites.push({ path: ctx.params.path, content: ctx.params.content })
      if (!handlers.onWriteTextFile) throw new Error('fs/write_text_file not configured')
      return handlers.onWriteTextFile(ctx.params)
    })
    .onRequest('terminal/create', async ctx => {
      termCalls.push({ op: 'create', payload: ctx.params as unknown as Record<string, unknown> })
      if (!handlers.onTerminalCreate) throw new Error('terminal/create not configured')
      return handlers.onTerminalCreate(ctx.params)
    })
    .onRequest('terminal/output', ctx => {
      termCalls.push({ op: 'output', payload: ctx.params as unknown as Record<string, unknown> })
      if (!handlers.onTerminalOutput) return { output: '', truncated: false }
      return handlers.onTerminalOutput(ctx.params)
    })
    .onRequest('terminal/wait_for_exit', async ctx => {
      termCalls.push({ op: 'wait_for_exit', payload: ctx.params as unknown as Record<string, unknown> })
      if (!handlers.onTerminalWaitForExit) return { exitCode: 0 }
      return handlers.onTerminalWaitForExit(ctx.params)
    })
    .onRequest('terminal/kill', ctx => {
      termCalls.push({ op: 'kill', payload: ctx.params as unknown as Record<string, unknown> })
      if (handlers.onTerminalKill) return handlers.onTerminalKill(ctx.params)
      return {}
    })
    .onRequest('terminal/release', ctx => {
      termCalls.push({ op: 'release', payload: ctx.params as unknown as Record<string, unknown> })
      if (handlers.onTerminalRelease) return handlers.onTerminalRelease(ctx.params)
      return {}
    })

  const stream = acp.ndJsonStream(
    Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>,
  )
  const conn = app.connect(stream)
  return {
    agent: conn.agent,
    updates,
    permissionAsks,
    fsReads,
    fsWrites,
    termCalls,
    close: () => conn.close(),
  }
}

function spawnServer(apiUrl: string): ChildProcess {
  const child = spawn(node, [DIST, 'acp'], {
    cwd: projDir,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_BASE_URL: apiUrl,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
    },
  })
  servers.push(child)
  return child
}

function toolResultStrings(updates: Array<Record<string, unknown>>): string[] {
  return updates
    .filter(u => u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed'))
    .map(u => {
      const content = (u.content as Array<{ content?: { text?: string } }> | undefined) ?? []
      return content.map(c => c.content?.text ?? '').join('')
    })
}

const EDITOR_TERMINAL_PARAGRAPH = /\n\nEditor terminal: [^\n]*/
let plainBashDescription = ''
function bashDescriptionOf(api: { requests: Array<{ body: unknown }> }): string {
  for (const request of api.requests) {
    const tools = (request.body as { tools?: Array<{ name?: string; description?: string }> } | null)?.tools
    const bash = Array.isArray(tools) ? tools.find(tool => tool.name === 'Bash') : undefined
    if (typeof bash?.description === 'string' && bash.description !== '') return bash.description
  }
  return ''
}

section('§1 control: when the ACP client advertises NO capabilities (none), Read, Write, Edit and Bash use disk/shell identically and send zero IDE RPCs')
{
  const diskFile = join(projDir, 'control.txt')
  writeFileSync(diskFile, 'line one\nline two\n')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: diskFile }, preText: 'reading disk' },
    { kind: 'tool_use', name: 'Edit', input: { file_path: diskFile, old_string: 'line two', new_string: 'line 2 edited' }, preText: 'editing disk' },
    { kind: 'tool_use', name: 'Bash', input: { command: 'printf "disk-shell-ok\\n"' }, preText: 'running bash' },
    { kind: 'text', text: 'control done' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server)
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'run control' }],
    })
    check('control turn completes with end_turn', res.stopReason === 'end_turn', j(res))
    check('zero fs/read_text_file, fs/write_text_file or terminal/* requests were sent', h.fsReads.length === 0 && h.fsWrites.length === 0 && h.termCalls.length === 0)
    const results = toolResultStrings(h.updates)
    check('disk Read returned numbered lines with anchor', results.some(r => r.includes('1\tline one') && r.includes('(anchor: fa:')), j(results))
    check('disk Edit updated the file on disk', readFileSync(diskFile, 'utf8') === 'line one\nline 2 edited\n')
    check('disk Bash ran in the local shell', results.some(r => r.includes('disk-shell-ok')), j(results))
    plainBashDescription = bashDescriptionOf(api)
    check('the Bash description the model received has no editor terminal paragraph', plainBashDescription !== '' && !EDITOR_TERMINAL_PARAGRAPH.test(plainBashDescription), plainBashDescription.slice(-300))
    check('no Bash result carries the editor terminal note', !results.some(r => r.includes('ran in the editor terminal')), j(results))
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§2 read-only capability (fs.readTextFile: true, writeTextFile: false, terminal: false): Read comes from the editor buffer while Write stays on disk')
{
  const targetFile = join(projDir, 'buffer-read.txt')
  writeFileSync(targetFile, 'stale on disk\n')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: targetFile }, preText: 'reading buffer' },
    { kind: 'tool_use', name: 'Write', input: { file_path: targetFile, content: 'written to disk\n' }, preText: 'writing disk' },
    { kind: 'text', text: 'read-only done' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onReadTextFile: () => ({ content: 'unsaved buffer line 1\nunsaved buffer line 2\n' }),
  })
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'read buffer then write' }],
    })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    check('Read routed through fs/read_text_file', h.fsReads.length >= 1 && h.fsReads[0]!.path === targetFile, j(h.fsReads))
    check('Write did not call fs/write_text_file (writeTextFile was false)', h.fsWrites.length === 0, j(h.fsWrites))
    const results = toolResultStrings(h.updates)
    check('Read returned the unsaved editor buffer text, not the stale disk text', results.some(r => r.includes('unsaved buffer line 1') && !r.includes('stale on disk')), j(results))
    check('Write succeeded because Read recorded whole-file seen evidence for the buffer, and wrote to disk', readFileSync(targetFile, 'utf8') === 'written to disk\n')
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§3 read+write capabilities (fs.readTextFile: true, fs.writeTextFile: true) with format-on-save read-back drift detection')
{
  const fmtFile = join(projDir, 'formatted.ts')
  writeFileSync(fmtFile, 'const x=1\n')
  const buffers = new Map<string, string>([[fmtFile, 'const x=1\n']])
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: fmtFile }, preText: 'read before edit' },
    { kind: 'tool_use', name: 'Edit', input: { file_path: fmtFile, old_string: 'const x=1', new_string: 'const x=2' }, preText: 'edit with format on save' },
    { kind: 'tool_use', name: 'Write', input: { file_path: fmtFile, content: 'const y=3\n' }, preText: 'write with format on save' },
    { kind: 'text', text: 'read-write done' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onReadTextFile: ({ path }) => ({ content: buffers.get(path) ?? '' }),
    onWriteTextFile: ({ path, content }) => {
      const formatted = content.replace(/const (\w+)=(\d+)/g, 'const $1 = $2;')
      buffers.set(path, formatted)
      writeFileSync(path, formatted)
      return {}
    },
  })
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'edit and write with format on save' }],
    })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    check('Edit and Write both routed through fs/write_text_file', h.fsWrites.length === 2, j(h.fsWrites))
    const results = toolResultStrings(h.updates)
    check(
      'Edit read-back caught format-on-save drift ("differ from what this edit wrote") and reported the formatted line `const x = 2;`',
      results.some(r => r.includes('differ from what this edit wrote') && r.includes('const x = 2;')),
      j(results),
    )
    check(
      'Write read-back caught format-on-save drift ("formatted on save") and reported the formatted content `const y = 3;`',
      results.some(r => r.includes('formatted on save') && r.includes('const y = 3;')),
      j(results),
    )
    check('files without a terminal leave the Bash description byte for byte as with no editor', plainBashDescription !== '' && bashDescriptionOf(api) === plainBashDescription)
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§4 all three capabilities (fs.readTextFile, fs.writeTextFile, terminal): Bash runs in the editor terminal and releases it')
{
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Bash', input: { command: 'echo "from-editor-terminal"' }, preText: 'running in editor terminal' },
    { kind: 'text', text: 'terminal done' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onReadTextFile: () => ({ content: '' }),
    onWriteTextFile: () => ({}),
    onTerminalCreate: () => ({ terminalId: 'term-1' }),
    onTerminalOutput: () => ({ output: 'from-editor-terminal\n', truncated: false, exitStatus: { exitCode: 0 } }),
    onTerminalWaitForExit: () => ({ exitCode: 0 }),
    onTerminalRelease: () => ({}),
  })
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'run bash in terminal' }],
    })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    const ops = h.termCalls.map(c => c.op)
    check('terminal/create, terminal/wait_for_exit, terminal/output and terminal/release were called', ops.includes('create') && ops.includes('wait_for_exit') && ops.includes('output') && ops.includes('release'), j(ops))
    const results = toolResultStrings(h.updates)
    check('Bash result carries the editor terminal output', results.some(r => r.includes('from-editor-terminal')), j(results))
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§5 refusals — read-before-edit/read-before-overwrite laws, deny rules, path validation, and oversized editor buffers')
{
  const unreadFile = join(projDir, 'unread.txt')
  writeFileSync(unreadFile, 'existing content\n')
  const deniedFile = join(projDir, 'secret.env')
  writeFileSync(deniedFile, 'SECRET=1\n')
  const oversizedFile = join(projDir, 'huge.txt')
  writeFileSync(oversizedFile, 'small on disk\n')

  mkdirSync(join(projDir, '.mercury'), { recursive: true })
  writeFileSync(
    join(projDir, '.mercury', 'settings.local.json'),
    JSON.stringify({
      guardrails: {
        deny: [`Read(/${deniedFile})`, `Edit(/${deniedFile})`],
      },
    }),
  )

  const sovFile = join(projDir, 'sovereign-new.txt')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Edit', input: { file_path: unreadFile, old_string: 'existing', new_string: 'mutated' }, preText: 'editing unread file' },
    { kind: 'tool_use', name: 'Write', input: { file_path: unreadFile, content: 'overwrite unread\n' }, preText: 'overwriting unread file' },
    { kind: 'tool_use', name: 'Read', input: { file_path: deniedFile }, preText: 'reading denied file' },
    { kind: 'tool_use', name: 'Read', input: { file_path: oversizedFile }, preText: 'reading oversized buffer' },
    { kind: 'tool_use', name: 'Read', input: { file_path: `${projDir}/bad\u0000path.txt` }, preText: 'reading nul path' },
    { kind: 'tool_use', name: 'Bash', input: { command: '   ' }, preText: 'running empty bash' },
    { kind: 'text', text: 'refusals checked' },
    { kind: 'tool_use', name: 'Write', input: { file_path: sovFile, content: 'sovereign write\n' }, preText: 'writing under sovereign' },
    { kind: 'tool_use', name: 'Read', input: { file_path: deniedFile }, preText: 'reading denied file under sovereign' },
    { kind: 'text', text: 'sovereign checked' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onReadTextFile: ({ path }) => {
      if (path === oversizedFile) {
        return { content: 'x'.repeat(260 * 1024) }
      }
      if (path === sovFile) {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }
      return { content: 'existing content\n' }
    },
    onWriteTextFile: () => ({}),
  })
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'drive refusals' }],
    })
    check('refusals turn settles', res.stopReason === 'end_turn', j(res))
    const results = toolResultStrings(h.updates)
    check(
      'refusal: Edit on an unread file is refused under IDE routing without calling fs/write_text_file',
      results.some(r => r.includes('Read the file before editing it')) && h.fsWrites.length === 0,
      j(results),
    )
    check(
      'refusal: Write on an unread existing file is refused under IDE routing without calling fs/write_text_file',
      results.some(r => r.includes('Read the file before overwriting it')) && h.fsWrites.length === 0,
      j(results),
    )
    check(
      'refusal: a Read deny rule on the host path blocks the read before fs/read_text_file is ever sent to the editor',
      !h.fsReads.some(r => r.path === deniedFile) && results.some(r => r.includes('is denied by the rule')),
      j({ reads: h.fsReads, results }),
    )
    check(
      'refusal: an oversized editor buffer without offset/limit is refused by the byte budget with a slice hint',
      results.some(r => r.includes('exceeds the maximum allowed size')),
      j(results),
    )
    check(
      'refusal: a path with a NUL byte is refused before fs/read_text_file is sent',
      !h.fsReads.some(r => r.path.includes('\u0000')) && results.some(r => r.includes('null bytes')),
      j(results),
    )
    check(
      'refusal: an empty Bash command is refused before terminal/create is sent',
      h.termCalls.length === 0 && results.some(r => r.includes('command')),
      j({ termCalls: h.termCalls, results }),
    )

    await h.agent.request('session/set_mode', { sessionId, modeId: 'sovereign' })
    h.permissionAsks.length = 0
    h.updates.length = 0
    const sovRes = await h.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'drive sovereign' }],
    })
    check('sovereign turn settles', sovRes.stopReason === 'end_turn', j(sovRes))
    const sovResults = toolResultStrings(h.updates)
    check(
      'sovereign mode runs Write through fs/write_text_file with zero tool permission asks',
      h.permissionAsks.length === 0 && h.fsWrites.some(w => w.path === sovFile),
      j({ asks: h.permissionAsks, writes: h.fsWrites, sovResults }),
    )
    check(
      'refusal: explicit deny rule still holds in sovereign mode without calling fs/read_text_file',
      !h.fsReads.some(r => r.path === deniedFile) && sovResults.some(r => r.includes('is denied by the rule')),
      j({ reads: h.fsReads, sovResults }),
    )
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§6 terminal only (fs.readTextFile: false, fs.writeTextFile: false, terminal: true): Bash runs in the editor terminal with its exit code, Read and Edit stay on disk')
{
  const diskFile = join(projDir, 'terminal-only.txt')
  writeFileSync(diskFile, 'alpha\nbeta\n')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: diskFile }, preText: 'read disk' },
    { kind: 'tool_use', name: 'Edit', input: { file_path: diskFile, old_string: 'beta', new_string: 'gamma' }, preText: 'edit disk' },
    { kind: 'tool_use', name: 'Bash', input: { command: 'echo hi' }, preText: 'bash ok' },
    { kind: 'tool_use', name: 'Bash', input: { command: 'exit 3' }, preText: 'bash fails' },
    { kind: 'text', text: 'terminal only done' },
  ])
  const commands = new Map<string, string>()
  const exitOf = (id: string): number => (commands.get(id) === 'exit 3' ? 3 : 0)
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onTerminalCreate: p => {
      const id = `t${commands.size + 1}`
      commands.set(id, p.command)
      return { terminalId: id }
    },
    onTerminalOutput: p => ({ output: exitOf(p.terminalId) === 3 ? 'boom\n' : 'hi\n', truncated: false, exitStatus: { exitCode: exitOf(p.terminalId) } }),
    onTerminalWaitForExit: p => ({ exitCode: exitOf(p.terminalId) }),
  })
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'terminal only' }] })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    check('zero fs/read_text_file or fs/write_text_file requests were sent', h.fsReads.length === 0 && h.fsWrites.length === 0, j({ reads: h.fsReads, writes: h.fsWrites }))
    check('Edit changed the file on disk', readFileSync(diskFile, 'utf8') === 'alpha\ngamma\n')
    const creates = h.termCalls.filter(c => c.op === 'create')
    check('two terminals were created for the two commands, in the session folder', creates.length === 2 && creates.every(c => typeof c.payload.cwd === 'string' && (c.payload.cwd as string).endsWith(basename(projDir))), j(creates))
    check('both terminals were released after they exited', h.termCalls.filter(c => c.op === 'release').length === 2, j(h.termCalls.map(c => c.op)))
    const results = toolResultStrings(h.updates)
    const terminalDescription = bashDescriptionOf(api)
    check(
      'the Bash description the model received carries the editor terminal paragraph: the folder and the shell variables do not carry to the next call',
      EDITOR_TERMINAL_PARAGRAPH.test(terminalDescription) && /do not carry to the next call/.test(EDITOR_TERMINAL_PARAGRAPH.exec(terminalDescription)?.[0] ?? ''),
      terminalDescription.slice(-400),
    )
    check('that paragraph is the only difference from the plain description', plainBashDescription !== '' && terminalDescription.replace(EDITOR_TERMINAL_PARAGRAPH, '') === plainBashDescription)
    check('each Bash result that ran in the editor terminal says so, in the result itself', results.filter(r => r.includes('ran in the editor terminal') && r.includes('`cd dir && …`')).length === 2, j(results))
    check('the first result carries the terminal output', results.some(r => r.includes('hi')), j(results))
    check('the failing command names its exit code 3 and carries its output', results.some(r => r.includes('boom') && /\b3\b/.test(r)), j(results))
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§7 the editor cannot create a terminal: the command runs in the local shell and the result says so')
{
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Bash', input: { command: 'printf "ran-local\\n"' }, preText: 'bash with a broken editor terminal' },
    { kind: 'text', text: 'fallback done' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onTerminalCreate: () => {
      throw new acp.RequestError(-32603, 'no pty available in this editor')
    },
  })
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'broken terminal' }] })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    const results = toolResultStrings(h.updates)
    check('the command ran in the local shell', results.some(r => r.includes('ran-local')), j(results))
    check(
      'the result states that the editor could not open a terminal, why, and that the local shell ran the command',
      results.some(r => /editor/i.test(r) && /terminal/i.test(r) && r.includes('no pty available in this editor') && /local shell/i.test(r)),
      j(results),
    )
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§8 abort: cancelling a turn that waits on an editor terminal kills the terminal and then releases it')
{
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 600' }, preText: 'a long command' },
    { kind: 'text', text: 'unreachable' },
  ])
  let killed!: () => void
  const killedSignal = new Promise<void>(resolve => {
    killed = resolve
  })
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onTerminalCreate: () => ({ terminalId: 'long-1' }),
    onTerminalWaitForExit: async () => {
      await killedSignal
      return { exitCode: null }
    },
    onTerminalKill: () => {
      killed()
      return {}
    },
  })
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const turn = h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'long command' }] })
    for (let waited = 0; !h.termCalls.some(c => c.op === 'wait_for_exit') && waited < 600; waited++) await new Promise(r => setTimeout(r, 50))
    await h.agent.notify('session/cancel', { sessionId })
    const res = await turn
    check('the cancelled turn settles', res.stopReason === 'cancelled', j(res))
    const ops = h.termCalls.map(c => c.op)
    check('terminal/kill is sent, then terminal/release', ops.includes('kill') && ops.includes('release') && ops.indexOf('kill') < ops.lastIndexOf('release'), j(ops))
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§9 write only (fs.writeTextFile: true, fs.readTextFile: false, terminal: false): Read stays on disk, Edit goes through the editor and the read-back finds the formatted file on disk')
{
  const fmtFile = join(projDir, 'write-only.ts')
  writeFileSync(fmtFile, 'const a=1\n')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: fmtFile }, preText: 'read disk' },
    { kind: 'tool_use', name: 'Edit', input: { file_path: fmtFile, old_string: 'const a=1', new_string: 'const a=2' }, preText: 'edit with format on save' },
    { kind: 'text', text: 'write only done' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onWriteTextFile: ({ path, content }) => {
      writeFileSync(path, content.replace(/const (\w+)=(\d+)/g, 'const $1 = $2;'))
      return {}
    },
  })
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: true }, terminal: false },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write only' }] })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    check('no fs/read_text_file was sent and Edit went through fs/write_text_file once', h.fsReads.length === 0 && h.fsWrites.length === 1, j({ reads: h.fsReads, writes: h.fsWrites }))
    const results = toolResultStrings(h.updates)
    check('the read-back from disk caught the formatting and reported the formatted line', results.some(r => r.includes('differ from what this edit wrote') && r.includes('const a = 2;')), j(results))
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§10 a settings file still carrying guardrails.sandbox changes nothing: Bash rides the editor terminal as on any host')
{
  mkdirSync(join(projDir, '.mercury'), { recursive: true })
  writeFileSync(join(projDir, '.mercury', 'settings.local.json'), JSON.stringify({ guardrails: { sandbox: { enabled: true } } }))
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Bash', input: { command: 'printf "ran-locally\\n"' }, preText: 'bash with a retired key in the settings' },
    { kind: 'text', text: 'retired key done' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onTerminalCreate: () => ({ terminalId: 'term-retired' }),
    onTerminalOutput: () => ({ output: 'from-the-editor-terminal\n', truncated: false, exitStatus: { exitCode: 0 } }),
    onTerminalWaitForExit: () => ({ exitCode: 0 }),
  })
  try {
    await h.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'bash with a retired key' }] })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    const results = toolResultStrings(h.updates)
    check('the retired key is an unknown key: the command rides the editor terminal', h.termCalls.some(c => c.op === 'create'), j(h.termCalls.map(c => c.op)))
    check('the editor terminal answered the command', results.some(r => r.includes('from-the-editor-terminal')) && !results.some(r => r.includes('ran-locally')), j(results))
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
    rmSync(join(projDir, '.mercury', 'settings.local.json'), { force: true })
  }
}

section('§11 output past the display budget: the editor terminal road saves the whole output and states its size, as the local shell road does')
{
  const rows = 8000
  const rowsText = Array.from({ length: rows }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
  const runOnce = async (withTerminal: boolean): Promise<{ text: string; saved: string }> => {
    const api = await startFixtureApi([
      { kind: 'tool_use', name: 'Bash', input: { command: `seq 1 ${rows} | sed 's/^/row /'` }, preText: 'a long listing' },
      { kind: 'text', text: 'listing done' },
    ])
    const server = spawnServer(api.url)
    const h = connectClient(
      server,
      withTerminal
        ? {
            onTerminalCreate: () => ({ terminalId: 'long-out' }),
            onTerminalOutput: () => ({ output: rowsText, truncated: false, exitStatus: { exitCode: 0 } }),
            onTerminalWaitForExit: () => ({ exitCode: 0 }),
          }
        : {},
    )
    try {
      await h.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: withTerminal } })
      const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
      await h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'list rows' }] })
      const text = toolResultStrings(h.updates).join('\n')
      const path = /Full output saved to: (\S+)/.exec(text)?.[1] ?? ''
      const saved = path !== '' && existsSync(path) ? readFileSync(path, 'utf8') : ''
      await h.agent.request('session/close', { sessionId }).catch(() => {})
      return { text, saved }
    } finally {
      h.close()
      server.kill('SIGKILL')
      await api.close()
    }
  }
  const local = await runOnce(false)
  const editor = await runOnce(true)
  const sizeOf = (text: string): string => /Output of ([\d.]+\s?[KMG]?B)/.exec(text)?.[1] ?? ''
  check('the local road states the size of the whole output', sizeOf(local.text) === '69.2KB' && local.saved === rowsText, local.text.slice(0, 200))
  check('the editor road states the same size', sizeOf(editor.text) === sizeOf(local.text), `${sizeOf(editor.text)} vs ${sizeOf(local.text)}`)
  check('the file the editor road names holds the whole output', editor.saved === rowsText, `${editor.saved.length} of ${rowsText.length}`)
}

section('§12 output past the wire frame: a terminal that retains only what it was asked to keep still ends the command with its last lines')
{
  const rows = 3_300_000
  const rowsText = Array.from({ length: rows }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Bash', input: { command: `seq 1 ${rows} | sed 's/^/row /'` }, preText: 'a flood of output' },
    { kind: 'text', text: 'flood done' },
  ])
  const server = spawnServer(api.url)
  let askedLimit = 0
  const h = connectClient(server, {
    onTerminalCreate: p => {
      askedLimit = Number((p as unknown as { outputByteLimit?: number }).outputByteLimit ?? 0)
      return { terminalId: 'flood-1' }
    },
    onTerminalOutput: () => {
      const keep = askedLimit > 0 && askedLimit < rowsText.length
      return { output: keep ? rowsText.slice(-askedLimit) : rowsText, truncated: keep, exitStatus: { exitCode: 0 } }
    },
    onTerminalWaitForExit: () => ({ exitCode: 0 }),
  })
  try {
    await h.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true } })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'flood' }] })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    check('the byte limit asked of the editor keeps one answer inside the 32 MiB wire frame', askedLimit > 0 && askedLimit <= 16 * 1024 * 1024, String(askedLimit))
    const result = toolResultStrings(h.updates).join('\n')
    const saved = /Full output saved to: (\S+)/.exec(result)?.[1] ?? ''
    check('the result ends with the last line of the output', result.includes(`row ${rows}`), result.slice(-300))
    check('the file the result names ends with the last line of the output', saved !== '' && existsSync(saved) && readFileSync(saved, 'utf8').endsWith(`row ${rows}\n`), saved)
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§13 an editor read that fails is reported to the model; the disk copy is never read in its place')
{
  const diskFile = join(projDir, 'failing-buffer.txt')
  writeFileSync(diskFile, 'the stale disk copy\n')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: diskFile }, preText: 'read while the editor fails' },
    { kind: 'text', text: 'failing read done' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onReadTextFile: () => {
      throw new acp.RequestError(-32603, 'the editor buffer is unavailable')
    },
  })
  try {
    await h.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false } })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'read failing' }] })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    const results = toolResultStrings(h.updates)
    check('the editor was asked for the buffer', h.fsReads.some(r => r.path === diskFile), j(h.fsReads))
    check('the model is told the read failed and the disk copy is not returned', results.length > 0 && !results.some(r => r.includes('the stale disk copy')) && results.some(r => /unavailable|error/i.test(r)), j(results))
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

section('§14 after the editor reformats an Edit the next Edit on the reformatted line is accepted without a new Read, and a line the model never saw is refused as not found')
{
  const fmtFile = join(projDir, 'drift-twice.ts')
  writeFileSync(fmtFile, 'const x=1\nconst z=9\n')
  const buffers = new Map<string, string>([[fmtFile, 'const x=1\nconst z=9\n']])
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: fmtFile }, preText: 'read' },
    { kind: 'tool_use', name: 'Edit', input: { file_path: fmtFile, old_string: 'const x=1', new_string: 'const x=2' }, preText: 'first edit, formatted on save' },
    { kind: 'tool_use', name: 'Edit', input: { file_path: fmtFile, old_string: 'const x = 2;', new_string: 'const x = 3;' }, preText: 'second edit on the reformatted line' },
    { kind: 'tool_use', name: 'Edit', input: { file_path: fmtFile, old_string: 'const z=9', new_string: 'const z=8' }, preText: 'third edit on text the formatter changed and the model never saw' },
    { kind: 'text', text: 'drift twice done' },
  ])
  const server = spawnServer(api.url)
  const h = connectClient(server, {
    onReadTextFile: ({ path }) => ({ content: buffers.get(path) ?? '' }),
    onWriteTextFile: ({ path, content }) => {
      const formatted = content.replace(/const (\w+)=(\d+)/g, 'const $1 = $2;')
      buffers.set(path, formatted)
      writeFileSync(path, formatted)
      return {}
    },
  })
  try {
    await h.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } })
    const { sessionId } = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const res = await h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'drift twice' }] })
    check('turn completes', res.stopReason === 'end_turn', j(res))
    const results = toolResultStrings(h.updates)
    check('the first Edit reports the formatter changed what it wrote', results.some(r => r.includes('differ from what this edit wrote') && r.includes('const x = 2;')), j(results))
    check('the second Edit, on the reformatted line and with no new Read, is accepted', results.filter(r => r.includes('has been updated successfully')).length === 2 && readFileSync(fmtFile, 'utf8') === 'const x = 3;\nconst z = 9;\n', j({ results, file: readFileSync(fmtFile, 'utf8') }))
    check('the third Edit, on text the formatter had changed and the model never saw, is refused as not found', results.some(r => r.includes('The old_string was not found in the file')), j(results))
    await h.agent.request('session/close', { sessionId }).catch(() => {})
  } finally {
    h.close()
    server.kill('SIGKILL')
    await api.close()
  }
}

console.log('')
if (failures > 0) {
  console.error(`❌ prove-acp-ide-routing: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-acp-ide-routing: all checks pass')
