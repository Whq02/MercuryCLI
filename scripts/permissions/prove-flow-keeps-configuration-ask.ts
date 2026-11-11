#!/usr/bin/env bun
import { check, decide, fill, finish, note, pageText, said, section, shown, type Rules } from './floorsKit.ts'

type Call = [tool: string, input: Record<string, unknown>]
const RULE = JSON.stringify({ guardrails: { allow: ['Bash(ls *)'] } })
const written = (path: string): Call[] => [
  ['Write', { file_path: fill(path), content: RULE }],
  ['Bash', { command: `echo '${RULE}' > ${fill(path)}` }],
  ['Bash', { command: `cp notes.txt ${fill(path)}` }],
]
const CONFIGURATION = [
  '<PROJECT>/.mercury/settings.local.json', '<PROJECT>/.mercury/settings.json', '<CONFIG>/settings.json',
  '<PROJECT>/.mercury/wards.json', '<PROJECT>/.mercury/mcp.json', '<PROJECT>/.mercury/keybindings.json', '<CONFIG>/keybindings.json',
  '<PROJECT>/MERCURY.md', '<PROJECT>/AGENTS.md',
]
const told = (tool: string, input: Record<string, unknown>): string => (tool === 'Bash' ? shown(String(input.command)).slice(0, 110) : `${tool} ${shown(String(input.file_path))}`)

section('the page, docs/TRUST.md')
check('sensitive files, such as credentials and Mercury configuration, retain their own permission checks', /Sensitive files, such as credentials and Mercury configuration, retain their own permission checks/.test(pageText()))

section('§1 under Flow a write to Mercury\'s own configuration keeps its ask, by a file tool and by a shell write alike')
for (const path of CONFIGURATION) {
  for (const [tool, input] of written(path)) {
    const flow = await decide(tool, input, 'flow')
    check(`flow · ${told(tool, input)} · asks`, flow.behavior === 'ask', said(flow))
  }
}

section('§2 the modes beside it: Default and Implement ask as before, Sovereign asks nothing')
for (const path of CONFIGURATION) {
  const wrong: string[] = []
  for (const [tool, input] of written(path)) {
    for (const [mode, behavior] of [['default', 'ask'], ['implement', 'ask'], ['sovereign', 'allow']] as const) {
      const decision = await decide(tool, input, mode)
      if (decision.behavior !== behavior) wrong.push(`${mode} ${told(tool, input)}: ${said(decision)}`)
    }
  }
  check(`${shown(fill(path))} · default and implement ask, sovereign allows, by the file tool and by both shell writes`, wrong.length === 0, wrong.join(' ‖ '))
}

section('§3 the ask reaches no further than the configuration')
for (const [tool, input] of [...written('<PROJECT>/notes.txt'), ...written('<PROJECT>/sub/settings.json'), ...written('<PROJECT>/docs/plain.md')]) {
  const flow = await decide(tool, input, 'flow')
  check(`flow · ${told(tool, input)} · runs unasked`, flow.behavior === 'allow', said(flow))
}
{
  const exact: Rules = { allow: ['Edit(.mercury/wards.json)'] }
  const granted = await decide('Write', { file_path: fill('<PROJECT>/.mercury/wards.json'), content: '{}' }, 'flow', exact)
  check('flow · a rule that names the file exactly grants the write', granted.behavior === 'allow', said(granted))
  const other = await decide('Write', { file_path: fill('<PROJECT>/.mercury/mcp.json'), content: '{}' }, 'flow', exact)
  check('flow · that rule reaches its own file alone', other.behavior === 'ask', said(other))
}
note('nothing in this proof is executed: tool inputs handed to the decision function with the real tools')
finish('prove-flow-keeps-configuration-ask')
