#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/bashPermissions.ts src/tools/BashTool/bashCommandHelpers.ts src/tools/BashTool/readOnlyValidation.ts
// gate-watch: src/utils/permissions/decision/wrapper.ts src/utils/permissions/decision/engine.ts src/utils/permissions/decision/requestMessage.ts
// gate-watch: src/utils/bash/commands.ts src/utils/bash/ParsedCommand.ts src/Tool.ts src/utils/config.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bash-approval-words-')))
const root = join(scratch, 'run')
mkdirSync(root)
mkdirSync(join(scratch, 'home'))
writeFileSync(join(root, 'b_big.py'), 'x = 1\n')
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { z } from 'zod/v4'

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
await import('../../src/Tool.js')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const bigPy = join(root, 'b_big.py')
const bashTool = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }).passthrough(),
  checkPermissions: async (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) =>
    bashToolHasPermission(input as never, context.getAppState().toolPermissionContext as never),
}
function contextFor(mode: string): unknown {
  const appState = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: false }, effortValue: undefined, tasks: {} }
  return { abortController: new AbortController(), getAppState: () => appState, setAppState: () => {}, messages: [], agentType: undefined, options: {} }
}
type Outcome = { decision: { behavior: string; message?: string }; wrapper: { decidedBy: string } }
const decide = async (command: string, mode = 'implement'): Promise<Outcome> =>
  (await decideToolPermissionWithModes(bashTool as never, { command }, contextFor(mode) as never, { message: { id: 'approval-words' } } as never, 'toolu_approval_words')) as Outcome
const shown = (o: Outcome): string => `${o.decision.behavior} [${o.wrapper.decidedBy}] ${o.decision.message ?? ''}`

console.log("prove-bash-approval-words — Bash's approval words name the operator and quote the part as written")

console.log('\n1. the piped python3 -c: the part is quoted as sent, with its quotes and its 2>&1 whole')
{
  const command = `python3 -c "import ast; ast.parse(open('${bigPy}').read())" 2>&1 | tail -5`
  const o = await decide(command)
  const message = o.decision.message ?? ''
  check('the engine asks', o.decision.behavior === 'ask', shown(o))
  check('the message quotes the part as written', message.includes(`python3 -c "import ast; ast.parse(open('${bigPy}').read())" 2>&1`), shown(o))
  check("the message carries neither a doubled quote nor a split 2 >& 1", !message.includes("''") && !message.includes('2 >& 1'), shown(o))
  check('the sentence is the multiple-operations sentence', message.startsWith('This Bash command contains multiple operations. The following part requires approval: '), shown(o))
}

console.log('\n2. the single python3 -c: one sentence naming the part and the word')
{
  const command = `python3 -c "import ast; ast.parse(open('${bigPy}').read())"`
  const part = command.length > 120 ? `${command.slice(0, 120)}…` : command
  const o = await decide(command)
  check('the engine asks', o.decision.behavior === 'ask', shown(o))
  check('the message is the one-part sentence (the part cut at 120 characters when longer)', o.decision.message === `\`${part}\` requires approval: \`python3\` is not a command Mercury can verify as read-only.`, shown(o))
  check('the ungranted line is gone from this road', !(o.decision.message ?? '').includes("but you haven't granted it yet"), shown(o))
}

console.log('\n3. the operator gate names the operator')
{
  const background = await decide('sleep 1 &')
  check('sleep 1 & → names `&`', background.decision.behavior === 'ask' && background.decision.message === 'the background operator & starts work outside the foreground command; run it in the foreground, or approve', shown(background))
  const subshell = await decide('(cd x && ls)')
  check('(cd x && ls) → the parsed read-only subshell runs', subshell.decision.behavior === 'allow', shown(subshell))
  const expanding = await decide('cat < $F')
  check('cat < $F → names `<` with its target', expanding.decision.behavior === 'ask' && expanding.decision.message === 'the expansion "$F" supplies a value at runtime; spell out the value, or approve', shown(expanding))
}

console.log('\n4. a pipe split across lines judges the second command as written')
{
  const o = await decide('wc -l b_big.py |\n head -n 1')
  check('wc -l b_big.py |<newline> head -n 1 → allow (both segments read-only)', o.decision.behavior === 'allow', shown(o))
  const asked = await decide('wc -l b_big.py |\n python3 -')
  check('the refused segment is quoted as written, with no marker', asked.decision.behavior === 'ask' && (asked.decision.message ?? '').endsWith('The following part requires approval: python3 -') && !(asked.decision.message ?? '').includes('MERCURYnl'), shown(asked))
}

console.log('\n5. the other one-part reasons')
{
  const interpreter = await decide('python3 < b_big.py')
  check('python3 < b_big.py → the one-part sentence quoting the redirect as written', interpreter.decision.message === '`python3 < b_big.py` requires approval: `python3` is not a command Mercury can verify as read-only.', shown(interpreter))
  const cwdPrefixed = await decide(`cd ${root} && npm test`, 'default')
  check('a cd to the starting folder is not quoted; the part is', cwdPrefixed.decision.message === '`npm test` requires approval: `npm` is not a command Mercury can verify as read-only.', shown(cwdPrefixed))
  const long = await decide(`node -e "${'x'.repeat(130)}"`, 'default')
  check('a part longer than 120 characters is cut with an ellipsis', (long.decision.message ?? '').startsWith(`\`node -e "${'x'.repeat(111)}…\` requires approval: \`node\` is not a command Mercury can verify as read-only.`), shown(long))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-bash-approval-words: ALL LAWS HOLD' : `\nprove-bash-approval-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
