#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(argument('--root') ?? join(import.meta.dir, '../..'))
const scratch = mkdtempSync(join(tmpdir(), 'crew-view-named-resume-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) process.env[k] = '0'
delete process.env.MERCURY_CREW
delete process.env.MERCURY_TEAMS_DIR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const SEAT = 'mate'
const MODEL = 'claude-fable-5-1'

async function main(): Promise<void> {
  const src = (relative: string): string => join(ROOT, 'src', relative)
  const { enableConfigs } = await import(src('utils/config.ts'))
  enableConfigs()
  const cs = await import(src('daemon/crewSpawn.ts'))
  const telemetry = await import(src('state/telemetryBus.ts'))
  const { noSessionConnector } = await import(src('services/engine-connector/noSessionConnector.ts'))
  const slot = await import(src('services/engine-connector/focusedConnector.ts'))
  const { CrewView } = await import(src('components/mercury-ui/screens/CrewView.tsx'))
  const ink = await import(src('ink.ts'))
  const { default: StdinContext } = await import(src('ink/components/StdinContext.ts'))
  const { AppStoreContext } = await import(src('state/AppState.tsx'))
  const { createStore } = await import(src('state/store.ts'))
  const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
  const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default

  await cs.ensureCrewTeamMember(SEAT, MODEL, scratch)
  const settle = async (ms = 5): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      ink.flushPendingSyncWork()
      await new Promise<void>(resolveTick => setTimeout(resolveTick, ms))
    }
  }
  const roster = { rows: [], mission: [], samples: [], reported: true }
  const records: never[] = []
  const seat = Object.assign(Object.create(noSessionConnector()), {
    carrier: 'daemon',
    sessionId: () => 'fx-session',
    records: () => records,
    subscribeRecords: () => () => {},
    workRoster: () => roster,
    subscribeWork: () => () => {},
    identity: () => ({ firstPartyApi: true, consoleBilling: false, claudeAiBilling: true, accountEmail: null }),
    spawnSwitches: () => ({ subagents: { on: true, source: 'default' }, workflows: { on: true, source: 'default' } }),
  })
  slot.setFocusedSessionConnector(seat as never)

  async function mount(columns: number, rows: number) {
    const emitter = new ink.EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const store = createStore(getDefaultAppState())
    const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(AppStoreContext.Provider, { value: store }, React.createElement(CrewView, { onClose: () => {} })))
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolvePaint => { painted = resolvePaint })
    const instance = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    await settle()
    return {
      frame: (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
      async key(name: string): Promise<void> {
        const event = new ink.InputEvent({ name, sequence: name, ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: false } as never)
        emitter.emit('input', event)
        await settle()
      },
      close(): void {
        instance.unmount()
        instance.cleanup()
        stream.destroy()
      },
    }
  }

  section('r on the offline named row: the resume road, its words')
  process.argv[1] = ''
  const board = await mount(178, 51)
  telemetry.pokeTelemetry()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !(telemetry.getTelemetry().crew ?? []).some(m => m.name === SEAT)) await settle(50)
  const glance = telemetry.getTelemetry().crew ?? []
  check('the crew glance names the seat, offline, on its recorded model (no daemon answers)', glance.some(m => m.name === SEAT && !m.online && m.model === MODEL), JSON.stringify(glance))
  await settle(50)
  const before = board.frame()
  check('the view paints the named row offline', before.includes(`@${SEAT}`) && before.includes('offline'), before.slice(0, 400))
  check('the footer offers r resume on the offline named row', before.includes('r resume'), before.split('\n').slice(-4).join(' | '))
  await board.key('r')
  const pressed = board.frame()
  check("the press says it is resuming the seat from its transcript", pressed.includes(`resuming @${SEAT} from its transcript`), pressed.split('\n').filter(l => l.includes('·')).slice(-3).join(' | '))
  const settledAt = Date.now() + 12_000
  let after = pressed
  while (Date.now() < settledAt && !/was refused|resumed from its transcript/.test(after)) {
    await settle(50)
    after = board.frame()
  }
  check("with no daemon to reach, the road answers the refusal in the crew view's own words (the key reached the spawn road)", /the resume of @mate was refused:/.test(after), after.split('\n').filter(l => l.includes('·')).slice(-3).join(' | '))
  board.close()
  slot._resetFocusedSessionConnectorForTesting()

  section('the words: one owner in the crew client')
  const client = await import(src('utils/crew/crewClient.ts'))
  check('a seat with no recorded model is refused, never handed a default', typeof client.resumeCrewTeammate === 'function' && (await client.resumeCrewTeammate(SEAT, undefined, scratch)).error === client.crewResumeNoModelWords(SEAT))
  rmSync(scratch, { recursive: true, force: true })
}

await main()
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-crew-view-named-resume: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
