#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_SHELL_ENGINE = 'system'
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'bang-card-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MERCURY_') && !['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE', 'MERCURY_SHELL_ENGINE', 'MERCURY_TMPDIR', 'MERCURY_DESKTOP_DRIVER'].includes(name)) delete process.env[name]
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const clip = (text: string, limit = 300): string => JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text)
const NOTICE = /session env scrubbed|inherit_session_env|Mercury's own stamps/

const { stampSpawnReceipt } = await import('../../src/substrate/envStamps.ts')
process.env.MERCURY_ENTRYPOINT = 'cli'
process.env.MERCURY_SEATS = '2'
stampSpawnReceipt(process.env, ['MERCURY_SEATS'])

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { processBashCommand } = await import('../../src/utils/processUserInput/processBashCommand.tsx')
const { resetSessionEnvNoticeForTesting } = await import('../../src/tools/shared/sessionEnvNotice.ts')
const { formatError } = await import('../../src/utils/toolErrors.ts')
const { extractTag } = await import('../../src/utils/messages.ts')
const { unescapeXml } = await import('../../src/utils/xml.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)

let appState = getDefaultAppState()
const makeContext = (): never =>
  ({
    options: { commands: [], verbose: false, engineModel: 'claude-sonnet-5', tools: [BashTool], mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
    messages: [],
    setResponseLength: () => undefined,
    updateFileHistoryState: () => undefined,
    updateAttributionState: () => undefined,
    toolUseId: 'bang-card',
  }) as never

const COMMAND = 'echo own-line; echo own-error >&2; exit 7'

type Card = { stdout: string; stderr: string; code: string | null; content: string }
async function bangCard(command: string): Promise<Card | null> {
  const outcome = await processBashCommand(command, [], [], makeContext(), (() => undefined) as never)
  const texts = (outcome.messages as Array<{ message?: { content?: unknown } }>).map(m => (typeof m.message?.content === 'string' ? m.message.content : ''))
  const content = texts.find(text => text.startsWith('<bash-stdout>'))
  if (content === undefined) return null
  return { stdout: extractTag(content, 'bash-stdout') ?? '', stderr: unescapeXml(extractTag(content, 'bash-stderr') ?? ''), code: extractTag(content, 'bash-exit-code'), content }
}

console.log('============================================================')
console.log(" The `!` card — a failed command's transcript row shows what it printed and nothing else (the painted frame: scripts/ui/prove-bang-card-frame.ts)")
console.log('============================================================')

section('§1 the model side keeps the note: a failed Bash tool call, the first of the session')
resetSessionEnvNoticeForTesting()
let modelText = ''
let thrownStderr = ''
try {
  await BashTool.call({ command: COMMAND }, makeContext())
} catch (error) {
  modelText = formatError(error)
  thrownStderr = String((error as { stderr?: string }).stderr ?? '')
}
console.log(`        the model reads ${clip(modelText)}`)
check('the call failed and the model reads the exit code and the output', modelText.startsWith('Shell command failed (exit code 7)') && modelText.includes('own-line') && modelText.includes('own-error') && /Exited with code 7/.test(modelText), clip(modelText))
check("the model's result carries the full scrub note with the inherit hint", modelText.includes('[session env scrubbed: MERCURY_ENTRYPOINT, MERCURY_SEATS') && modelText.includes('inherit_session_env: true keeps them'), clip(modelText))
check("the note rides the result as its own line after the command's output, not inside the output", modelText.indexOf('Exited with code 7') >= 0 && modelText.indexOf('[session env scrubbed') > modelText.indexOf('Exited with code 7') && !thrownStderr.includes('[session env scrubbed'), clip(thrownStderr))

section('§2 the operator\'s `!` card: a failed command as the first scrubbing command of the session')
resetSessionEnvNoticeForTesting()
const failed = await bangCard(COMMAND)
console.log(`        the card's stderr reads ${clip(failed?.stderr ?? '(no card)')}`)
check('the transcript carries the card row with the exit code', failed !== null && failed.code === '7', failed === null ? 'no <bash-stdout> row' : `code ${failed.code}`)
check("the card carries the command's own output", failed !== null && failed.stderr.includes('own-line') && failed.stderr.includes('own-error') && /Exited with code 7/.test(failed.stderr), clip(failed?.stderr ?? ''))
check('the card carries no session-env note', failed !== null && !NOTICE.test(failed.stderr) && !NOTICE.test(failed.stdout), clip(failed?.stderr ?? ''))

section('§3 controls: a succeeding `!` command, and the model side after a `!` run')
const ok = await bangCard('echo fine; echo "$MERCURY_SEATS"')
check('a succeeding command\'s card carries its output and no note', ok !== null && ok.code === '0' && ok.stdout.includes('fine') && !NOTICE.test(ok.stdout) && !NOTICE.test(ok.stderr), clip(ok?.content ?? ''))
let laterText = ''
try {
  await BashTool.call({ command: 'echo "$MERCURY_SEATS"; exit 3' }, makeContext())
} catch (error) {
  laterText = formatError(error)
}
check("a later failed tool call that names a stamp still tells the model the short line", laterText.includes('[session env scrubbed: MERCURY_SEATS]') && laterText.startsWith('Shell command failed (exit code 3)'), clip(laterText))

rmSync(SCRATCH, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR as string, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL BANG-CARD PROOFS PASS' : `\n${failures} BANG-CARD PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
