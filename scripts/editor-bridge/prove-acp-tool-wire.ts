#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-acp-tool-wire.ts — PROOF: the ACP server's
//  pure wire shapes, in-process (the E2E half rides prove-acp-server.ts
//  over the built dist):
//
//    §1 toolKindOf — the Mercury tool vocabulary maps onto the ACP verb
//       kinds; an unknown name is 'other', never a guessed verb.
//    §2 toolLocationsOf — only contract path keys become locations (Read's
//       offset is its line; ChangeSet's changes fan out; no free-text
//       inference; deduped).
//    §3 toolDiffsOf — Edit carries its exact old/new strings; Write carries
//       the file as it stands (null for a new file) and NOTHING when the
//       file already holds the new text; other tools carry no diff.
//    §4 tool output — bounded with the cut named; empty output crosses as
//       no content block.
//    §5 stopReasonOf — cancelled · the model's own stop reasons · the turn
//       cap · every other error is an ERROR naming its cause.
//    §6 acpMcpServersToConfig — stdio/http/sse cross as the child's inline
//       --mcp-config document; unsupported shapes are NAMED, not dropped;
//       nothing ⇒ null.
//    §7 editor context — the wire narrows structurally; the resource
//       rendering is bounded (selection text, list lengths, diagnostic
//       rows) and absent when the editor reported nothing; the prompt
//       document carries it as the leading attached resource.
//    §8 replayUpdatesOf — a transcript crosses in order as the five update
//       kinds; meta and sidechain rows stay out; an unsettled tool call
//       stays in progress; tool output is bounded.
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-acp-tool-wire.ts
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const {
  toolKindOf,
  toolLocationsOf,
  toolDiffsOf,
  boundedToolText,
  toolOutputContentOf,
  TOOL_OUTPUT_WIRE_LIMIT,
  stopReasonOf,
  acpMcpServersToConfig,
  editorContextOf,
  editorContextResource,
  acpPromptToComposerDocument,
  composerDocumentBlocks,
  replayUpdatesOf,
} = await import('../../src/services/acp/acpServer.ts')

// ── §1 ──────────────────────────────────────────────────────────────────────
t.section('§1 toolKindOf — the verb kinds')
{
  const expect: Array<[string, string]> = [
    ['Read', 'read'],
    ['Edit', 'edit'],
    ['Write', 'edit'],
    ['NotebookEdit', 'edit'],
    ['ChangeSet', 'edit'],
    ['Glob', 'search'],
    ['Grep', 'search'],
    ['WebFetch', 'fetch'],
    ['Bash', 'execute'],
    ['Debug', 'execute'],
    ['Agent', 'think'],
    ['TaskCreate', 'think'],
    ['EnterPlanMode', 'switch_mode'],
    ['mcp__ide__getDiagnostics', 'other'],
    ['SomethingNew', 'other'],
  ]
  for (const [name, kind] of expect) {
    t.check(`${name} → ${kind}`, toolKindOf(name) === kind, toolKindOf(name))
  }
}

// ── §2 ──────────────────────────────────────────────────────────────────────
t.section('§2 toolLocationsOf — contract keys only')
{
  const read = toolLocationsOf('Read', { file_path: '/p/a.ts', offset: 40, limit: 10 })
  t.check('Read names its file with the offset as the line', read.length === 1 && read[0]!.path === '/p/a.ts' && read[0]!.line === 40, JSON.stringify(read))
  const edit = toolLocationsOf('Edit', { file_path: '/p/b.ts', old_string: 'x', new_string: 'y' })
  t.check('Edit names its file without a line', edit.length === 1 && edit[0]!.path === '/p/b.ts' && edit[0]!.line === undefined, JSON.stringify(edit))
  const changeSet = toolLocationsOf('ChangeSet', {
    op: 'apply',
    changes: [{ file_path: '/p/c.ts' }, { file_path: '/p/d.ts' }, { file_path: '/p/c.ts' }],
  })
  t.check('ChangeSet fans out its changes, deduped', changeSet.map(l => l.path).join(',') === '/p/c.ts,/p/d.ts', JSON.stringify(changeSet))
  const bash = toolLocationsOf('Bash', { command: 'cat /etc/hosts' })
  t.check('free text never becomes a location', bash.length === 0, JSON.stringify(bash))
  const glob = toolLocationsOf('Glob', { pattern: '**/*.ts', path: '/p' })
  t.check("Glob's directory is not a file location", glob.length === 0, JSON.stringify(glob))
  const nb = toolLocationsOf('NotebookEdit', { notebook_path: '/p/n.ipynb', cell_id: '1' })
  t.check('NotebookEdit names the notebook', nb.length === 1 && nb[0]!.path === '/p/n.ipynb')
  t.check('a null input is an empty list', toolLocationsOf('Edit', null).length === 0)
}

// ── §3 ──────────────────────────────────────────────────────────────────────
t.section('§3 toolDiffsOf — the announced diff')
{
  const edit = toolDiffsOf('Edit', { file_path: '/p/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' })
  t.check(
    'Edit carries its exact old/new strings',
    edit.length === 1 && edit[0]!.path === '/p/a.ts' && edit[0]!.oldText === 'const a = 1' && edit[0]!.newText === 'const a = 2',
    JSON.stringify(edit),
  )
  const fresh = toolDiffsOf('Write', { file_path: '/p/new.ts', content: 'hello\n' }, () => null)
  t.check('Write of a new file: oldText null, newText the content', fresh.length === 1 && fresh[0]!.oldText === null && fresh[0]!.newText === 'hello\n', JSON.stringify(fresh))
  const overwrite = toolDiffsOf('Write', { file_path: '/p/x.ts', content: 'after\n' }, () => 'before\n')
  t.check('Write over an existing file: oldText is the file as it stands', overwrite.length === 1 && overwrite[0]!.oldText === 'before\n', JSON.stringify(overwrite))
  const landed = toolDiffsOf('Write', { file_path: '/p/x.ts', content: 'same\n' }, () => 'same\n')
  t.check('a file already holding the new text announces NO diff (nothing is invented)', landed.length === 0, JSON.stringify(landed))
  t.check('Read carries no diff', toolDiffsOf('Read', { file_path: '/p/a.ts' }).length === 0)
  t.check('a malformed Edit input carries no diff', toolDiffsOf('Edit', { file_path: '/p/a.ts' }).length === 0)
}

// ── §4 ──────────────────────────────────────────────────────────────────────
t.section('§4 tool output — bounded, cut named')
{
  const short = boundedToolText('ok')
  t.check('short output passes untouched', short === 'ok')
  const long = boundedToolText('x'.repeat(TOOL_OUTPUT_WIRE_LIMIT + 500))
  t.check('long output is cut at the limit', long.startsWith('x'.repeat(TOOL_OUTPUT_WIRE_LIMIT)) && long.length < TOOL_OUTPUT_WIRE_LIMIT + 100, String(long.length))
  t.check('the cut names how much is missing', long.includes('500 more characters not shown'), long.slice(-60))
  t.check('empty output crosses as no content block', toolOutputContentOf('') === undefined && toolOutputContentOf(undefined) === undefined)
  const block = toolOutputContentOf('done')
  t.check(
    'output crosses as one text content block',
    block?.length === 1 && block[0]!.type === 'content' && block[0]!.content.type === 'text' && block[0]!.content.text === 'done',
    JSON.stringify(block),
  )
}

// ── §5 ──────────────────────────────────────────────────────────────────────
t.section('§5 stopReasonOf — settlement')
{
  const r = (o: 'success' | 'error' | 'cancelled', d?: { subtype: string; stopReason?: string; errors: string[] }) =>
    JSON.stringify(stopReasonOf(o, d))
  t.check('cancelled → cancelled', r('cancelled') === '{"stopReason":"cancelled"}', r('cancelled'))
  t.check('success → end_turn', r('success', { subtype: 'success', stopReason: 'end_turn', errors: [] }) === '{"stopReason":"end_turn"}')
  t.check('success + max_tokens → max_tokens', r('success', { subtype: 'success', stopReason: 'max_tokens', errors: [] }) === '{"stopReason":"max_tokens"}')
  t.check('success + refusal → refusal (the model\'s own)', r('success', { subtype: 'success', stopReason: 'refusal', errors: [] }) === '{"stopReason":"refusal"}')
  t.check('error_max_turns → max_turn_requests', r('error', { subtype: 'error_max_turns', errors: [] }) === '{"stopReason":"max_turn_requests"}')
  const crash = stopReasonOf('error', { subtype: 'error_during_execution', errors: ['boom', 'later'] })
  t.check('an execution error is an ERROR, never a refusal', 'error' in crash, JSON.stringify(crash))
  t.check('the error names subtype and cause', 'error' in crash && crash.error.includes('error_during_execution') && crash.error.includes('boom; later'), JSON.stringify(crash))
  const dead = stopReasonOf('error', undefined)
  t.check('an error with no detail is still an error', 'error' in dead && dead.error.includes('failed'))
}

// ── §6 ──────────────────────────────────────────────────────────────────────
t.section('§6 acpMcpServersToConfig — the child\'s --mcp-config')
{
  t.check('no servers ⇒ null', acpMcpServersToConfig([]) === null && acpMcpServersToConfig(undefined) === null)
  const out = acpMcpServersToConfig([
    { name: 'fs', command: '/usr/bin/mcp-fs', args: ['--root', '/p'], env: [{ name: 'A', value: '1' }] },
    { type: 'http', name: 'remote', url: 'https://x/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
    { type: 'sse', name: 'events', url: 'https://x/sse', headers: [] },
    { type: 'acp', name: 'nested', command: 'x', args: [], env: [] },
    { command: 'no-name' },
  ])
  const parsed = out ? (JSON.parse(out.json) as { mcpServers: Record<string, Record<string, unknown>> }) : null
  t.check('three servers cross', out?.names.join(',') === 'fs,remote,events', JSON.stringify(out?.names))
  t.check(
    'stdio: command/args/env map (env array → object)',
    parsed?.mcpServers.fs?.command === '/usr/bin/mcp-fs' &&
      JSON.stringify(parsed?.mcpServers.fs?.args) === '["--root","/p"]' &&
      JSON.stringify(parsed?.mcpServers.fs?.env) === '{"A":"1"}',
    JSON.stringify(parsed?.mcpServers.fs),
  )
  t.check(
    'http: type/url/headers map (headers array → object)',
    parsed?.mcpServers.remote?.type === 'http' &&
      parsed?.mcpServers.remote?.url === 'https://x/mcp' &&
      (parsed?.mcpServers.remote?.headers as Record<string, string>)?.Authorization === 'Bearer t',
    JSON.stringify(parsed?.mcpServers.remote),
  )
  t.check('sse: type/url map', parsed?.mcpServers.events?.type === 'sse' && parsed?.mcpServers.events?.url === 'https://x/sse')
  t.check('unsupported shapes are NAMED', JSON.stringify(out?.skipped) === '["nested (acp)","(unnamed)"]', JSON.stringify(out?.skipped))
  const onlySkipped = acpMcpServersToConfig([{ type: 'acp', name: 'n', command: 'x', args: [], env: [] }])
  t.check('only unsupported shapes ⇒ null (nothing to carry)', onlySkipped === null)
}

// ── §7 ──────────────────────────────────────────────────────────────────────
t.section('§7 editor context — narrowing, rendering, bounds, prompt placement')
{
  t.check('a wire without a session id is ignored', editorContextOf({ activeFile: { path: '/p/a.ts' } }) === null)
  t.check('a non-object is ignored', editorContextOf('x') === null && editorContextOf(null) === null)
  const wire = editorContextOf({
    sessionId: 's1',
    workspaceFolders: ['/p', 7],
    activeFile: { path: '/p/a.ts', languageId: 'typescript', selection: { startLine: 3, endLine: 4, text: 'const a = 1\nconst b = 2' } },
    openFiles: ['/p/a.ts', '/p/b.ts'],
    diagnostics: [{ path: '/p/a.ts', line: 3, severity: 'Error', message: 'boom' }, { message: 'no path' }],
  })
  t.check('the wire narrows structurally (non-strings dropped, pathless diagnostics dropped)', wire?.workspaceFolders?.length === 1 && wire?.diagnostics?.length === 1, JSON.stringify(wire))
  const res = editorContextResource(wire)
  t.check('renders as an attached resource at mercury://editor-context', res?.type === 'resource' && res.resource.uri === 'mercury://editor-context', JSON.stringify(res).slice(0, 120))
  const text = res?.resource.text ?? ''
  t.check('names the workspace, the active file, the selection lines and its text', text.includes('workspace: /p') && text.includes('active file: /p/a.ts (typescript) · selection lines 3-4') && text.includes('const b = 2'), text)
  t.check('lists the open files and the diagnostics', text.includes('open files: /p/a.ts, /p/b.ts') && text.includes('/p/a.ts:3 Error: boom'), text)
  t.check('nothing reported ⇒ null (no invented empty editor)', editorContextResource(editorContextOf({ sessionId: 's1' })) === null)
  t.check('null context ⇒ null', editorContextResource(null) === null)
  const big = editorContextOf({
    sessionId: 's1',
    activeFile: { path: '/p/a.ts', selection: { startLine: 1, endLine: 999, text: 'y'.repeat(20_000) } },
    openFiles: Array.from({ length: 50 }, (_, i) => `/p/f${i}.ts`),
    diagnostics: Array.from({ length: 40 }, (_, i) => ({ path: '/p/a.ts', line: i, severity: 'Warning', message: `w${i}` })),
  })
  const bigText = editorContextResource(big)?.resource.text ?? ''
  t.check('the selection text is bounded and the cut named', bigText.length < 12_000 && bigText.includes('(selection truncated)'), String(bigText.length))
  t.check('open files are bounded with the remainder counted', bigText.includes('(+20 more)'), bigText.slice(bigText.indexOf('open files'), bigText.indexOf('open files') + 80))
  t.check('diagnostics are bounded with the remainder counted', bigText.includes('(+15 more)'))
  // Prompt placement: the resource leads, then the client's own content in
  // encounter order — the same attached-resource vocabulary a selection uses.
  const blocks = composerDocumentBlocks(
    acpPromptToComposerDocument([
      res as unknown as Record<string, unknown>,
      { type: 'text', text: 'what is wrong here?' },
    ]),
  )
  t.check('the editor context leads the prompt as an attached resource', String(blocks[0]?.text ?? '').startsWith('<attached-resource uri="mercury://editor-context">'), JSON.stringify(blocks[0]).slice(0, 100))
  t.check("the user's own text follows", blocks[1]?.text === 'what is wrong here?', JSON.stringify(blocks[1]))
}

// ── §8 ──────────────────────────────────────────────────────────────────────
t.section('§8 replayUpdatesOf — the transcript as session updates')
{
  const updates = replayUpdatesOf([
    { type: 'user', message: { role: 'user', content: 'fix the bug' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'hidden caveat' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me look' },
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'text', text: 'edited' }] }] } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }, { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'ls' } }] } },
  ])
  const kinds = updates.map(u => u.sessionUpdate).join(' ')
  t.check(
    'the five update kinds cross in transcript order',
    kinds === 'user_message_chunk agent_thought_chunk agent_message_chunk tool_call tool_call_update agent_message_chunk tool_call',
    kinds,
  )
  t.check('meta rows stay out', !JSON.stringify(updates).includes('hidden caveat'))
  t.check('sidechain rows stay out', !JSON.stringify(updates).includes('subagent chatter'))
  const call = updates.find(u => u.toolCallId === 'tu-1')!
  t.check('a replayed tool call carries kind + locations', call.kind === 'edit' && JSON.stringify(call.locations) === '[{"path":"/p/a.ts"}]', JSON.stringify(call))
  t.check('the announcement is in progress; the result row settles it', call.status === 'in_progress' && updates.some(u => u.toolCallId === 'tu-1' && u.sessionUpdate === 'tool_call_update' && u.status === 'completed'))
  const settled = updates.find(u => u.toolCallId === 'tu-1' && u.sessionUpdate === 'tool_call_update')!
  t.check('the result text rides the settlement', JSON.stringify(settled.content).includes('"edited"'), JSON.stringify(settled))
  const open = updates.filter(u => u.toolCallId === 'tu-2')
  t.check('an unsettled call stays in progress (an interrupted turn, truthfully)', open.length === 1 && open[0]!.status === 'in_progress')
  t.check('an empty transcript replays nothing', replayUpdatesOf([]).length === 0)
}

t.finish('prove-acp-tool-wire')
