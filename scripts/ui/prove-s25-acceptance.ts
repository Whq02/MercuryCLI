#!/usr/bin/env bun


process.env.NODE_ENV = 'test'

import OptionMap, {
  isInputOption,
  optionValueOf,
} from '../../src/screen/select/optionMap.js'
import { color, isRawColorValue, resolveThemeColor } from '../../src/screen/theme/color.js'
import {
  copyTextOf,
  isNavigableMessage,
  MESSAGE_ACTIONS,
  stripSystemReminders,
  toolCallOf,
} from '../../src/screen/messages/messageActions.js'
import { getAgentSourceDisplayName } from '../../src/screen/agents/utils.js'
import { getTheme } from '../../src/screen/theme/theme.js'

let passCount = 0
let failCount = 0
let blockFixHint = ''
function check(name: string, condition: boolean): void {
  if (condition) {
    passCount++
    console.log(`  [PASS] ${name}`)
  } else {
    failCount++
    console.log(`  [FAIL] ${name}${blockFixHint ? ` — ${blockFixHint}` : ''}`)
  }
}


console.log('S25 §7.2 acceptance battery')

{
  blockFixHint = 'change isRawColorValue, resolveThemeColor or color in src/screen/theme/color.ts'
  for (const raw of ['rgb(1, 2, 3)', '#aabbcc', 'ansi256(41)', 'ansi:red']) {
    check(`raw form recognized: ${raw}`, isRawColorValue(raw))
  }
  check('role name is not a raw form', !isRawColorValue('brand'))
  const dark = getTheme('dark')
  check('resolveThemeColor raw bypasses lookup', resolveThemeColor(dark, '#123456') === '#123456')
  check('resolveThemeColor role resolves', resolveThemeColor(dark, 'brand') === dark.brand)
  check('resolveThemeColor unknown role → nothing, no throw', resolveThemeColor(dark, 'not-a-role') === undefined)
  check('resolveThemeColor empty → nothing', resolveThemeColor(dark, '') === undefined)
  check('color() undefined returns text unchanged', color(undefined, 'dark')('x') === 'x')
  const painted = color('brand', 'dark')('x')
  check('color() role paints (or degrades to identity under NO_COLOR)', typeof painted === 'string' && painted.includes('x'))
}

{
  blockFixHint = 'change the OptionMap class or isInputOption or optionValueOf in src/screen/select/optionMap.ts'
  const options = [
    { label: 'a', value: 'a' },
    { label: 'b', value: 'b', disabled: true },
    { type: 'input' as const, label: 'c', value: 'c' },
  ]
  const map = new OptionMap(options)
  check('option map size', map.size === 3)
  check('first/last exposed', map.first?.value === 'a' && map.last?.value === 'c')
  check('doubly linked forward', map.first?.next?.value === 'b' && map.first?.next?.next?.value === 'c')
  check('doubly linked backward', map.last?.previous?.value === 'b')
  check('absolute indices', map.get('b')?.index === 1)
  check('disabled flag carried', map.get('b')?.disabled === true)
  check('isInputOption discriminates', isInputOption(options[2]) && !isInputOption(options[0]))
  check('optionValueOf reads the pinned value', optionValueOf(options[1]) === 'b')
}

{
  blockFixHint = 'change stripSystemReminders in src/screen/messages/messageActions.tsx'
  check('strip: zero blocks', stripSystemReminders('  hello') === 'hello')
  check(
    'strip: one block',
    stripSystemReminders('<system-reminder>x</system-reminder>  hi') === 'hi',
  )
  check(
    'strip: several blocks',
    stripSystemReminders(
      ' <system-reminder>a</system-reminder> <system-reminder>b</system-reminder>ok',
    ) === 'ok',
  )
  const unterminated = '<system-reminder>never closed... hello'
  check('strip: unterminated block stops', stripSystemReminders(unterminated) === unterminated)
}

{
  blockFixHint = 'change isNavigableMessage in src/screen/messages/messageActions.tsx'
  const user = (over: Record<string, unknown> = {}, text = 'a prompt') =>
    ({
      type: 'user',
      uuid: 'u1',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'text', text }] },
      ...over,
    }) as never
  check('user: plain prompt navigable', isNavigableMessage(user()))
  check('user: meta excluded', !isNavigableMessage(user({ isMeta: true })))
  check('user: compact summary excluded', !isNavigableMessage(user({ isCompactSummary: true })))
  check(
    'user: XML-wrapped excluded after strip',
    !isNavigableMessage(user({}, '<system-reminder>r</system-reminder><local-command-stdout>x')),
  )
  check(
    'user: reminder-prefixed real prompt navigable',
    isNavigableMessage(user({}, '<system-reminder>r</system-reminder>hello')),
  )
  const assistant = (block: unknown) =>
    ({
      type: 'assistant',
      uuid: 'a1',
      timestamp: 't',
      message: { role: 'assistant', content: [block] },
    }) as never
  check('assistant: text navigable', isNavigableMessage(assistant({ type: 'text', text: 'hi' })))
  check('assistant: empty text excluded', !isNavigableMessage(assistant({ type: 'text', text: '' })))
  check(
    'assistant: primary-table tool call navigable',
    isNavigableMessage(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'x' })),
  )
  check(
    'assistant: off-table tool call excluded',
    !isNavigableMessage(assistant({ type: 'tool_use', name: 'SomethingElse', input: {}, id: 'x' })),
  )
  const system = (subtype: string) =>
    ({ type: 'system', subtype, uuid: 's1', timestamp: 't', content: 'x', level: 'info' }) as never
  for (const subtype of [
    'api_metrics',
    'turn_duration',
    'memory_saved',
    'agents_killed',
    'away_summary',
    'thinking',
  ]) {
    check(`system: ${subtype} excluded`, !isNavigableMessage(system(subtype)))
  }
  check('system: other subtype navigable', isNavigableMessage(system('informational')))
  check('turn receipt excluded', !isNavigableMessage({ type: 'turn_receipt', uuid: 'r', counts: {} } as never))
  const attachment = (type: string) =>
    ({ type: 'attachment', uuid: 'at', timestamp: 't', attachment: { type } }) as never
  for (const type of ['queued_command', 'diagnostics', 'hook']) {
    check(`attachment: ${type} navigable`, isNavigableMessage(attachment(type)))
  }
  check('attachment: other type excluded', !isNavigableMessage(attachment('taste_recall')))
  check(
    'grouped tool use navigable',
    isNavigableMessage({ type: 'grouped_tool_use', toolName: 'Read', messages: [], results: [], uuid: 'g' } as never),
  )
}

{
  blockFixHint = 'change toolCallOf, copyTextOf or the MESSAGE_ACTIONS table in src/screen/messages/messageActions.tsx'
  const toolMsg = (name: string, input: unknown) =>
    ({
      type: 'assistant',
      uuid: 'a2',
      timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'tool_use', name, input, id: 'x' }] },
    }) as never
  check('toolCallOf reads the first block', toolCallOf(toolMsg('Read', { file_path: '/x' }))?.name === 'Read')
  check(
    'copy of a Bash call is its command',
    copyTextOf(toolMsg('Bash', { command: 'echo hi' })) === 'echo hi',
  )
  check(
    'Tmux renders its args array as a command string',
    copyTextOf(toolMsg('Tmux', { args: ['ls', '-la'] })) === 'tmux ls -la',
  )
  check(
    'non-string primary value yields nothing',
    copyTextOf(toolMsg('Read', { file_path: 42 })) === '',
  )
  const pAction = MESSAGE_ACTIONS.find(a => a.key === 'p')
  check('p action exists for grouped/assistant', Boolean(pAction) && pAction!.types.includes('assistant'))
  check(
    'p applicability requires a primary-table tool',
    pAction!.isApplicable!({ uuid: 'x', type: 'assistant', expanded: false, toolName: 'Read' }) === true &&
      pAction!.isApplicable!({ uuid: 'x', type: 'assistant', expanded: false, toolName: 'Nope' }) === false,
  )
  const enterRows = MESSAGE_ACTIONS.filter(a => a.key === 'enter')
  check('enter has an expand row and an edit row', enterRows.length === 2)
  const cAction = MESSAGE_ACTIONS.find(a => a.key === 'c')
  check('c applies to every navigable type', cAction!.types.length === 7)
}

{
  blockFixHint = 'change copyTextOf in src/screen/messages/messageActions.tsx'
  const result = (content: unknown) =>
    ({
      type: 'user',
      uuid: 'u2',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'tool_result', content, tool_use_id: 'x' }] },
    }) as never
  const grouped = {
    type: 'grouped_tool_use',
    toolName: 'Read',
    messages: [],
    results: [result('first'), result(''), result([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])],
    uuid: 'g2',
  } as never
  check('grouped copy joins non-blank results by blank lines', copyTextOf(grouped) === 'first\n\na\nb')
  check(
    'system copy prefers content',
    copyTextOf({ type: 'system', subtype: 's', content: 'body', uuid: 'x' } as never) === 'body',
  )
  check(
    'system copy falls back to subtype',
    copyTextOf({ type: 'system', subtype: 'just-subtype', uuid: 'x' } as never) === 'just-subtype',
  )
  check('turn receipt copies empty', copyTextOf({ type: 'turn_receipt', uuid: 'x', counts: {} } as never) === '')
  check(
    'queued command copies its prompt text',
    copyTextOf({
      type: 'attachment',
      uuid: 'x',
      timestamp: 't',
      attachment: { type: 'queued_command', prompt: 'run it' },
    } as never) === 'run it',
  )
  check(
    'other attachment copies a bracketed type label',
    copyTextOf({
      type: 'attachment',
      uuid: 'x',
      timestamp: 't',
      attachment: { type: 'diagnostics' },
    } as never) === '[diagnostics]',
  )
  check(
    'user copy strips leading reminders',
    copyTextOf({
      type: 'user',
      uuid: 'x',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>r</system-reminder>real' }] },
    } as never) === 'real',
  )
}


{
  blockFixHint = 'change getAgentSourceDisplayName in src/screen/agents/utils.ts'
  check('all → plural agents label', getAgentSourceDisplayName('all').toLowerCase().includes('agents'))
  check('built-in label', getAgentSourceDisplayName('built-in').toLowerCase().includes('built-in'))
  check('extension label', getAgentSourceDisplayName('extension').toLowerCase().includes('extension'))
  check(
    'settings source → capitalized display name',
    getAgentSourceDisplayName('userSettings') === 'User settings',
  )
}



console.log('')
console.log(`S25 acceptance battery: ${passCount} pass · ${failCount} fail`)
if (failCount > 0) process.exit(1)
console.log('ALL S25 ACCEPTANCE CHECKS PASS')
