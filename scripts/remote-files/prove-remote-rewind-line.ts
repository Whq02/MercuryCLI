#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { removeScratch } from '../lib/removeScratch.ts'
import { underScratchHome } from './remoteKit.ts'

underScratchHome(import.meta.path)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-rewind-line-')))
const project = join(scratch, 'project')
mkdirSync(project, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const reactModule = (await import('react')) as unknown as { default?: typeof import('react') } & typeof import('react')
const React = reactModule.default ?? reactModule
const { default: stripAnsi } = await import('strip-ansi')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
enableConfigs()
setOriginalCwd(project)
setCwdState(project)
const { render } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const selector = await import('../../src/components/MessageSelector.tsx')
const focused = await import('../../src/services/engine-connector/focusedConnector.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')

const watchdog = setTimeout(() => {
  console.log('  [FAIL] the proof did not finish within 180 seconds')
  process.exit(1)
}, 180_000)
watchdog.unref()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const CONFIG = 'ssh://web1/srv/app/config.yml'
const lineOf = (messages: unknown[], from: string): string | null => {
  const read = (selector as { writtenElsewhereLine?: (messages: never, from: string) => string | null }).writtenElsewhereLine
  return read === undefined ? '<the screen has no such line>' : read(messages as never, from)
}
const prompt = (n: number, text: string) => ({ type: 'user', uuid: `00000000-0000-4000-8000-00000000000${n}`, timestamp: `2026-06-19T12:00:0${n}.000Z`, message: { role: 'user', content: text } })
let results = 0
const result = (toolUseResult: unknown) => ({
  type: 'user',
  uuid: `00000000-0000-4000-9000-${String(results).padStart(12, '0')}`,
  timestamp: '2026-06-19T12:00:05.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${results++}`, content: 'ok' }] },
  toolUseResult,
})
const patch = [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-port: 80', '+port: 8080'] }]
const wrote = (filePath: string) => result({ type: 'update', filePath, content: 'port: 8080\n', structuredPatch: patch })
const created = (filePath: string) => result({ type: 'create', filePath, content: 'one\n', structuredPatch: [] })
const edited = (filePath: string) => result({ filePath, oldString: 'a', newString: 'b', structuredPatch: patch })
const p1 = prompt(1, 'change the port on the server')
const p2 = prompt(2, 'and now the next thing')
const local = join(project, 'a.txt')

const facts = { capture: 'on', restorable: new Set([p1.uuid, p2.uuid]) }
const overrides: Record<string, unknown> = {
  checkpointFacts: () => facts,
  subscribeCheckpoints: () => () => {},
  rewind: async () => ({ outcome: 'previewed', code: { filesChanged: [local], insertions: 1, deletions: 1 } }),
}
const resting = noSessionConnector()
focused.setFocusedSessionConnector(
  new Proxy(resting, {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as never,
)

class Keys extends EventEmitter {
  isTTY = true
  isRaw = false
  chunks: string[] = []
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  pause(): this { return this }
  resume(): this { return this }
  read(): string | null { return this.chunks.shift() ?? null }
  get readableLength(): number { return this.chunks.reduce((n, value) => n + value.length, 0) }
  press(value: string): void { this.chunks.push(value); this.emit('readable') }
}
const DOWN = '\u001b[B'

async function page(messages: unknown[], keys: string[] = []): Promise<string[]> {
  const stream = new PassThrough()
  stream.resume()
  Object.assign(stream, { columns: COLUMNS, rows: 40 })
  const stdin = new Keys()
  const screen = React.createElement(selector.MessageSelector as never, { messages, onPreRestore() {}, onRestore: () => new Promise(() => {}), onSummarize() {}, onClose() {}, preselectedMessage: p1 } as never)
  const instance = await render(React.createElement(AppStateProvider as never, null, React.createElement(KeybindingSetup as never, null, screen)), { stdout: stream as never, stdin: stdin as never, patchConsole: false })
  const rows = (): string[] => stripAnsi(instance.lastFrame()).split('\n').map(line => line.trimEnd())
  const settle = async (ready: () => boolean): Promise<void> => {
    for (const until = Date.now() + 5_000; Date.now() < until && !ready(); ) await new Promise(resolve => setTimeout(resolve, 25))
  }
  await settle(() => rows().some(row => row.includes('Restores ')))
  for (const [index, key] of keys.entries()) {
    const before = rows().join('\n')
    stdin.press(key)
    await settle(() => rows().join('\n') !== before)
    if (index === keys.length - 1) await new Promise(resolve => setTimeout(resolve, 60))
  }
  const settled = rows()
  instance.unmount()
  await new Promise(resolve => setTimeout(resolve, 20))
  return settled.map(line => (/ \([^()]* ago\) *│$/.test(line) ? row(line.replace(/^│ /, '').replace(/ \([^()]* ago\) *│$/, ' (<age>)')) : line))
}
const COLUMNS = 110
const row = (text: string): string => `│ ${text.padEnd(COLUMNS - 4)} │`
const words = (frame: string[]): string[] => frame.map(line => line.replace(/^[│\s]+|[│\s]+$/g, '')).filter(text => text !== '' && !/^[╭╮╰╯─]+$/.test(text))

try {
  section('what the screen is told: the files written on another machine after the point being rewound to')
  check('nothing written elsewhere: no line', lineOf([p1, wrote(local), p2], p1.uuid) === null, String(lineOf([p1, wrote(local), p2], p1.uuid)))
  check('one file: it is named as it was written', lineOf([p1, wrote(local), wrote(CONFIG), p2], p1.uuid) === `Stays as written on another machine: ${CONFIG}.`, String(lineOf([p1, wrote(local), wrote(CONFIG), p2], p1.uuid)))
  const two = [p1, wrote(CONFIG), created('ssh://web1/srv/app/new.txt'), p2]
  check('two files: both', lineOf(two, p1.uuid) === `Stays as written on another machine: ${CONFIG} and ssh://web1/srv/app/new.txt.`, String(lineOf(two, p1.uuid)))
  const five = [p1, wrote(CONFIG), created('ssh://web1/a'), edited('ssh://db1/b'), wrote('ssh://web1/c'), wrote('ssh://web1/d'), p2]
  check('five files: two and the count of the rest', lineOf(five, p1.uuid) === `Stays as written on another machine: ${CONFIG}, ssh://web1/a and 3 more.`, String(lineOf(five, p1.uuid)))
  check('a file written twice is named once', lineOf([p1, wrote(CONFIG), edited(CONFIG), p2], p1.uuid) === `Stays as written on another machine: ${CONFIG}.`, String(lineOf([p1, wrote(CONFIG), edited(CONFIG), p2], p1.uuid)))
  check('a file written before the point is not in the span', lineOf([p1, wrote(CONFIG), p2, wrote(local)], p2.uuid) === null, String(lineOf([p1, wrote(CONFIG), p2, wrote(local)], p2.uuid)))
  check('a write that changed nothing is not named', lineOf([p1, result({ type: 'no-change', filePath: CONFIG, content: 'port: 8080\n', structuredPatch: [] }), result({ filePath: CONFIG, oldString: 'a', newString: 'a', structuredPatch: [], noChange: { streak: 1 } }), p2], p1.uuid) === null, String(lineOf([p1, result({ type: 'no-change', filePath: CONFIG, structuredPatch: [] }), p2], p1.uuid)))
  check('a call that failed wrote nothing and is not named', lineOf([p1, result(`Error: Editing ${CONFIG} is denied`), p2], p1.uuid) === null, String(lineOf([p1, result(`Error: Editing ${CONFIG} is denied`), p2], p1.uuid)))
  check('a local path under a folder named ssh: with one slash is a local file', lineOf([p1, wrote('ssh:/web1/srv/config.yml'), p2], p1.uuid) === null, String(lineOf([p1, wrote('ssh:/web1/srv/config.yml'), p2], p1.uuid)))

  section('the rewind screen, a point with saved files')
  const HERE = [
    `╭${'─'.repeat(COLUMNS - 2)}╮`,
    row('change the port on the server (<age>)'),
    row(''),
    row('❯ 1. Restore code and conversation'),
    row('  2. Restore conversation only'),
    row('  3. Restore code only'),
    row('  4. Summarise from here…'),
    row('  5. Never mind'),
    row(''),
    row('The files go back to their saved state at this point; the conversation winds back to before this point —'),
    row('later messages leave the model\'s view (the transcript keeps them).'),
    row('Restores a.txt +1 -1.'),
    row(''),
    row('A file edited by hand since the session last touched it is refused by name — nothing is restored until you'),
    row('resolve it.'),
    `╰${'─'.repeat(COLUMNS - 2)}╯`,
  ]
  const plain = await page([p1, wrote(local), p2])
  check('with nothing written elsewhere the page is, cell for cell, the page it was', JSON.stringify(plain) === JSON.stringify(HERE), JSON.stringify(plain))
  const far = await page([p1, wrote(local), wrote(CONFIG), p2])
  const LINE = `Stays as written on another machine: ${CONFIG}.`
  check('with a file written on another machine the page says it stays, under what a restore brings back', far.indexOf(row(LINE)) === far.indexOf(row('Restores a.txt +1 -1.')) + 1 && far.indexOf(row(LINE)) > 0, JSON.stringify(far))
  check('and that row is the only cell that differs', JSON.stringify(far.filter(line => line !== row(LINE))) === JSON.stringify(plain), JSON.stringify(far))
  const conversation = words(await page([p1, wrote(local), wrote(CONFIG), p2], [DOWN]))
  check('on "Restore conversation only" no file moves, and the line is not shown', conversation.includes('❯ 2. Restore conversation only') && !conversation.some(row => row.includes('another machine')) && conversation.includes('The files are unchanged.'), JSON.stringify(conversation))
  const code = words(await page([p1, wrote(local), wrote(CONFIG), p2], [DOWN, DOWN]))
  check('on "Restore code only" it is shown again', code.includes('❯ 3. Restore code only') && code.includes(LINE), JSON.stringify(code))
} finally {
  process.chdir(tmpdir())
  removeScratch(scratch)
}

console.log(`\nremote rewind line: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
