#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const FIXTURE = join(import.meta.dir, 'voice-transcriber-fixture-server.ts')
const COMPOSER = join(ROOT, 'src', 'components', 'PromptInput', 'PromptInput.tsx')
const COMPOSER_MODULES = ['useComposerRawKeys.ts', 'useComposerDraft.ts'].map(name => join(ROOT, 'src', 'components', 'PromptInput', name))
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'hold-to-talk-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })

process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.NODE_ENV = 'test'
for (const key of [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_VOICE_BACKEND',
  'MERCURY_VOICE_FIXTURE_WAV',
  'MERCURY_VOICE_DEBUG_WAV_DIR',
  'MERCURY_VOICE_PACK_DIR',
  'MERCURY_WHISPER_PACK_DIR',
  'MERCURY_WHISPER_MODEL',
  'MERCURY_VOICE_TRANSCRIBER',
  'MERCURY_VOICE_BOUND_MS',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_HOME',
]) {
  delete process.env[key]
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(10)
  }
  return cond()
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.js')
const wav = await import('../../src/services/voice/wav.js')
const session = await import('../../src/services/voice/voiceSession.js')
const pendingInput = await import('../../src/input-core/pending-input.js')
type HoldModule = typeof import('../../src/services/voice/holdToTalk.js')
let hold: HoldModule | null = null
try {
  hold = await import('../../src/services/voice/holdToTalk.js')
} catch {
  hold = null
}
type Key = import('../../src/ink/events/input-event.js').Key

const TONE = join(SCRATCH, 'tone.wav')
writeFileSync(TONE, wav.synthesizeToneWav({ seconds: 1, hz: 440 }))
const EMPTY_BIN = join(SCRATCH, 'empty-bin')
mkdirSync(EMPTY_BIN, { recursive: true })
const TRANSCRIPT = 'world'

interface Fixture {
  child: ChildProcess
  port: number
  posts: () => number
  stop: () => void
}
async function startFixture(): Promise<Fixture> {
  const ledger = join(SCRATCH, 'ledger.log')
  const child = spawn(process.execPath, ['run', FIXTURE, '0', ledger, TRANSCRIPT, ''], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolvePort, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString())
      if (m) {
        clearTimeout(killer)
        resolvePort(Number(m[1]))
      }
    })
  })
  return {
    child,
    port,
    posts: () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(l => l.includes(' POST ')).length : 0),
    stop: () => child.kill('SIGTERM'),
  }
}

const KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  wheelUp: false,
  wheelDown: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  fn: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  isPasted: false,
}
const key = (over: Partial<Key> = {}): Key => ({ ...KEY, ...over })

type Filter = (rawInput: string, key: Key) => string
function extractComposerFilter(): { filter: Filter; source: string } {
  const src = readFileSync(COMPOSER, 'utf8')
  const anchor = 'const voiceInputFilter = useCallback('
  const at = src.indexOf(anchor)
  if (at < 0) throw new Error('PromptInput.tsx has no voiceInputFilter useCallback')
  let i = at + anchor.length
  let depth = 1
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) break
    }
  }
  const inner = src.slice(at + anchor.length, i).replace(/,\s*\[\s*\]\s*$/, '')
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const filter = ${inner}`)
  const scope: Record<string, unknown> = {
    voiceSnapshot: session.voiceSnapshot,
    toggleVoiceCapture: session.toggleVoiceCapture,
    pendingInput,
    holdToTalkKey: hold === null ? (): never => { throw new Error('holdToTalk module absent') } : hold.holdToTalkKey,
  }
  const filter = new Function(...Object.keys(scope), `${js}\nreturn filter`)(...Object.values(scope)) as Filter
  return { filter, source: inner }
}

interface FakeTimer {
  id: number
  at: number
  fn: () => void
}
class FakeClock {
  now = 100_000
  private timers: FakeTimer[] = []
  private nextId = 1
  install(): void {
    hold?.configureHoldToTalkForTest({
      now: () => this.now,
      setTimeout: (fn, ms) => {
        const id = this.nextId++
        this.timers.push({ id, at: this.now + Math.max(0, ms), fn })
        return id
      },
      clearTimeout: id => {
        this.timers = this.timers.filter(t => t.id !== id)
      },
      defer: fn => {
        fn()
      },
    })
  }
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      const due = this.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (due === undefined) break
      this.timers = this.timers.filter(t => t.id !== due.id)
      this.now = Math.max(this.now, due.at)
      due.fn()
    }
    this.now = target
  }
  pending(): number {
    return this.timers.length
  }
}

class Composer {
  cursor = 0
  private lastSelfWrite = ''
  private readonly filter: Filter
  constructor(filter: Filter) {
    this.filter = filter
    pendingInput.subscribePendingInput(() => {
      const text = pendingInput.text()
      if (this.lastSelfWrite !== text) {
        this.lastSelfWrite = text
        this.cursor = text.length
      }
    })
    hold?.setHoldToTalkEditor({
      text: () => pendingInput.text(),
      cursor: () => this.cursor,
      splice: (deleteBefore, insert) => {
        const text = pendingInput.text()
        const at = Math.max(0, Math.min(this.cursor, text.length))
        const from = Math.max(0, at - deleteBefore)
        const next = text.slice(0, from) + insert + text.slice(at)
        this.write(next, from + insert.length)
      },
    })
  }
  text(): string {
    return pendingInput.text()
  }
  set(text: string): void {
    this.write(text, text.length)
  }
  private write(text: string, cursor: number): void {
    this.lastSelfWrite = text
    pendingInput.edit(text)
    this.cursor = Math.max(0, Math.min(cursor, text.length))
  }
  press(rawInput: string, over: Partial<Key> = {}): string {
    const k = key(over)
    const filtered = this.filter(rawInput, k)
    if (filtered === '' && rawInput !== '') return ''
    if (k.escape) {
      if (session.voiceSnapshot().phase === 'recording') session.cancelVoiceCapture()
      return ''
    }
    if (k.return || k.tab || k.backspace || k.delete || k.upArrow || k.downArrow || k.leftArrow || k.rightArrow || k.ctrl || k.meta) return ''
    const text = pendingInput.text()
    const at = Math.max(0, Math.min(this.cursor, text.length))
    this.write(text.slice(0, at) + filtered + text.slice(at), at + filtered.length)
    return filtered
  }
}

const clock = new FakeClock()
clock.install()
const STREAM = { delayMs: 375, repeatMs: 30 }
function holdSpace(composer: Composer, durationMs: number, opts: { onRepeat?: (t: number) => void } = {}): { repeats: number; lastAt: number } {
  const t0 = clock.now
  composer.press(' ')
  let repeats = 0
  let t = STREAM.delayMs
  let lastAt = t0
  while (t <= durationMs) {
    clock.advance(t0 + t - clock.now)
    composer.press(' ')
    lastAt = clock.now
    repeats++
    opts.onRepeat?.(t)
    t += STREAM.repeatMs
  }
  return { repeats, lastAt }
}
async function settle(): Promise<void> {
  await sleep(0)
  await sleep(0)
}
const phase = (): string => session.voiceSnapshot().phase

section('§0 the rig — the fixture microphone, a loopback transcriber that answers "world", /speak on, the composer stand-in')
const fx = await startFixture()
process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${fx.port}/v1`
process.env.OPENAI_API_KEY = 'sk-fixture-voice-000000000000000000000000'
process.env.MERCURY_VOICE_BACKEND = 'fixture'
process.env.MERCURY_VOICE_FIXTURE_WAV = TONE
process.env.PATH = EMPTY_BIN
resetComputedDefaultMemo()
pendingInput.initOnce({ text: '', mode: 'prompt', pastedContents: {} })
session.resetVoiceForTest()
session.setVoiceInputEnabled(true)
check('voice input is on for the rig', session.voiceInputEnabled())
const extracted = extractComposerFilter()
const composer = new Composer(extracted.filter)
check('the composer filter was lifted from PromptInput.tsx and runs', typeof extracted.filter === 'function', extracted.source.slice(0, 120))
console.log(`  · hold module: ${hold === null ? 'ABSENT (the base)' : `present — threshold ${hold.HOLD_TO_TALK_MS} ms, gap floor ${hold.RELEASE_GAP_FLOOR_MS} ms, first-repeat window ${hold.FIRST_REPEAT_WINDOW_MS} ms`}`)

const THRESHOLD = hold?.HOLD_TO_TALK_MS ?? 1_000
const gapFor = (interval: number | null): number => hold?.releaseGapMs(interval) ?? 0
const fresh = (text: string): void => {
  hold?.resetHoldToTalkForTest()
  session.resetVoiceForTest()
  composer.set(text)
}

section('§1 a single press types one space at once — with words in the composer or not')
{
  fresh('a')
  composer.press(' ')
  check('"a" then space: the space is typed at once (no lag, no take)', composer.text() === 'a ' && phase() === 'idle', `draft=${JSON.stringify(composer.text())} phase=${phase()}`)
  composer.press('b')
  check('…then b: "a b" — the typed-on key rides untouched', composer.text() === 'a b', JSON.stringify(composer.text()))
  clock.advance(1_500)
  check('nothing flushes later (a single press held nothing back)', composer.text() === 'a b' && clock.pending() === 0, `draft=${JSON.stringify(composer.text())} timers=${clock.pending()}`)
  fresh('')
  composer.press(' ')
  check('an EMPTY composer: a single space press types a space too (no take opens on a press)', composer.text() === ' ' && phase() === 'idle', `draft=${JSON.stringify(composer.text())} phase=${phase()}`)
  await settle()
  check('…and still no take after the press settles', phase() === 'idle', phase())
  fresh('x')
  composer.press(' ')
  composer.press(' ')
  composer.press('y')
  check('a double-tapped space before a letter: both spaces land, in order ("x  y")', composer.text() === 'x  y', JSON.stringify(composer.text()))
}

section(`§2 a 500 ms hold flushes its held-back spaces and opens nothing`)
{
  fresh('hello')
  let heldDuring = true
  const run = holdSpace(composer, 500, {
    onRepeat: () => {
      if (composer.text() !== 'hello ') heldDuring = false
    },
  })
  check(`the press typed one space; the ${run.repeats} repeats were held back while the hold ran (the draft stayed "hello ")`, heldDuring && composer.text() === 'hello ', JSON.stringify(composer.text()))
  check('no take opened short of the threshold', phase() === 'idle', phase())
  const gap = gapFor(STREAM.repeatMs)
  clock.advance(gap - 1)
  check(`one tick short of the release gap (${gap} ms): still held`, composer.text() === 'hello ', JSON.stringify(composer.text()))
  clock.advance(1)
  check(`the release: the ${run.repeats} held-back spaces flush as typed spaces (holding space to insert spaces keeps working)`, composer.text() === 'hello ' + ' '.repeat(run.repeats) && composer.cursor === composer.text().length, `draft length ${composer.text().length}, expected ${6 + run.repeats}`)
  check('…and no take opened', phase() === 'idle' && fx.posts() === 0, `phase=${phase()} posts=${fx.posts()}`)
}

section(`§3 the wolf-fence: with "hello" in the composer, a 1.2 s hold opens a take; the release stops it; "world" lands as "hello world"`)
{
  fresh('hello')
  let openedAt: number | null = null
  const run = holdSpace(composer, 1_200, {
    onRepeat: t => {
      if (openedAt === null && hold !== null && hold.holdToTalkSnapshot()?.phase !== 'holding') openedAt = t
    },
  })
  clock.advance(0)
  await until(() => phase() === 'recording', 2_000)
  const quote = (): string => `the draft is ${JSON.stringify(composer.text().slice(0, 12))}${composer.text().length > 12 ? `… (${composer.text().length} chars — ${composer.text().length - 5} typed spaces)` : ''} and the phase is ${phase()}`
  check(`with "hello" in the composer, the hold past the threshold opened a take (the base: the space typed and nothing opened)`, phase() === 'recording', quote())
  check(`the take opened at the threshold (${THRESHOLD} ms), not before`, openedAt !== null && openedAt >= THRESHOLD && openedAt < THRESHOLD + STREAM.repeatMs, `opened at ${openedAt} ms`)
  check('the footer words while the hold records: the recording line', session.RECORDING_FOOTER.includes('release') && session.RECORDING_FOOTER.includes('esc'), session.RECORDING_FOOTER)
  check('the typed space was withdrawn when the take opened (the transcript will land one space from the words, never two)', composer.text() === 'hello', JSON.stringify(composer.text()))
  const gap = gapFor(STREAM.repeatMs)
  clock.advance(gap - 1)
  check(`holding keeps recording: ${gap - 1} ms after the last repeat the take is still open`, phase() === 'recording', phase())
  clock.advance(1)
  await until(() => phase() !== 'recording', 2_000)
  check(`the release (no repeat within the ${gap} ms gap) stops the take and sends it`, phase() === 'transcribing' || phase() === 'idle', phase())
  await until(() => phase() === 'idle', 5_000)
  check('the transcript lands one space from the words: "hello world"', composer.text() === 'hello world', JSON.stringify(composer.text()))
  check('the cursor sits at the end of the landed words', composer.cursor === composer.text().length, `cursor=${composer.cursor}`)
  check('exactly one take reached the transcriber, after the release', fx.posts() === 1, `posts=${fx.posts()}`)
  composer.press('!')
  check('typing on after the landing: "hello world!"', composer.text() === 'hello world!', JSON.stringify(composer.text()))
}

section('§4 usable again: a second hold after a landed transcript opens a second take')
{
  const before = fx.posts()
  composer.set('hello world')
  hold?.resetHoldToTalkForTest()
  holdSpace(composer, 1_200)
  clock.advance(0)
  await until(() => phase() === 'recording', 2_000)
  check('a second hold, with the first transcript in the composer, opened a second take (the base: never)', phase() === 'recording', `the draft is ${JSON.stringify(composer.text().slice(0, 14))}${composer.text().length > 14 ? `… (${composer.text().length} chars — every space typed)` : ''} and the phase is ${phase()}`)
  clock.advance(gapFor(STREAM.repeatMs))
  await until(() => phase() === 'idle', 5_000)
  check('the second transcript lands after the first: "hello world world"', composer.text() === 'hello world world', JSON.stringify(composer.text()))
  check('a second take reached the transcriber', fx.posts() === before + 1, `posts=${fx.posts()}`)
}

section('§5 esc during a take cancels it; the rest of the hold is swallowed; the release stops nothing')
{
  fresh('note')
  const before = fx.posts()
  holdSpace(composer, 1_200)
  clock.advance(0)
  await until(() => phase() === 'recording', 2_000)
  check('the take is open', phase() === 'recording' && composer.text() === 'note', `phase=${phase()} draft=${JSON.stringify(composer.text())}`)
  composer.press('', { escape: true })
  check('esc cancels: idle, the cancel receipt, the draft untouched', phase() === 'idle' && session.voiceSnapshot().receipt?.text === session.CANCELLED_RECEIPT && composer.text() === 'note', `phase=${phase()} receipt=${session.voiceSnapshot().receipt?.text ?? ''}`)
  for (let i = 0; i < 10; i++) {
    clock.advance(STREAM.repeatMs)
    composer.press(' ')
  }
  check('the repeats after the cancel (the key is still down) type nothing', composer.text() === 'note', JSON.stringify(composer.text()))
  clock.advance(gapFor(STREAM.repeatMs) + 1)
  await settle()
  check('the release after a cancelled take stops nothing and flushes nothing', phase() === 'idle' && composer.text() === 'note' && fx.posts() === before, `phase=${phase()} draft=${JSON.stringify(composer.text())} posts=${fx.posts()}`)
  composer.press(' ')
  check('the next press types a space again', composer.text() === 'note ', JSON.stringify(composer.text()))
}

section('§6 the numbers: the gap derives from the measured repeat interval with a floor and a ceiling; the first-repeat window covers the OS initial delay')
if (hold !== null) {
  check(`the threshold is one named constant: HOLD_TO_TALK_MS = 1000`, hold.HOLD_TO_TALK_MS === 1_000, String(hold.HOLD_TO_TALK_MS))
  check(`a 30 ms repeat rate: the gap is the floor (${hold.RELEASE_GAP_FLOOR_MS} ms)`, hold.releaseGapMs(30) === hold.RELEASE_GAP_FLOOR_MS, String(hold.releaseGapMs(30)))
  check('a 90 ms repeat rate (the macOS default): the gap is twice the interval, 180 ms', hold.releaseGapMs(90) === 180, String(hold.releaseGapMs(90)))
  check(`a 400 ms repeat rate (the slowest Windows setting): 800 ms, under the ceiling`, hold.releaseGapMs(400) === 800, String(hold.releaseGapMs(400)))
  check(`a jittery source never waits past the ceiling (${hold.RELEASE_GAP_CEILING_MS} ms)`, hold.releaseGapMs(5_000) === hold.RELEASE_GAP_CEILING_MS, String(hold.releaseGapMs(5_000)))
  check(`no interval yet (the OS initial delay): the first-repeat window, ${hold.FIRST_REPEAT_WINDOW_MS} ms`, hold.releaseGapMs(null) === hold.FIRST_REPEAT_WINDOW_MS, String(hold.releaseGapMs(null)))
  fresh('slow')
  const t0 = clock.now
  composer.press(' ')
  clock.advance(900)
  composer.press(' ')
  clock.advance(400)
  composer.press(' ')
  clock.advance(400)
  composer.press(' ')
  clock.advance(0)
  await until(() => phase() === 'recording', 2_000)
  check('a 900 ms initial delay then 400 ms repeats is still one hold (the take opens past the threshold)', composer.text() === 'slow' && hold.holdToTalkSnapshot()?.phase === 'recording', `draft=${JSON.stringify(composer.text())} state=${hold.holdToTalkSnapshot()?.phase ?? 'none'}`)
  clock.advance(hold.releaseGapMs(400))
  await until(() => phase() === 'idle', 5_000)
  check('…and its release stops the take without flushing held-back spaces', composer.text() === 'slow world' && phase() === 'idle', JSON.stringify(composer.text()))
  void t0
  fresh('burst')
  composer.press(' ')
  clock.advance(375)
  composer.press('     ')
  check('a run of five spaces in one read (repeats queued behind a stall) counts as five repeats, all held back', composer.text() === 'burst ' && hold.holdToTalkSnapshot()?.heldBack === 5, `draft=${JSON.stringify(composer.text())} heldBack=${hold.holdToTalkSnapshot()?.heldBack ?? -1}`)
  clock.advance(hold.FIRST_REPEAT_WINDOW_MS)
  check('…and flush at the release', composer.text() === 'burst      ', JSON.stringify(composer.text()))
  fresh('typed')
  composer.press(' ')
  clock.advance(375)
  composer.press(' ')
  clock.advance(30)
  composer.press(' ')
  composer.press('', { backspace: true })
  check('a control key inside a short hold drops the held-back spaces (they were never typed) and the hold ends', composer.text() === 'typed ' && hold.holdToTalkSnapshot() === null, `draft=${JSON.stringify(composer.text())} state=${hold.holdToTalkSnapshot()?.phase ?? 'none'}`)
  fresh('off')
  session.setVoiceInputEnabled(false)
  composer.press(' ')
  clock.advance(375)
  composer.press(' ')
  clock.advance(30)
  composer.press(' ')
  check('with /speak off every space types at once — no hold, no hold-back', composer.text() === 'off   ' && hold.holdToTalkSnapshot() === null, JSON.stringify(composer.text()))
  session.setVoiceInputEnabled(true)
} else {
  check('the hold reader module exists (src/services/voice/holdToTalk.ts)', false, 'absent on this tree')
}

section('§7 the words say the new law: hold space to speak, release to stop, esc cancels; /voice for a terminal whose key repeat is off')
{
  const status = session.describeVoiceStatus({ ...process.env, PATH: EMPTY_BIN })
  check('RECORDING_FOOTER: release to stop, esc cancels', /release/.test(session.RECORDING_FOOTER) && /esc/.test(session.RECORDING_FOOTER) && !/space or esc to stop/.test(session.RECORDING_FOOTER), session.RECORDING_FOOTER)
  check('VOICE_OFF_RECEIPT teaches the hold, not the empty composer', /hold space/.test(session.VOICE_OFF_RECEIPT) && !/empty composer/.test(session.VOICE_OFF_RECEIPT), session.VOICE_OFF_RECEIPT)
  check('/speak status ON line: hold space, release to stop, esc cancels', /hold space/.test(status) && /release/.test(status) && /esc/.test(status) && !/empty composer/.test(status), status.split('\n')[0] ?? '')
  check('/speak status names /voice as the road for a terminal whose key repeat is off', /\/voice/.test(status) && /repeat/.test(status), status.split('\n').filter(l => l.includes('/voice')).join(' · '))
  const speak = await import('../../src/commands/speak/speak.js')
  session.setVoiceInputEnabled(false)
  const on = await speak.call('on', {} as never)
  const onText = on.type === 'text' ? on.value : ''
  check('/speak on teaches the hold (the threshold in seconds), the release, esc, and /voice for a key that never repeats', /hold space/.test(onText) && /1 s|1 second|one second/.test(onText) && /release/.test(onText) && /esc/.test(onText) && /\/voice/.test(onText) && /repeat/.test(onText) && !/empty composer/.test(onText), onText.split('\n')[0] ?? '')
  const off = await speak.call('off', {} as never)
  check('/speak off says OFF and that space is a space again', off.type === 'text' && /OFF/.test(off.value) && /space is a space/.test(off.value), off.type === 'text' ? off.value : off.type)
  session.setVoiceInputEnabled(true)
  const voice = await import('../../src/commands/voice/voice.js')
  fresh('')
  const started = await voice.call('', {} as never)
  const startedText = started.type === 'text' ? started.value : ''
  check('/voice starts a take and its receipt names /voice again and esc, not the space key', phase() === 'recording' && /\/voice/.test(startedText) && /esc/.test(startedText) && !/space/.test(startedText), startedText)
  session.cancelVoiceCapture()
  const docs = readFileSync(join(ROOT, 'docs', 'VOICE.md'), 'utf8')
  check('docs/VOICE.md says the new law and names the threshold and /voice for a terminal without key repeat', /hold space/i.test(docs) && /release/.test(docs) && /1 s|one second|1 second/.test(docs) && /key repeat/.test(docs) && !/press space in an empty composer/.test(docs), docs.split('\n').filter(l => /space/.test(l)).slice(0, 3).join(' · '))
}

section('§8 the composer wiring by source: the filter delegates to the reader, the editor seam is registered, esc still cancels')
{
  const src = [COMPOSER, ...COMPOSER_MODULES].map(path => readFileSync(path, 'utf8')).join('\n')
  check('voiceInputFilter delegates to holdToTalkKey', /const voiceInputFilter = useCallback\(\(rawInput: string, key: Key\): string => holdToTalkKey\(rawInput, key\), \[\]\)/.test(src), extracted.source.slice(0, 160))
  check('the composer registers the hold editor (text, cursor, splice at the caret through the one draft owner and the self-write mark) and unregisters on unmount', src.includes('setHoldToTalkEditor({') && src.includes('cursor: () => cursorRef.current') && src.includes('setHoldToTalkEditor(null)') && /splice: \(deleteBefore, insert\) => \{[\s\S]*?writeDraft\(next\)\s*setCursorOffset\(from \+ insert\.length\)/.test(src))
  check('esc during a take still cancels through cancelVoiceCapture', src.includes("if (voicePhase === 'recording' && key.escape) {") && src.includes('cancelVoiceCapture()'))
  check('the deferred space after a chip is untouched (a different space)', src.includes('const deferredSpaceArmedRef = useRef(false)') && src.includes('if (deferredSpaceArmedRef.current) {'))
  const sessionSrc = readFileSync(join(ROOT, 'src', 'services', 'voice', 'voiceSession.ts'), 'utf8')
  check('the session offers startVoiceCapture and stopVoiceCapture beside the toggle /voice keeps', sessionSrc.includes('export async function startVoiceCapture(') && sessionSrc.includes('export function stopVoiceCapture(') && sessionSrc.includes('export async function toggleVoiceCapture('))
}

fx.stop()
hold?.setHoldToTalkEditor(null)
session.resetVoiceForTest()
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-hold-to-talk: green' : `\nprove-hold-to-talk: RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
