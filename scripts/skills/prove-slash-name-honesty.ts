#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'name-honesty-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_SAMPLES
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
  console.log('\nTIMEOUT — the slash-name honesty proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { initBundledSkills } = await import('../../src/skills/bundled/index.ts')
const { getBundledSkills } = await import('../../src/skills/bundledSkills.ts')
const { builtinCommands, isCommandEnabled } = await import('../../src/commands.ts')
const { SAMPLES_OFF_SENTENCE } = await import('../../src/commands/samples/index.ts')
const { RETIRED_MULTIPLAYER_REASON } = await import('../../src/commands/retired.ts')
const { processSlashCommand, resolveUnknownSlashName, unavailableCommandLine, unknownCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
type Command = import('../../src/types/command.ts').Command

initBundledSkills()
const roster: Command[] = [...getBundledSkills(), ...builtinCommands()].filter(command => isCommandEnabled(command))
const samplesCommand = builtinCommands().find(command => command.name === 'samples')
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
  agentId: 'name-honesty-agent',
})

section('§1 A KNOWN NAME GATED OFF — /samples off answers its own sentence on the screen line and in the dispatcher (RED on the base: "Unknown command: /samples — closest: /update-config")')
{
  check('samples is registered and off without its flag', samplesCommand !== undefined && samplesCommand.type === 'local-jsx' && !isCommandEnabled(samplesCommand))
  check('the enabled roster carries no /samples, so the screen resolves the typed name as unknown', !roster.some(command => command.name === 'samples') && resolveUnknownSlashName('/samples', roster) === 'samples')
  const line = unknownCommandLine('samples', roster)
  check('the screen line for /samples is the off sentence, never "Unknown command"', line === SAMPLES_OFF_SENTENCE && !line.startsWith('Unknown command'), line)
  check('the off sentence names the flag and the Boot Menu row', SAMPLES_OFF_SENTENCE === "/samples is off — MERCURY_SAMPLES=1 turns it on (the Boot Menu's Samples row saves it for new sessions)")
  if (samplesCommand !== undefined) {
    check('unavailableCommandLine answers the same sentence for the registered command', unavailableCommandLine(samplesCommand) === SAMPLES_OFF_SENTENCE, unavailableCommandLine(samplesCommand))
  }
  const sent = await processSlashCommand('/samples', [], [], [], makeContext(roster) as never, () => {})
  check('the dispatcher answers the off sentence as a refusal with no turn', sent.shouldQuery === false && sent.resultText === SAMPLES_OFF_SENTENCE && (sent as { commandRefused?: boolean }).commandRefused === true, `shouldQuery=${sent.shouldQuery} text=${sent.resultText}`)
  console.log(`  the row: ${line}`)

  if (samplesCommand !== undefined) {
    let opened = 0
    const enabled = {
      ...samplesCommand,
      isEnabled: () => true,
      load: async () => ({
        call: async (done: (text: string, options?: { display?: 'system' }) => void) => {
          opened++
          done('the samples panel', { display: 'system' })
          return null
        },
      }),
    } as unknown as Command
    const withSamples = [enabled, ...roster]
    check('with samples enabled the screen never resolves the name as unknown', resolveUnknownSlashName('/samples', withSamples) === undefined)
    const ran = await processSlashCommand('/samples', [], [], [], makeContext(withSamples) as never, () => {})
    check('…and the dispatcher runs the command itself', opened === 1 && ran.shouldQuery === false && ran.resultText === 'the samples panel' && (ran as { commandRefused?: boolean }).commandRefused !== true, `opened=${opened} text=${ran.resultText}`)
  }
}

section('§2 A RETIRED NAME AND A REAL UNKNOWN — /say answers its retired line on the screen; /frobnicate keeps "Unknown command"')
{
  const say = unknownCommandLine('say', roster)
  check('a retired door typed on the screen answers its retired sentence (RED on the base: "Unknown command: /say")', say === `The /say command is retired — ${RETIRED_MULTIPLAYER_REASON}.`, say)
  const frob = unknownCommandLine('frobnicate', roster)
  check('a name nothing registers keeps the screen\'s own sentence', frob.startsWith('Unknown command: /frobnicate') && frob.endsWith('· /help lists commands'), frob)
  check('a registered, enabled name never resolves as unknown', resolveUnknownSlashName('/model', roster) === undefined && resolveUnknownSlashName('/help', roster) === undefined)
}

section('§3 THE "CLOSEST" POINTER — a name of the same kind, matched by name alone; never a skill (RED on the base: /theme pointed at /update-config through a description word)')
{
  const closestOf = (line: string): string | undefined => /— closest: \/([^ ]+) ·/.exec(line)?.[1]
  const theme = unknownCommandLine('theme', roster)
  const themeNear = closestOf(theme)
  const kindOf = (name: string | undefined): string | undefined => roster.find(command => command.name === name || command.aliases?.includes(name ?? '') === true)?.type
  check('an unknown name whose only near match is a skill description word gets no skill: /theme never points at /update-config', theme.startsWith('Unknown command: /theme') && themeNear !== 'update-config' && (themeNear === undefined || kindOf(themeNear) !== 'prompt'), theme)
  const usge = unknownCommandLine('usge', roster)
  check('a typo of a local command points at it: /usge → /usage', closestOf(usge) === 'usage', usge)
  const prompts = roster.filter(command => command.type === 'prompt' && command.isHidden !== true)
  const offered = new Set<string>()
  for (const command of prompts) {
    const typo = `${command.name.slice(0, -1)}x`
    const line = unknownCommandLine(typo, roster)
    const near = closestOf(line)
    if (near !== undefined && kindOf(near) === 'prompt') offered.add(`${typo}→${near}`)
  }
  check(`a typo of any of the ${prompts.length} skill names is never answered with a skill`, offered.size === 0, [...offered].join(' '))
  const local = { type: 'local', name: 'usage', description: 'Usage', load: async () => ({ call: async () => ({ type: 'text', value: '' }) }) } as unknown as Command
  const skill = { type: 'prompt', name: 'samplify', description: 'a skill named like the typo', progressMessage: 'running', contentLength: 0, source: 'bundled', getPromptForCommand: async () => [] } as unknown as Command
  const synthetic = unknownCommandLine('samplifx', [skill, local])
  check('the nearest name being a skill offers nothing rather than the skill', closestOf(synthetic) !== 'samplify', synthetic)
  const frob = unknownCommandLine('frobnicate', roster)
  check('a name near nothing carries no pointer', closestOf(frob) === undefined, frob)
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
