#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'bare-answer-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
process.env.NODE_ENV = 'test'
delete process.env.DEBUG
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the bare-skill answer proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { initBundledSkills } = await import('../../src/skills/bundled/index.ts')
const { getBundledSkills } = await import('../../src/skills/bundledSkills.ts')
const { bareUsageLine, requiresArgument, BARE_USAGE_ROW_COLUMNS } = await import('../../src/skills/argumentHint.ts')
const { processSlashCommand } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const { applyCommandSuggestion } = await import('../../src/utils/suggestions/commandSuggestions.ts')
const { isDebugMode } = await import('../../src/utils/debug.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
type Command = import('../../src/types/command.ts').Command

const makeContext = (commands: Command[]): unknown => ({
  options: { commands, tools: [], mcpClients: [], mcpResources: {}, mainLoopModel: 'fixture-model', agentDefinitions: { activeAgents: [], allAgents: [] }, debug: false, verbose: false, isNonInteractiveSession: false },
  abortController: new AbortController(),
  readFileState: new Map(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), mcp: { clients: [] }, sessionHooks: new Map() }),
  setAppState: () => {},
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
  nestedMemoryAttachmentTriggers: new Set<string>(),
  dynamicSkillDirTriggers: new Set<string>(),
  messages: [],
  agentId: 'bare-answer-agent',
})

type Sent = { calls: number; args: string[]; shouldQuery: boolean; resultText: string | undefined; contents: string[] }
const fixturePrompt = (name: string, hint: string | undefined, calls: { n: number; args: string[] }): Command =>
  ({
    type: 'prompt',
    name,
    description: `The ${name} fixture skill — it does one thing for the operator`,
    progressMessage: 'running',
    contentLength: 0,
    source: 'bundled',
    loadedFrom: 'bundled',
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    ...(hint !== undefined ? { argumentHint: hint } : {}),
    getPromptForCommand: async (args: string) => {
      calls.n++
      calls.args.push(args)
      return [{ type: 'text', text: `expansion of ${name} with (${args})` }]
    },
  }) as Command
const send = async (commands: Command[], input: string, calls: { n: number; args: string[] }): Promise<Sent> => {
  const before = calls.n
  const result = await processSlashCommand(input, [], [], [], makeContext(commands) as never, () => {})
  const contents = result.messages.map(message =>
    message.type === 'user' && typeof message.message.content === 'string'
      ? message.message.content
      : message.type === 'system'
        ? String((message as { content?: unknown }).content ?? '')
        : `<${message.type}>`,
  )
  return { calls: calls.n - before, args: calls.args.slice(before), shouldQuery: result.shouldQuery, resultText: result.resultText, contents }
}

section('§1 THE DISPATCHER WITH A FIXTURE ROSTER — a required hint answers bare, an optional or absent one runs (RED on the base: the required hint ran a turn)')
{
  const counted = { n: 0, args: [] as string[] }
  const needs = fixturePrompt('needs-thing', '<thing to do> [how]', counted)
  const bare = await send([needs], '/needs-thing', counted)
  const usage = bareUsageLine(needs)
  check('a required-hint command sent bare builds no prompt', bare.calls === 0, `calls=${bare.calls}`)
  check('…starts no turn', bare.shouldQuery === false, `shouldQuery=${bare.shouldQuery}`)
  check('…answers the usage row as a local answer: the echo row, then the stdout row carrying the usage', bare.contents.length === 3 && bare.contents[1] === '<command-message>needs-thing</command-message><command-name>/needs-thing</command-name>' && bare.contents[2] === `<local-command-stdout>${usage}</local-command-stdout>` && bare.resultText === usage, bare.contents.join(' | '))
  check('the usage row reads "/name — description · usage: /name <hint>"', usage === '/needs-thing — The needs-thing fixture skill — it does one thing for the operator · usage: /needs-thing <thing to do> [how]', usage)
  const withArgument = await send([needs], '/needs-thing tidy the kitchen', counted)
  check('the same command with an argument builds its prompt and starts the turn', withArgument.calls === 1 && withArgument.args[0] === 'tidy the kitchen' && withArgument.shouldQuery === true, `calls=${withArgument.calls} args=${JSON.stringify(withArgument.args)} shouldQuery=${withArgument.shouldQuery}`)
  const spaced = await send([needs], '/needs-thing   ', counted)
  check('a name followed by spaces alone is a bare send', spaced.calls === 0 && spaced.shouldQuery === false, `calls=${spaced.calls} shouldQuery=${spaced.shouldQuery}`)

  const optionalCalls = { n: 0, args: [] as string[] }
  const optional = fixturePrompt('optional-only', '[focus]', optionalCalls)
  const optionalBare = await send([optional], '/optional-only', optionalCalls)
  check('an optional-only hint runs bare: the prompt is built with empty arguments and the turn starts', optionalBare.calls === 1 && optionalBare.args[0] === '' && optionalBare.shouldQuery === true, `calls=${optionalBare.calls} shouldQuery=${optionalBare.shouldQuery} ${optionalBare.contents.join(' | ')}`)

  const noneCalls = { n: 0, args: [] as string[] }
  const none = fixturePrompt('takes-nothing', undefined, noneCalls)
  const noneBare = await send([none], '/takes-nothing', noneCalls)
  check('no hint runs bare: the prompt is built and the turn starts', noneBare.calls === 1 && noneBare.shouldQuery === true, `calls=${noneBare.calls} shouldQuery=${noneBare.shouldQuery} ${noneBare.contents.join(' | ')}`)

  const secondCalls = { n: 0, args: [] as string[] }
  const second = fixturePrompt('second-optional', '[interval] <prompt or /slash-command>', secondCalls)
  const secondBare = await send([second], '/second-optional', secondCalls)
  check('the discriminator reads the FIRST token: "[interval] <prompt>" runs bare', secondBare.calls === 1 && secondBare.shouldQuery === true, `calls=${secondBare.calls}`)

  const hiddenCalls = { n: 0, args: [] as string[] }
  const hidden = { ...fixturePrompt('hidden-thing', '<x>', hiddenCalls), userInvocable: false, isHidden: true } as Command
  const hiddenBare = await send([hidden], '/hidden-thing', hiddenCalls)
  check('a hidden (model-only) skill keeps its own answer and builds no prompt', hiddenBare.calls === 0 && hiddenBare.shouldQuery === false && hiddenBare.contents.some(text => text.includes('can only be invoked by the assistant')), hiddenBare.contents.join(' | '))
}

section('§2 THE REAL SKILLS — /debug bare turns nothing on and answers; /simplify bare stays a turn (RED on the base: /debug switched debug logging on and ran)')
{
  initBundledSkills()
  const bundled = getBundledSkills()
  const debug = bundled.find(command => command.name === 'debug')
  const simplify = bundled.find(command => command.name === 'simplify')
  const updateConfig = bundled.find(command => command.name === 'update-config')
  check('the three skills register', debug !== undefined && simplify !== undefined && updateConfig !== undefined)
  check('/debug declares a required hint <issue description>', debug !== undefined && debug.argumentHint === '<issue description>' && requiresArgument(debug), `hint=${debug?.argumentHint}`)
  check('/update-config declares a required hint', updateConfig !== undefined && requiresArgument(updateConfig) && (updateConfig.argumentHint ?? '').startsWith('<the change:'), `hint=${updateConfig?.argumentHint}`)
  check('/simplify declares no hint', simplify !== undefined && simplify.argumentHint === undefined && !requiresArgument(simplify))
  check('debug logging is off before the send', isDebugMode() === false)
  if (debug !== undefined) {
    const live = { ...debug, isEnabled: () => true } as Command
    const result = await processSlashCommand('/debug', [], [], [], makeContext([live]) as never, () => {})
    check('/debug bare answers its usage row and starts no turn', result.shouldQuery === false && result.resultText === bareUsageLine(debug), `shouldQuery=${result.shouldQuery} text=${result.resultText}`)
    check('/debug bare turned debug logging on for nothing (the side effect belongs to the invoked skill)', isDebugMode() === false, 'isDebugMode() is true after a bare /debug')
    console.log(`  the row: ${bareUsageLine(debug)}`)
  }
  if (updateConfig !== undefined) {
    const row = bareUsageLine(updateConfig)
    check('/update-config bare answers a row within the width, ending in the usage with the hint', row.length <= BARE_USAGE_ROW_COLUMNS && row.startsWith('/update-config — Use this skill for any change to Mercury settings files') && row.endsWith(' · usage: /update-config <the change: allow X · set X=Y · enable server Y · whenever X do Y>') && row.includes('…'), row)
    console.log(`  the row: ${row}`)
  }
  if (simplify !== undefined) {
    let calls = 0
    const spied = { ...simplify, isEnabled: () => true, getPromptForCommand: async () => { calls++; return [{ type: 'text', text: 'the simplify pass' }] } } as Command
    const result = await processSlashCommand('/simplify', [], [], [], makeContext([spied]) as never, () => {})
    check('/simplify bare builds its prompt and starts the turn, as today', calls === 1 && result.shouldQuery === true, `calls=${calls} shouldQuery=${result.shouldQuery}`)
  }
}

section('§3 A MENU PICK — Enter on a required-hint command leaves the composer at "/name " and sends nothing (RED on the base: it sent bare)')
{
  const pick = (command: Command): { input: string; submitted: string | undefined; cursor: number } => {
    let input = ''
    let submitted: string | undefined
    let cursor = -1
    applyCommandSuggestion({ id: command.name, displayText: command.name, metadata: command }, true, [command], value => { input = value }, offset => { cursor = offset }, value => { submitted = value })
    return { input, submitted, cursor }
  }
  const needs = fixturePrompt('needs-thing', '<thing to do>', { n: 0, args: [] })
  const picked = pick(needs)
  check('a required-hint prompt command is not sent: the composer reads "/needs-thing " with the cursor at its end', picked.submitted === undefined && picked.input === '/needs-thing ' && picked.cursor === '/needs-thing '.length, JSON.stringify(picked))
  const optional = fixturePrompt('optional-only', '[focus]', { n: 0, args: [] })
  check('an optional-hint prompt command is sent on the pick, as today', pick(optional).submitted === '/optional-only ', JSON.stringify(pick(optional)))
  const none = fixturePrompt('takes-nothing', undefined, { n: 0, args: [] })
  check('a hintless prompt command is sent on the pick, as today', pick(none).submitted === '/takes-nothing ')
  const local = { type: 'local', name: 'usage', description: 'the usage panel', argumentHint: '<x>', load: async () => ({ call: async () => ({ type: 'text', value: '' }) }) } as unknown as Command
  check('a local command with a bracketed hint is still sent on the pick (the law is the prompt kind\'s)', pick(local).submitted === '/usage ')
  const named = { ...fixturePrompt('argnames-skill', undefined, { n: 0, args: [] }), argNames: ['topic'] } as Command
  check('an argNames command keeps today\'s law: not sent', pick(named).submitted === undefined)
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
