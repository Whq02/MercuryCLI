#!/usr/bin/env bun
// gate-watch: src/tools/shell/bashPermissions.ts src/tools/shell/compoundCommandPermissions.ts src/tools/shell/readOnlyValidation.ts
// gate-watch: src/permissions/rules/decision/wrapper.ts src/permissions/rules/decision/engine.ts src/permissions/rules/decision/requestMessage.ts
// gate-watch: src/platform/shell/bash/commands.ts src/platform/shell/bash/parsedCommand.ts src/tools/kit/tool.ts src/platform/settings/config.ts
import { mock } from 'bun:test'
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

const platformModule = await import('../../src/platform/environment/platform.js')
let platform: ReturnType<typeof platformModule.getPlatform> = platformModule.getPlatform()
mock.module('../../src/platform/environment/platform.js', () => ({ ...platformModule, getPlatform: () => platform }))
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
await import('../../src/tools/kit/tool.js')
const { decideToolPermissionWithModes } = await import('../../src/permissions/rules/decision/wrapper.js')
const { bashToolHasPermission, isCurrentFolderSpelling } = await import('../../src/tools/shell/bashPermissions.js')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')

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

console.log('\n1. the piped python3 -c: the part is quoted as sent, with its quotes whole; its redirection and pipe never change the verdict')
{
  const command = `python3 -c "import ast; ast.parse(open('${bigPy}').read())" 2>&1 | tail -5`
  const o = await decide(command)
  const message = o.decision.message ?? ''
  check('the engine asks', o.decision.behavior === 'ask', `${shown(o)} — bashToolHasPermission in src/tools/shell/bashPermissions.ts must ask for a python3 -c part, and decideToolPermissionWithModes in src/permissions/rules/decision/wrapper.ts must pass that ask through`)
  check('the message quotes the part as written, its quotes whole; the redirection is not part of the verdict', message.includes(`python3 -c "import ast; ast.parse(open('${bigPy}').read())"`) && !message.includes('2>&1'), `${shown(o)} — the asked part must be quoted as sent with its quotes whole and without the 2>&1 redirection; see bashToolHasPermission in src/tools/shell/bashPermissions.ts`)
  check("the message carries neither a doubled quote nor a split 2 >& 1", !message.includes("''") && !message.includes('2 >& 1'), `${shown(o)} — the part text must not be re-rendered from the parse tree; see bashToolHasPermission in src/tools/shell/bashPermissions.ts`)
  check('the sentence is the several-parts sentence', message.startsWith('One part of this Bash command needs approval: '), `${shown(o)} — a piped command with one refused part must use the several-parts sentence; see bashToolHasPermission in src/tools/shell/bashPermissions.ts`)
}

console.log('\n2. the single python3 -c: one sentence naming the part and the word')
{
  const command = `python3 -c "import ast; ast.parse(open('${bigPy}').read())"`
  const part = command.length > 120 ? `${command.slice(0, 120)}…` : command
  const o = await decide(command)
  check('the engine asks', o.decision.behavior === 'ask', `${shown(o)} — bashToolHasPermission in src/tools/shell/bashPermissions.ts must ask for a lone python3 -c`)
  check('the message is the one-part sentence (the part cut at 120 characters when longer)', o.decision.message === `\`${part}\` requires approval: \`python3\` is not a command Mercury can verify as read-only.`, `${shown(o)} — the one-part approval sentence must quote the part (cut at 120 characters) and name the command word; see bashToolHasPermission in src/tools/shell/bashPermissions.ts`)
  check('the ungranted line is gone from this road', !(o.decision.message ?? '').includes("but you haven't granted it yet"), `${shown(o)} — remove the ungranted line from this road in src/tools/shell/bashPermissions.ts`)
}

console.log('\n3. the operator gate names the operator')
{
  const background = await decide('sleep 1 &')
  check('sleep 1 & → names `&`', background.decision.behavior === 'ask' && background.decision.message === 'the background operator & starts work outside the foreground command; run it in the foreground, or approve', `${shown(background)} — the background operator refusal is raised in src/permissions/rules/decision/command-analysis/exactCommands.ts`)
  const subshell = await decide('(cd x && ls)')
  check('(cd x && ls) → the parsed read-only subshell runs', subshell.decision.behavior === 'allow', `${shown(subshell)} — a read-only subshell must be allowed; see the operator gate in src/permissions/rules/decision/command-analysis/exactCommands.ts`)
  const expanding = await decide('cat < $F')
  check('cat < $F → names `<` with its target', expanding.decision.behavior === 'ask' && expanding.decision.message === 'the expansion "$F" supplies a value at runtime; spell out the value, or approve', `${shown(expanding)} — the runtime-expansion refusal must name the expansion; see src/permissions/rules/decision/command-analysis/exactCommands.ts`)
}

console.log('\n4. a pipe split across lines judges the second command as written')
{
  const o = await decide('wc -l b_big.py |\n head -n 1')
  check('wc -l b_big.py |<newline> head -n 1 → allow (both segments read-only)', o.decision.behavior === 'allow', `${shown(o)} — a pipe continued on the next line must be judged per segment; see bashToolHasPermission in src/tools/shell/bashPermissions.ts`)
  const asked = await decide('wc -l b_big.py |\n python3 -')
  check('the refused segment is quoted as written, with no marker', asked.decision.behavior === 'ask' && (asked.decision.message ?? '').endsWith('One part of this Bash command needs approval: python3 -') && !(asked.decision.message ?? '').includes('MERCURYnl'), `${shown(asked)} — the refused segment must be quoted as written, with no line-break marker; see bashToolHasPermission in src/tools/shell/bashPermissions.ts`)
}

console.log('\n5. the other one-part reasons')
{
  const interpreter = await decide('python3 < b_big.py')
  check('python3 < b_big.py → the one-part sentence quoting the redirect as written', interpreter.decision.message === '`python3 < b_big.py` requires approval: `python3` is not a command Mercury can verify as read-only.', `${shown(interpreter)} — the redirect must be quoted as written; see bashToolHasPermission in src/tools/shell/bashPermissions.ts`)
  const cwdPrefixed = await decide(`cd '${root}' && npm test`, 'default')
  check('a cd to the starting folder is not quoted; the part is', cwdPrefixed.decision.message === '`npm test` requires approval: `npm` is not a command Mercury can verify as read-only.', `${shown(cwdPrefixed)} — a cd to the starting folder must be dropped from the quoted part; see isCurrentFolderSpelling and bashToolHasPermission in src/tools/shell/bashPermissions.ts`)
  const long = await decide(`node -e "${'x'.repeat(130)}"`, 'default')
  check('a part longer than 120 characters is cut with an ellipsis', (long.decision.message ?? '').startsWith(`\`node -e "${'x'.repeat(111)}…\` requires approval: \`node\` is not a command Mercury can verify as read-only.`), `${shown(long)} — a part over 120 characters must be cut with an ellipsis; see bashToolHasPermission in src/tools/shell/bashPermissions.ts`)
}

console.log('\n6. on Windows the starting folder is read in its three spellings: as written, C:/…, /c/… — and in no other')
{
  const hostPlatform = platform
  platform = 'windows'
  const cwd = 'C:\\Users\\Dev\\proj'
  for (const spelled of ['C:\\Users\\Dev\\proj', 'C:/Users/Dev/proj', '/c/Users/Dev/proj', 'c:\\Users\\Dev\\proj', 'c:/Users/Dev/proj', '/C/Users/Dev/proj', 'C:\\Users\\Dev\\proj\\', 'C:/Users/Dev/proj/', '/c/Users/Dev/proj/']) {
    check(`${spelled} is the starting folder ${cwd}`, isCurrentFolderSpelling(spelled, cwd), 'fix isCurrentFolderSpelling in src/tools/shell/bashPermissions.ts so this Windows spelling counts as the starting folder')
  }
  for (const other of ['C:/Users/Dev/proj2', 'C:/Users/Dev', 'C:/Users/Dev/proj/sub', 'D:/Users/Dev/proj', '/d/Users/Dev/proj', 'Users/Dev/proj', '/Users/Dev/proj', 'C:Users/Dev/proj', 'C:/users/dev/proj', '//server/Users/Dev/proj']) {
    check(`${other} is not ${cwd}`, !isCurrentFolderSpelling(other, cwd), 'fix isCurrentFolderSpelling in src/tools/shell/bashPermissions.ts so this spelling is not read as the starting folder')
  }
  check('the MSYS spelling of the starting folder also reads a C:/ cd as the same folder', isCurrentFolderSpelling('C:/Users/Dev/proj', '/c/Users/Dev/proj') && isCurrentFolderSpelling('C:\\Users\\Dev\\proj', '/c/Users/Dev/proj'), 'isCurrentFolderSpelling in src/tools/shell/bashPermissions.ts must also match when the starting folder itself is given in the /c/ spelling')
  check('a drive root: C:\\, C:/ and /c are one folder', isCurrentFolderSpelling('C:/', 'C:\\') && isCurrentFolderSpelling('/c', 'C:\\') && !isCurrentFolderSpelling('/c/x', 'C:\\'), 'isCurrentFolderSpelling in src/tools/shell/bashPermissions.ts must treat a drive root in all three spellings as one folder')
  platform = hostPlatform
  if (hostPlatform === 'windows') check('on this platform the folder is read in its Windows spellings: as written, with a trailing separator, never another folder', isCurrentFolderSpelling(root, root) && isCurrentFolderSpelling(`${root}\\`, root) && !isCurrentFolderSpelling(`${root}-other`, root), 'isCurrentFolderSpelling in src/tools/shell/bashPermissions.ts must match the folder as written or with a trailing separator, and no other folder')
  else check('on this platform the spelling is exact: the folder as written, with no trailing separator and no case folding', isCurrentFolderSpelling(root, root) && !isCurrentFolderSpelling(`${root}/`, root) && !isCurrentFolderSpelling(root.toUpperCase() === root ? root.toLowerCase() : root.toUpperCase(), root), 'isCurrentFolderSpelling in src/tools/shell/bashPermissions.ts must match the folder exactly as written on this platform: no trailing separator, no case folding')
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-bash-approval-words: ALL LAWS HOLD' : `\nprove-bash-approval-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
