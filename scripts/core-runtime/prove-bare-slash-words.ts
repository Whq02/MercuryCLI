#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Message, UserMessage } from '../../src/types/message.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-bare-slash-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const cwd = join(scratch, 'project')
mkdirSync(cwd)
process.chdir(cwd)

let failures = 0
let checks = 0
function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const HELP_SENTENCE = 'Commands are in the form'
const CAVEAT_TAG = '<local-command-caveat>'

try {
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { setOriginalCwd, setCwdState } = await import('../../src/bootstrap/state.ts')
  setOriginalCwd(cwd)
  setCwdState(cwd)
  const { processUserInput } = await import('../../src/utils/processUserInput/processUserInput.ts')
  const { builtinCommands, sessionSeatCommandTable } = await import('../../src/commands.ts')
  const table = sessionSeatCommandTable([...builtinCommands()])
  const appState: Record<string, unknown> = {
    toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
    sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, todos: {},
  }
  const setAppState = (f: (prev: Record<string, unknown>) => Record<string, unknown>): void => { Object.assign(appState, f(appState)) }
  const context = () => ({
    options: { commands: table, tools: [], mcpClients: [], isNonInteractiveSession: true },
    getAppState: () => appState, setAppState, messages: [],
    abortController: new AbortController(), readFileState: new Map(), setToolJSX: () => {},
  })
  const run = (input: string, uuid: string, pastedContents?: Record<number, unknown>) => processUserInput({
    input, mode: 'prompt', setToolJSX: () => {}, context: context() as never,
    messages: [], querySource: 'sdk', uuid,
    ...(pastedContents !== undefined ? { pastedContents: pastedContents as never } : {}),
  })
  const users = (rows: Message[]): UserMessage[] => rows.filter((row): row is UserMessage => row.type === 'user')
  const textOf = (row: UserMessage): string => typeof row.message.content === 'string' ? row.message.content : JSON.stringify(row.message.content)
  const carriesWords = (rows: Message[], needle: string): boolean => rows.some(row => JSON.stringify(row).includes(needle))

  section('S1 a bare slash is the operator\'s words')
  {
    const uuid = randomUUID()
    const result = await run('/', uuid)
    const rows = users(result.messages)
    check('one user row, the frame uuid, the words typed', rows.length === 1 && rows[0]!.uuid === uuid && textOf(rows[0]!) === '/', JSON.stringify(rows.map(r => [r.uuid === uuid, textOf(r)])))
    check('the line queries the model (a message, not a command answer)', result.shouldQuery === true && result.commandRefused === undefined && result.resultText === undefined, JSON.stringify({ shouldQuery: result.shouldQuery, refused: result.commandRefused, resultText: result.resultText }))
    check('no caveat row and no help sentence minted', !carriesWords(result.messages, CAVEAT_TAG) && !carriesWords(result.messages, HELP_SENTENCE))
    check('the row is the operator\'s (not meta, not virtual)', rows[0]!.isMeta !== true && (rows[0] as { isVirtual?: boolean }).isVirtual !== true)
  }

  section('S2 a slash, a space, then words — the same road')
  {
    const uuid = randomUUID()
    const result = await run('/ compact', uuid)
    const rows = users(result.messages)
    check('one user row carrying `/ compact` under the frame uuid', rows.length === 1 && rows[0]!.uuid === uuid && textOf(rows[0]!) === '/ compact', JSON.stringify(rows.map(r => textOf(r))))
    check('queries the model; nothing minted', result.shouldQuery === true && !carriesWords(result.messages, CAVEAT_TAG) && !carriesWords(result.messages, HELP_SENTENCE))
  }

  section('S3 images sent with a bare slash ride the row')
  {
    const uuid = randomUUID()
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex').toString('base64')
    const result = await run('/', uuid, { 12: { id: 12, type: 'image', content: png, mediaType: 'image/png' } })
    const rows = users(result.messages)
    const prompt = rows.find(r => r.uuid === uuid)
    const blocks = prompt !== undefined && Array.isArray(prompt.message.content) ? prompt.message.content : []
    check('the row carries the words and the image block', blocks.some(b => b.type === 'text' && (b as { text: string }).text === '/') && blocks.some(b => b.type === 'image'), JSON.stringify(blocks.map(b => b.type)))
    check('the row carries the composer\'s image number', JSON.stringify((prompt as { imagePasteIds?: number[] } | undefined)?.imagePasteIds) === '[12]', JSON.stringify((prompt as { imagePasteIds?: number[] } | undefined)?.imagePasteIds))
    check('queries the model; nothing minted', result.shouldQuery === true && !carriesWords(result.messages, HELP_SENTENCE))
  }

  section('S4 a parseable command still takes the command road')
  {
    const uuid = randomUUID()
    const result = await run('/no-such-command-here', uuid)
    check('an unknown command name answers its one notice, never a model turn', result.shouldQuery === false && result.commandRefused === true && result.messages.length === 1 && result.messages[0]!.type === 'system' && result.messages[0]!.uuid === uuid, JSON.stringify(result.messages.map(m => [m.type, m.uuid === uuid])))
    const echoUuid = randomUUID()
    const echoed = await run('/compact', echoUuid)
    const first = users(echoed.messages)
    check('a real command\'s rows open with the caveat and the echo carries the frame uuid', echoed.shouldQuery === false && first.length >= 2 && textOf(first[0]!).startsWith(CAVEAT_TAG) && first[1]!.uuid === echoUuid && textOf(first[1]!).includes('<command-name>/compact</command-name>'), JSON.stringify(first.slice(0, 2).map(r => [r.uuid === echoUuid, textOf(r).slice(0, 60)])))
  }

  section('S5 the help sentence has no reader left')
  {
    const root = join(new URL('.', import.meta.url).pathname, '..', '..')
    const slash = readFileSync(join(root, 'src/utils/processUserInput/processSlashCommand.tsx'), 'utf8')
    check('processSlashCommand no longer mints the sentence', !slash.includes(HELP_SENTENCE))
    const input = readFileSync(join(root, 'src/utils/processUserInput/processUserInput.ts'), 'utf8')
    check('the slash road is taken only by a line that parses as a command', input.includes("syntaxPrompt.startsWith('/') && parseSlashCommand(syntaxPrompt) !== null"))
  }
} finally {
  process.chdir('/')
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? `\n✅ BARE SLASH IS WORDS — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
