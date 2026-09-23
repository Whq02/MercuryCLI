#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'bare-census-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'bare-census-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_BARE
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const skill = (description: string, hint?: string, body = 'the fixture skill body'): string =>
  `---\ndescription: ${description}\n${hint === undefined ? '' : `argument-hint: "${hint}"\n`}---\n${body}\n`
const skillsDir = join(PROJ, '.mercury', 'skills')
for (const [name, text] of [
  ['needs-thing', skill('a fixture skill whose prompt reads its argument', '<thing to do> [how]')],
  ['takes-nothing', skill('a fixture skill that reads no argument')],
  ['optional-only', skill('a fixture skill with an optional argument', '[focus]')],
] as const) {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(join(skillsDir, name, 'SKILL.md'), text)
}
process.chdir(PROJ)

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the bare-send census exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { initBundledSkills } = await import('../../src/skills/bundled/index.ts')
const { getBundledSkills } = await import('../../src/skills/bundledSkills.ts')
const { builtinCommands, getCommands, isCommandEnabled, getCommandName } = await import('../../src/commands.ts')
const { argumentHintOf, bareSendKindOf, bareUsageLine, requiresArgument } = await import('../../src/skills/argumentHint.ts')
const { processSlashCommand } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { parseFrontmatter } = await import('../../src/utils/frontmatterParser.ts')
type Command = import('../../src/types/command.ts').Command

const SOURCE_ROOT = join(ROOT, 'mercury-skills')
const generatedFrontmatter = new Map<string, { description?: string; argumentHint?: string }>()
const asBuilt = (command: Command): Command => {
  if (command.loadedFrom !== 'bundled') return command
  const skillMd = join(SOURCE_ROOT, command.name, 'SKILL.md')
  if (!existsSync(skillMd)) return command
  const { frontmatter } = parseFrontmatter(readFileSync(skillMd, 'utf8'))
  const description = typeof frontmatter.description === 'string' && frontmatter.description.trim() !== '' ? frontmatter.description : undefined
  const argumentHint = typeof frontmatter['argument-hint'] === 'string' && frontmatter['argument-hint'].trim() !== '' ? frontmatter['argument-hint'] : undefined
  generatedFrontmatter.set(command.name, { description, argumentHint })
  return { ...command, ...(description !== undefined ? { description } : {}), ...(argumentHint !== undefined ? { argumentHint } : {}) } as Command
}

initBundledSkills()
const bundled = getBundledSkills().map(asBuilt)
const disk = (await getCommands(PROJ)).filter(command => command.loadedFrom !== 'bundled' && command.source !== 'builtin' && ['needs-thing', 'takes-nothing', 'optional-only'].includes(command.name))
const builtins = [...builtinCommands()]
const seen = new Set<string>()
const roster: Command[] = []
for (const command of [...bundled, ...disk, ...builtins]) {
  if (seen.has(command.name)) continue
  seen.add(command.name)
  roster.push(command)
}

section('§1 THE CENSUS — every slash name the roster can carry, by what a bare send does (name · kind · source · hint · bare send · enabled · hidden)')
{
  const kinds = new Set(roster.map(command => command.type))
  check('the roster carries the three kinds and no other', [...kinds].every(kind => kind === 'local' || kind === 'local-jsx' || kind === 'prompt'), [...kinds].join(','))
  check('the eighteen bundled skills register', bundled.length === 18, `bundled=${bundled.length}: ${bundled.map(command => command.name).join(' ')}`)
  console.log(`  ${generatedFrontmatter.size} generated skills read their description and hint from mercury-skills/<name>/SKILL.md here, as the build inlines them (a .md import is not text under bun): ${[...generatedFrontmatter.keys()].join(' ')}`)
  check('the eleven generated skills are the ones with a SKILL.md source', generatedFrontmatter.size === 11 && [...generatedFrontmatter.entries()].every(([name, fields]) => fields.description !== undefined && (fields.argumentHint !== undefined || name === 'extension-maker')), [...generatedFrontmatter.entries()].map(([name, fields]) => `${name}:${fields.argumentHint ?? 'none'}`).join(' '))
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  if (existsSync(dist)) {
    const built = readFileSync(dist, 'utf8')
    const missing = [...generatedFrontmatter.entries()].filter(([, fields]) => fields.argumentHint !== undefined && !built.includes(fields.argumentHint)).map(([name]) => name)
    check('the built bundle carries every generated skill\'s argument hint verbatim', missing.length === 0, missing.join(' '))
  } else {
    console.log('  no dist/mercury.mjs beside this tree: the built bundle\'s inlined hints are read at the fold')
  }
  check('the three fixture disk skills load', disk.length === 3, disk.map(command => command.name).join(' '))
  const width = Math.max(...roster.map(command => getCommandName(command).length))
  const bareWords: Record<string, string> = {
    local: 'answers, no turn',
    'local-jsx': 'opens, no turn',
    usage: 'answers its usage, no turn',
    turn: 'a turn',
  }
  const rows = roster.map(command => {
    const hint = argumentHintOf(command)
    const kind = bareSendKindOf(command)
    const source = command.loadedFrom === 'bundled' ? 'bundled' : command.source === 'builtin' || command.source === undefined ? 'built-in' : String(command.source)
    const hidden = command.isHidden === true || command.userInvocable === false
    return `  /${getCommandName(command).padEnd(width)}  ${command.type.padEnd(9)}  ${source.padEnd(8)}  ${(hint ?? '—').padEnd(44).slice(0, 44)}  ${bareWords[kind].padEnd(26)}  ${isCommandEnabled(command) ? 'on ' : 'off'}  ${hidden ? 'hidden' : ''}`
  })
  console.log(rows.join('\n'))
  const usageCount = roster.filter(command => bareSendKindOf(command) === 'usage').length
  const turnCount = roster.filter(command => bareSendKindOf(command) === 'turn').length
  console.log(`\n  ${roster.length} names: ${roster.filter(c => c.type === 'local').length} local · ${roster.filter(c => c.type === 'local-jsx').length} local-jsx · ${usageCount} prompt answering usage bare · ${turnCount} prompt running bare`)
  check('no built-in prompt command declares a required hint (the rule changes no built-in verb)', builtins.every(command => command.type !== 'prompt' || !requiresArgument(command)), builtins.filter(command => command.type === 'prompt' && requiresArgument(command)).map(command => command.name).join(' '))
}

section('§2 THE LAW OF THE HINT — a required first token <…> answers bare; no hint or [optional] runs bare')
{
  const byName = new Map(roster.map(command => [command.name, command]))
  const expectRequired = ['update-config', 'debug', 'aesthetic-direction', 'app-proof', 'drafting-partner', 'mcp-smithy', 'pdf-documents', 'skill-forge', 'slide-decks', 'spreadsheets', 'word-documents', 'needs-thing']
  const expectBare = ['simplify', 'schedule', 'skillify', 'provider-apis', 'loop', 'extension-maker', 'takes-nothing', 'optional-only', 'verify', 'review', 'init', 'insights']
  for (const name of expectRequired) {
    const command = byName.get(name)
    check(`/${name} declares a required argument (RED on the base for update-config and debug: no hint / [issue description])`, command !== undefined && requiresArgument(command), `hint=${command === undefined ? 'absent' : argumentHintOf(command) ?? 'none'}`)
  }
  for (const name of expectBare) {
    const command = byName.get(name)
    check(`/${name} runs bare (no hint or an optional one)`, command !== undefined && command.type === 'prompt' && !requiresArgument(command), `hint=${command === undefined ? 'absent' : argumentHintOf(command) ?? 'none'}`)
  }
  check('the discriminator reads the first token only: "[interval] <prompt>" runs bare, "<x> [y]" answers', !requiresArgument({ type: 'prompt', argumentHint: '[interval] <prompt or /slash-command>' }) && requiresArgument({ type: 'prompt', argumentHint: '<x> [y]' }) && !requiresArgument({ type: 'local', argumentHint: '<path>' }))
  const updateConfig = byName.get('update-config')
  check('/keybindings is the built-in local command (a bare send opens the bindings file, no turn) and keybindings-help is the hidden skill', byName.get('keybindings')?.type === 'local' && byName.get('keybindings-help')?.type === 'prompt' && byName.get('keybindings-help')?.userInvocable === false)
  check('the usage row of /update-config fits its width and carries the description and the hint', updateConfig !== undefined && bareUsageLine(updateConfig).length <= 178 && bareUsageLine(updateConfig).startsWith('/update-config — ') && bareUsageLine(updateConfig).includes(' · usage: /update-config <'), updateConfig === undefined ? 'absent' : bareUsageLine(updateConfig))
}

section('§3 THE DISPATCHER — a bare send of every user-invocable prompt command (RED on the base: every <required> skill starts a turn today)')
{
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
    agentId: 'bare-census-agent',
  })
  const send = async (command: Command, input: string): Promise<{ calls: number; shouldQuery: boolean; resultText: string | undefined; rows: number; error: string }> => {
    let calls = 0
    const spied = {
      ...command,
      isEnabled: () => true,
      getPromptForCommand: async (args: string) => {
        calls++
        return [{ type: 'text', text: `fixture expansion for ${command.name} (${args})` }]
      },
    } as Command
    try {
      const result = await processSlashCommand(input, [], [], [], makeContext([spied]) as never, () => {})
      const stderr = result.messages
        .map(message => (message.type === 'user' && typeof message.message.content === 'string' ? message.message.content : ''))
        .find(text => text.includes('<local-command-stderr>'))
      return { calls, shouldQuery: result.shouldQuery, resultText: result.resultText, rows: result.messages.length, error: stderr ?? '' }
    } catch (error) {
      return { calls, shouldQuery: false, resultText: undefined, rows: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const prompts = roster.filter(command => command.type === 'prompt' && command.userInvocable !== false)
  let usage = 0
  let turns = 0
  for (const command of prompts) {
    const name = getCommandName(command)
    const bare = await send(command, `/${name}`)
    if (requiresArgument(command)) {
      usage++
      check(`/${name} bare answers its usage row and builds no prompt`, bare.error === '' && bare.calls === 0 && bare.shouldQuery === false && bare.resultText === bareUsageLine(command), `calls=${bare.calls} shouldQuery=${bare.shouldQuery} rows=${bare.rows} text=${bare.resultText ?? bare.error}`)
      const withArgument = await send(command, `/${name} the argument`)
      check(`/${name} with an argument builds its prompt`, withArgument.error === '' && withArgument.calls === 1 && withArgument.shouldQuery === true, `calls=${withArgument.calls} shouldQuery=${withArgument.shouldQuery} ${withArgument.error}`)
    } else {
      turns++
      check(`/${name} bare builds its prompt (a turn, as today)`, bare.error === '' && bare.calls === 1 && bare.shouldQuery === true, `calls=${bare.calls} shouldQuery=${bare.shouldQuery} ${bare.error}`)
    }
  }
  console.log(`\n  ${prompts.length} user-invocable prompt commands: ${usage} answer bare, ${turns} run bare`)
  check('the dispatcher was exercised over the whole prompt roster', prompts.length >= 20 && usage >= 12 && turns >= 8, `prompts=${prompts.length} usage=${usage} turns=${turns}`)
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
