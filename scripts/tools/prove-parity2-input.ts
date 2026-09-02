#!/usr/bin/env bun
// ============================================================================
//  prove-parity2-input — frontier-sweep #2, the queue / input-state
//  tier, mechanism-pinned:
//
//   1. History at actual-send time (round-1 deferral 30): the pure entry
//      decision for a drained queued command (human-typed prompt/bash in,
//      meta/bridge/remote/system out) and the submit gate (structural).
//   2. Shell grouping through an interleaved status update (round-1
//      deferral 34): bash · todo · bash collapses to ONE row counting two
//      commands with the todo rows deferred behind it; a non-status tool
//      still breaks the group; a todo outside a group renders in place.
//      (The rendered captures at 80/120 are in the receipt.)
//   3. One word grammar (packet 22): the search box's boundary functions
//      agree with the composer's Cursor on accented, CJK and punctuated text.
//   4. The vim register outlives a remount (packet 25).
//   5. Arrow+↵ in ONE input chunk activates the option the arrow landed on
//      (packet 28, already-differs) — LIVE through the real ink pipeline: the
//      App closes a dispatch segment at every acting named key and flushes
//      React's sync work before the next atom, so ↵ never reads a stale
//      closure. The pin is the observable, not a new mechanism.
//   6. A typed `./` survives path completion (packet 33).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-input-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. history at actual-send time ————————————————————————————————————
{
  const { queuedCommandHistoryEntry } = await import('../../src/history.ts')
  const human = queuedCommandHistoryEntry({ value: 'fix the build', mode: 'prompt' })
  t('a human-typed queued prompt earns its entry at drain', human?.display === 'fix the build')
  const bash = queuedCommandHistoryEntry({ value: 'ls -la', preExpansionValue: 'ls -la', mode: 'bash' })
  t('a queued bash command keeps its ! prefix', bash?.display === '!ls -la')
  const pasted = queuedCommandHistoryEntry({ value: 'expanded paste text', preExpansionValue: 'look at [Pasted text #1]', mode: 'prompt', pastedContents: { 1: { id: 1, type: 'text', content: 'x' } as never } })
  t('the pre-expansion text is what history records', pasted?.display === 'look at [Pasted text #1]' && pasted.pastedContents[1] !== undefined)
  t('a meta command earns nothing', queuedCommandHistoryEntry({ value: 'cron fire', mode: 'prompt', isMeta: true }) === null)
  t('a bridge/remote command earns nothing', queuedCommandHistoryEntry({ value: 'remote', mode: 'prompt', bridgeOrigin: true }) === null && queuedCommandHistoryEntry({ value: 'remote', mode: 'prompt', skipSlashCommands: true }) === null)
  t('a structurally-stamped origin earns nothing', queuedCommandHistoryEntry({ value: 'x', mode: 'prompt', origin: 'system' }) === null)
  t('task notifications earn nothing', queuedCommandHistoryEntry({ value: '<task-notification/>', mode: 'task-notification' }) === null)
  t('block-content values earn nothing', queuedCommandHistoryEntry({ value: [{ type: 'text', text: 'x' }], mode: 'prompt' }) === null)
  const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
  // The composer's history is the screen's and is written ONCE, when the
  // composer is taken at submit (session and screen seats alike; a dialog
  // command never enters it); the session's runner queues and drains in its
  // own process and writes no composer history — no second write exists.
  t('the submit-time write happens once, when the composer is taken (structural)', /const takeComposer = \(\): void => \{[\s\S]{0,700}addToHistory\(\{ display: seatMode === 'bash' \? `!\$\{input\}` : input, pastedContents: seatPastes \}\);/.test(repl))
  t('the face holds no drain-time history write (the runner drains its own queue)', !repl.includes('queuedCommandHistoryEntry('))
}

// —— 2. shell grouping through a status update —————————————————————————
{
  process.env.MERCURY_FULLSCREEN = '1'
  const { collapseReadSearchGroups, isStatusUpdateTool } = await import('../../src/utils/collapseReadSearch.ts')
  const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
  const { TodoWriteTool } = await import('../../src/tools/TodoWriteTool/TodoWriteTool.ts')
  const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
  const tools = [BashTool, TodoWriteTool, FileEditTool] as never
  let n = 0
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const use = (id: string, name: string, input: Record<string, unknown>) => ({
    type: 'assistant', uuid: uuid(), timestamp: new Date().toISOString(),
    message: { id: `m${id}`, role: 'assistant', type: 'message', model: 'x', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id, name, input }] },
  })
  const result = (id: string, text: string, toolUseResult: unknown) => ({
    type: 'user', uuid: uuid(), timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
    toolUseResult,
  })
  const bashResult = { stdout: 'hi', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
  const todos = [{ content: 'a', status: 'completed', activeForm: 'a' }]
  const seq = [
    use('b1', 'Bash', { command: 'echo hi' }), result('b1', 'hi', bashResult),
    use('t1', 'TodoWrite', { todos }), result('t1', 'ok', { oldTodos: [], newTodos: todos }),
    use('b2', 'Bash', { command: 'echo again' }), result('b2', 'again', bashResult),
  ]
  const out = collapseReadSearchGroups(seq as never, tools) as Array<{ type: string; bashCount?: number; message?: { content?: Array<{ name?: string; tool_use_id?: string }> } }>
  const collapsed = out.filter(m => m.type === 'collapsed_read_search')
  t('TodoWrite is a status-update tool; Bash is not', isStatusUpdateTool('TodoWrite') && !isStatusUpdateTool('Bash'))
  t('bash · todo · bash collapses to ONE shell row', collapsed.length === 1, `${collapsed.length} collapsed rows`)
  t('the one row counts both commands', collapsed[0]?.bashCount === 2, `bashCount ${collapsed[0]?.bashCount}`)
  const todoUseAt = out.findIndex(m => m.type === 'assistant' && m.message?.content?.[0]?.name === 'TodoWrite')
  const todoResultAt = out.findIndex(m => m.type === 'user' && m.message?.content?.[0]?.tool_use_id === 't1')
  const rowAt = out.findIndex(m => m.type === 'collapsed_read_search')
  t('the todo use AND its result defer behind the collapsed row, in order', rowAt >= 0 && todoUseAt > rowAt && todoResultAt > todoUseAt, `row ${rowAt} use ${todoUseAt} result ${todoResultAt}`)
  t('nothing is dropped', out.length === 3)

  const withEdit = [
    use('b3', 'Bash', { command: 'echo one' }), result('b3', 'one', bashResult),
    use('e1', 'Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }), result('e1', 'ok', {}),
    use('b4', 'Bash', { command: 'echo two' }), result('b4', 'two', bashResult),
  ]
  const split = collapseReadSearchGroups(withEdit as never, tools) as Array<{ type: string }>
  t('a non-status tool (Edit) still breaks the group into two rows', split.filter(m => m.type === 'collapsed_read_search').length === 2)

  const alone = collapseReadSearchGroups([use('t2', 'TodoWrite', { todos }), result('t2', 'ok', { oldTodos: [], newTodos: todos })] as never, tools) as Array<{ type: string }>
  t('a todo outside any group renders in place (no collapsed row)', alone.length === 2 && alone[0]!.type === 'assistant' && alone[1]!.type === 'user')
  delete process.env.MERCURY_FULLSCREEN
}

// —— 3. one word grammar ———————————————————————————————————————————————
{
  const { wordStartBefore, wordStartAfter } = await import('../../src/utils/intl.ts')
  const { Cursor } = await import('../../src/utils/Cursor.ts')
  const samples = ['café au lait', 'naïve search box', '日本語のテキスト 検索', "don't panic — it's fine", 'a.b.c d_e', '  leading spaces', 'trailing   ']
  let agree = true
  const disagreements: string[] = []
  for (const text of samples) {
    for (let at = 0; at <= text.length; at++) {
      const cursor = Cursor.fromText(text, 200, at)
      if (cursor.prevWord().offset !== wordStartBefore(text, at) || cursor.nextWord().offset !== wordStartAfter(text, at)) {
        agree = false
        disagreements.push(`${JSON.stringify(text)}@${at}: cursor ${cursor.prevWord().offset}/${cursor.nextWord().offset} vs ${wordStartBefore(text, at)}/${wordStartAfter(text, at)}`)
      }
    }
  }
  t('search-box word boundaries agree with the composer at every offset of every sample', agree, disagreements.slice(0, 3).join(' | '))
  t('an accented word is one word (ctrl+w on "café" at its end deletes the whole word)', wordStartBefore('café', 4) === 0)
  const search = readFileSync('src/hooks/useSearchInput.ts', 'utf8')
  t('the search box routes through the shared grammar (structural)', search.includes("wordStartBefore(text, at)") && !/\/\[\\w\]\//.test(search))
}

// —— 4. vim register outlives a remount ——————————————————————————————————
{
  const { getSessionVimPersistentState, _resetSessionVimPersistentStateForTesting } = await import('../../src/vim/types.ts')
  _resetSessionVimPersistentStateForTesting()
  const first = getSessionVimPersistentState()
  first.register = 'yanked words'
  first.registerIsLinewise = false
  const second = getSessionVimPersistentState()
  t('a second mount reads the same register', second === first && second.register === 'yanked words')
  const hook = readFileSync('src/hooks/useVimInput.ts', 'utf8')
  t('the vim hook seeds its ref from the session owner (structural)', hook.includes('useRef<PersistentState>(getSessionVimPersistentState())'))
}

// —— 5. arrow + ↵ in one chunk — LIVE ———————————————————————————————————
{
  const React = await import('react')
  const { render } = await import('../../src/ink.js')
  const { Select } = await import('../../src/components/CustomSelect/select.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
  // The real theme provider reads the global config at mount: arm the
  // config gate the way a booted product does (the injected-doubles law).
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  let written = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        written += chunk.toString()
        cb()
      },
    }),
    { columns: 80, rows: 24, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const settle = () => new Promise(r => setTimeout(r, 60))
  const chosen: string[] = []
  const h = React.createElement as (...a: unknown[]) => React.ReactElement
  const instance = await render(
    h(AppStateProvider as never, {}, h(KeybindingSetup as never, {}, h(Select as never, {
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No, and tell Mercury why', value: 'no' },
        { label: 'Always', value: 'always' },
      ],
      onChange: (v: string) => chosen.push(v),
      onCancel: () => {},
    }))),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle()
  // Down + Enter in ONE chunk: the burst a fast operator or an SSH link delivers.
  ;(stdin as unknown as Readable).push('\u001b[B\r')
  await settle()
  t('↵ in the same chunk as ↓ activates the option ↓ landed on', chosen.length === 1 && chosen[0] === 'no', JSON.stringify(chosen))
  instance.unmount()
  void written
}

// —— 6. ./ survives completion ——————————————————————————————————————————
{
  const { getPathCompletions } = await import('../../src/utils/suggestions/directoryCompletion.ts')
  const dir = join(SCRATCH, 'proj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'script.sh'), '#!/bin/sh\n')
  const completions = await getPathCompletions('./scr', { basePath: dir })
  t('a typed ./ is kept on the completion', completions.some(c => c.id === './script.sh'), JSON.stringify(completions.map(c => c.id)))
  const bare = await getPathCompletions('scr', { basePath: dir })
  t('a bare prefix completes bare', bare.some(c => c.id === 'script.sh'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
