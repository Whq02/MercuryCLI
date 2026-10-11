#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'powershell-rows-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { powershellToolUseOptions } = await import('../../src/components/permissions/PowerShellPermissionRequest/powershellToolUseOptions.js')
const { POWERSHELL_TOOL_NAME } = await import('../../src/tools/PowerShellTool/toolName.js')
type Row = ReturnType<typeof powershellToolUseOptions>[number] & { type?: string; placeholder?: string; initialValue?: string; onChange?: unknown; allowEmptySubmitToCancel?: boolean; showLabelWithValue?: boolean; labelValueSeparator?: string; resetCursorOnUpdate?: boolean }

const accept = (): void => {}
const reject = (): void => {}
const prefixChange = (): void => {}
const rule = (toolName: string, ruleContent?: string) => ({ type: 'addRules' as const, rules: [{ toolName, ruleContent }], behavior: 'allow' as const, destination: 'localSettings' as const })
const rows = (args: Partial<Parameters<typeof powershellToolUseOptions>[0]>): Row[] =>
  powershellToolUseOptions({ onAcceptFeedbackChange: accept, onRejectFeedbackChange: reject, ...args }) as Row[]
const values = (list: Row[]): string => j(list.map(row => row.value))

section('§1 THE TWO FIXED ROWS — plain until an amendment opens, then an input row with its own words')
{
  const plain = rows({})
  check('without suggestions the card has the yes and no rows only', values(plain) === j(['yes', 'no']), values(plain))
  check('both rows are plain', plain.every(row => row.type === undefined) && plain[0]?.label === 'Yes' && plain[1]?.label === 'No, and tell Mercury what to do differently (esc)', j(plain))
  const yesOpen = rows({ yesInputMode: true })[0] as Row
  check('an open yes amendment is an input row with its placeholder, the accept setter and empty-submit cancel', yesOpen.type === 'input' && yesOpen.label === 'Yes' && yesOpen.placeholder === 'tell Mercury what to do next' && yesOpen.onChange === accept && yesOpen.allowEmptySubmitToCancel === true, j(yesOpen))
  const noOpen = rows({ noInputMode: true })[1] as Row
  check('an open no amendment is an input row with its placeholder, the reject setter and empty-submit cancel', noOpen.type === 'input' && noOpen.label === 'No, and tell Mercury what to do differently (esc)' && noOpen.placeholder === 'tell Mercury what to do differently' && noOpen.onChange === reject && noOpen.allowEmptySubmitToCancel === true, j(noOpen))
  check('an open amendment on one role leaves the other plain', rows({ yesInputMode: true })[1]?.type === undefined && rows({ noInputMode: true })[0]?.type === undefined)
}

section('§2 THE ALWAYS-ALLOW ROW — the editable prefix when every rule is a PowerShell rule and a prefix rides along')
{
  const edited = rows({ suggestions: [rule(POWERSHELL_TOOL_NAME, 'Get-Process:*')], editablePrefix: 'Get-Process *', onEditablePrefixChange: prefixChange })
  check('the middle row is the edited-prefix input', values(edited) === j(['yes', 'yes-edited-prefix', 'no']), values(edited))
  const input = edited[1] as Row
  check('it carries the prefix, its words and the cursor and label flags', input.type === 'input' && input.initialValue === 'Get-Process *' && input.onChange === prefixChange && input.placeholder === 'Get-Process *' && input.label === "Yes, and don't ask again for commands starting with" && input.showLabelWithValue === true && input.labelValueSeparator === ': ' && input.resetCursorOnUpdate === true, j(input))
  const noPrefix = rows({ suggestions: [rule(POWERSHELL_TOOL_NAME, 'Get-Process:*')], onEditablePrefixChange: prefixChange })
  check('without a prefix the same suggestions fall back to the apply row', values(noPrefix) === j(['yes', 'yes-apply-suggestions', 'no']) && noPrefix[1]?.type === undefined, values(noPrefix))
  const noHandler = rows({ suggestions: [rule(POWERSHELL_TOOL_NAME, 'Get-Process:*')], editablePrefix: 'Get-Process *' })
  check('without a change handler too', values(noHandler) === j(['yes', 'yes-apply-suggestions', 'no']), values(noHandler))
  const mixed = rows({ suggestions: [rule(POWERSHELL_TOOL_NAME, 'Get-Process:*'), rule('Read', '/tmp/logs/**')], editablePrefix: 'Get-Process *', onEditablePrefixChange: prefixChange })
  check('a Read rule among the suggestions cannot be one prefix: the apply row describes them instead', values(mixed) === j(['yes', 'yes-apply-suggestions', 'no']) && mixed[1]?.label !== null && typeof mixed[1]?.label === 'object', values(mixed))
  const empty = rows({ suggestions: [], editablePrefix: 'Get-Process *', onEditablePrefixChange: prefixChange })
  check('an empty suggestion list adds no row', values(empty) === j(['yes', 'no']), values(empty))
  const silent = rows({ suggestions: [{ type: 'setMode', mode: 'implement', destination: 'session' }] as never, editablePrefix: 'Get-Process *', onEditablePrefixChange: prefixChange })
  check('suggestions the label builder cannot describe add no row either', values(silent) === j(['yes', 'no']), values(silent))
  const both = rows({ suggestions: [rule(POWERSHELL_TOOL_NAME, 'Get-Process:*')], editablePrefix: 'Get-Process *', onEditablePrefixChange: prefixChange, yesInputMode: true, noInputMode: true })
  check('the order holds with every row open: yes, the prefix input, no', values(both) === j(['yes', 'yes-edited-prefix', 'no']) && both.every(row => row.type === 'input'), values(both))
}

console.log(failures === 0 ? '\nPASS powershell card rows' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
