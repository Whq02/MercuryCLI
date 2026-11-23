#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-input-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = '', hint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
  if (!ok) failures = 1
}

{
  const { queuedCommandHistoryEntry } = await import('../../src/sessions/promptHistory.ts')
  const human = queuedCommandHistoryEntry({ value: 'fix the build', mode: 'prompt' })
  t('a human-typed queued prompt earns its entry at drain', human?.display === 'fix the build', '', 'queuedCommandHistoryEntry in src/sessions/promptHistory.ts must return an entry whose display is the typed text for a plain prompt')
  const bash = queuedCommandHistoryEntry({ value: 'ls -la', preExpansionValue: 'ls -la', mode: 'bash' })
  t('a queued bash command keeps its ! prefix', bash?.display === '!ls -la', '', 'queuedCommandHistoryEntry in src/sessions/promptHistory.ts must prefix a bash-mode display with !')
  const pasted = queuedCommandHistoryEntry({ value: 'expanded paste text', preExpansionValue: 'look at [Pasted text #1]', mode: 'prompt', pastedContents: { 1: { id: 1, type: 'text', content: 'x' } as never } })
  t('the pre-expansion text is what history records', pasted?.display === 'look at [Pasted text #1]' && pasted.pastedContents[1] !== undefined, '', 'queuedCommandHistoryEntry in src/sessions/promptHistory.ts must record preExpansionValue and keep pastedContents')
  t('a meta command earns nothing', queuedCommandHistoryEntry({ value: 'cron fire', mode: 'prompt', isMeta: true }) === null, '', 'queuedCommandHistoryEntry in src/sessions/promptHistory.ts must return null for an isMeta command')
  t('a bridge/remote command earns nothing', queuedCommandHistoryEntry({ value: 'remote', mode: 'prompt', bridgeOrigin: true }) === null && queuedCommandHistoryEntry({ value: 'remote', mode: 'prompt', skipSlashCommands: true }) === null, '', 'queuedCommandHistoryEntry in src/sessions/promptHistory.ts must return null for bridgeOrigin and skipSlashCommands commands')
  t('a structurally-stamped origin earns nothing', queuedCommandHistoryEntry({ value: 'x', mode: 'prompt', origin: 'system' }) === null, '', 'queuedCommandHistoryEntry in src/sessions/promptHistory.ts must return null when the command carries an origin')
  t('task notifications earn nothing', queuedCommandHistoryEntry({ value: '<task-notification/>', mode: 'task-notification' }) === null, '', 'queuedCommandHistoryEntry in src/sessions/promptHistory.ts must return null for task-notification mode')
  t('block-content values earn nothing', queuedCommandHistoryEntry({ value: [{ type: 'text', text: 'x' }], mode: 'prompt' }) === null, '', 'queuedCommandHistoryEntry in src/sessions/promptHistory.ts must return null when the value is a block-content array')
}

{
  process.env.MERCURY_FULLSCREEN = '1'
  const { collapseReadSearchGroups, isStatusUpdateTool } = await import('../../src/screen/messages/collapseReadSearch.ts')
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const { TaskCreateTool } = await import('../../src/tools/task-create/TaskCreateTool.ts')
  const { FileEditTool } = await import('../../src/tools/edit/EditTool.ts')
  const tools = [BashTool, TaskCreateTool, FileEditTool] as never
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
  const task = { subject: 'a', description: 'a' }
  const seq = [
    use('b1', 'Bash', { command: 'echo hi' }), result('b1', 'hi', bashResult),
    use('t1', 'TaskCreate', task), result('t1', 'ok', { task: { id: '1', ...task, status: 'pending' } }),
    use('b2', 'Bash', { command: 'echo again' }), result('b2', 'again', bashResult),
  ]
  const out = collapseReadSearchGroups(seq as never, tools) as Array<{ type: string; bashCount?: number; message?: { content?: Array<{ name?: string; tool_use_id?: string }> } }>
  const collapsed = out.filter(m => m.type === 'collapsed_read_search')
  t('TaskCreate is a status-update tool; Bash is not', isStatusUpdateTool('TaskCreate') && !isStatusUpdateTool('Bash'), '', 'isStatusUpdateTool in src/screen/messages/collapseReadSearch.ts must be true for TaskCreate and false for Bash')
  t('bash · task · bash collapses to ONE shell row', collapsed.length === 1, `${collapsed.length} collapsed rows`, 'collapseReadSearchGroups in src/screen/messages/collapseReadSearch.ts must let a status-update tool sit inside a shell group instead of splitting it')
  t('the one row counts both commands', collapsed[0]?.bashCount === 2, `bashCount ${collapsed[0]?.bashCount}`, 'collapseReadSearchGroups in src/screen/messages/collapseReadSearch.ts must count both shell commands on the one collapsed row')
  const todoUseAt = out.findIndex(m => m.type === 'assistant' && m.message?.content?.[0]?.name === 'TaskCreate')
  const todoResultAt = out.findIndex(m => m.type === 'user' && m.message?.content?.[0]?.tool_use_id === 't1')
  const rowAt = out.findIndex(m => m.type === 'collapsed_read_search')
  t('the task use AND its result defer behind the collapsed row, in order', rowAt >= 0 && todoUseAt > rowAt && todoResultAt > todoUseAt, `row ${rowAt} use ${todoUseAt} result ${todoResultAt}`, 'collapseReadSearchGroups in src/screen/messages/collapseReadSearch.ts must emit the status tool use and then its result after the collapsed row')
  t('nothing is dropped', out.length === 3, '', 'collapseReadSearchGroups in src/screen/messages/collapseReadSearch.ts must keep the collapsed row, the task use and the task result')

  const withEdit = [
    use('b3', 'Bash', { command: 'echo one' }), result('b3', 'one', bashResult),
    use('e1', 'Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }), result('e1', 'ok', {}),
    use('b4', 'Bash', { command: 'echo two' }), result('b4', 'two', bashResult),
  ]
  const split = collapseReadSearchGroups(withEdit as never, tools) as Array<{ type: string }>
  t('a non-status tool (Edit) still breaks the group into two rows', split.filter(m => m.type === 'collapsed_read_search').length === 2, '', 'collapseReadSearchGroups in src/screen/messages/collapseReadSearch.ts must end a group at a non-status tool such as Edit')

  const alone = collapseReadSearchGroups([use('t2', 'TaskCreate', task), result('t2', 'ok', { task: { id: '2', ...task, status: 'pending' } })] as never, tools) as Array<{ type: string }>
  t('a task update outside any group renders in place (no collapsed row)', alone.length === 2 && alone[0]!.type === 'assistant' && alone[1]!.type === 'user', '', 'collapseReadSearchGroups in src/screen/messages/collapseReadSearch.ts must leave a status-update tool outside any group as it is')
  delete process.env.MERCURY_FULLSCREEN
}

{
  const { wordStartBefore, wordStartAfter } = await import('../../src/platform/text/textSegments.ts')
  const { Cursor } = await import('../../src/screen/composer/vim/textCursor.ts')
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
  t('search-box word boundaries agree with the composer at every offset of every sample', agree, disagreements.slice(0, 3).join(' | '), 'wordStartBefore and wordStartAfter in src/platform/text/textSegments.ts and prevWord and nextWord in src/screen/composer/vim/textCursor.ts must find the same word boundaries')
  t('an accented word is one word (ctrl+w on "café" at its end deletes the whole word)', wordStartBefore('café', 4) === 0, '', 'wordStartBefore in src/platform/text/textSegments.ts must treat an accented word as one word')
}

{
  const { getSessionVimPersistentState, _resetSessionVimPersistentStateForTesting } = await import('../../src/screen/composer/vim/vimState.ts')
  _resetSessionVimPersistentStateForTesting()
  const first = getSessionVimPersistentState()
  first.register = 'yanked words'
  first.registerIsLinewise = false
  const second = getSessionVimPersistentState()
  t('a second mount reads the same register', second === first && second.register === 'yanked words', '', 'getSessionVimPersistentState in src/screen/composer/vim/vimState.ts must return the same object on every call until it is reset')
}

{
  const React = await import('react')
  const { render } = await import('../../src/screen/themedRenderer.js')
  const { Select } = await import('../../src/screen/select/Select.js')
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
  const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
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
  ;(stdin as unknown as Readable).push('\u001b[B\r')
  await settle()
  t('↵ in the same chunk as ↓ activates the option ↓ landed on', chosen.length === 1 && chosen[0] === 'no', JSON.stringify(chosen), 'the Select component in src/screen/select/Select.tsx must let Enter in the same input chunk as a down arrow pick the option the arrow landed on')
  instance.unmount()
  void written
}

{
  const { getPathCompletions } = await import('../../src/screen/suggestions/pathCompletion.ts')
  const dir = join(SCRATCH, 'proj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'script.sh'), '#!/bin/sh\n')
  const completions = await getPathCompletions('./scr', { basePath: dir })
  t('a typed ./ is kept on the completion', completions.some(c => c.id === './script.sh'), JSON.stringify(completions.map(c => c.id)), 'getPathCompletions in src/screen/suggestions/pathCompletion.ts must keep a typed ./ prefix on each completion id')
  const bare = await getPathCompletions('scr', { basePath: dir })
  t('a bare prefix completes bare', bare.some(c => c.id === 'script.sh'), '', 'getPathCompletions in src/screen/suggestions/pathCompletion.ts must return a bare completion id when the prefix has no ./')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
