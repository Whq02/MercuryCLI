#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const SCRATCH = mkdtempSync(join(tmpdir(), 'cmd-privacy-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_TASTE_LOOP = '1'

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { builtinCommands, commandSeat, sessionSeatCommandTable } = await import('../../src/commands.js')
const { processUserInput } = await import('../../src/utils/processUserInput/processUserInput.js')
const { setOriginalCwd } = await import('../../src/bootstrap/state.js')
const cwd = join(SCRATCH, 'project')
mkdirSync(cwd)
setOriginalCwd(cwd)

console.log('the command-privacy law: screen-seat commands never enter a model turn')
const all = [...builtinCommands()]
const byName = (name: string) => all.find(command => command.name === name)
const privateNames = ['remember', 'good', 'meh'] as const
for (const name of [...privateNames, 'halt', 'crew']) {
  const command = byName(name)
  check(`/${name} is registered and SCREEN-seat`, command !== undefined && commandSeat(command) === 'screen')
}
check('the private set carries the userPrivate mark', privateNames.every(name => (byName(name) as { userPrivate?: boolean } | undefined)?.userPrivate === true))
check('/halt is stop-class (interruptFirst)', (byName('halt') as { interruptFirst?: boolean } | undefined)?.interruptFirst === true)
const runnerTable = sessionSeatCommandTable(all)
check('the runner table excludes every private and screen-estate command', [...privateNames, 'halt', 'crew'].every(name => !runnerTable.some(command => command.name === name)))
check('ordinary session locals keep their seat', ['compact', 'cost'].every(name => {
  const command = byName(name)
  return command !== undefined && commandSeat(command) === 'session'
}))
const context = {
  options: { commands: runnerTable, tools: [], mcpClients: [], isNonInteractiveSession: true },
  getAppState: () => ({ toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} } }),
  setAppState: () => {},
  abortController: new AbortController(),
  readFileState: {},
  setToolJSX: () => {},
}
const dispatch = (input: string) => processUserInput({ input, mode: 'prompt', setToolJSX: () => {}, context: context as never, messages: [], querySource: 'sdk' })
try {
  const lesson = 'Pin the fixture home before loading modules that cache project paths.'
  const result = await dispatch(`/remember ${lesson}`)
  check('a stray private command creates zero conversation rows', result.messages.length === 0, String(result.messages.length))
  check('no query starts', result.shouldQuery === false)
  check('the receipt rides resultText alone', /Banked/.test(result.resultText ?? ''), result.resultText ?? '(none)')
  const { getAutoMemPath } = await import('../../src/memdir/paths.js')
  const memory = getAutoMemPath()
  const cards = readdirSync(memory).filter(name => name.endsWith('.md') && name !== 'MEMORY.md').map(name => readFileSync(join(memory, name), 'utf8'))
  check('the private command executed: its candidate card holds the lesson', cards.some(card => card.includes(lesson) && card.includes('approved: false')))
  const halt = await dispatch('/halt')
  check('a stray /halt refuses before its body loads', /interactive surface|foreground session/.test(halt.resultText ?? ''), halt.resultText ?? '(none)')
  check('no query or hard-stop receipt exists at the runner', halt.shouldQuery === false && !/Hard stop/.test(JSON.stringify(halt.messages)))
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? 'prove-command-privacy: ALL LAWS HOLD' : `prove-command-privacy: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
