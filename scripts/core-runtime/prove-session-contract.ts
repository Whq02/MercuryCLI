#!/usr/bin/env bun
import {
  isDecrqmProbeSafe,
  isProgressReportingAvailable,
  isSynchronizedOutputSupported,
  isXtermJs,
  setXtversionName,
  syncOutputSupportedNow,
  upgradeSyncOutputSupport,
} from '../../src/ink/session/capabilities.js'
import {
  type DeliverySyscalls,
  writeAllSync,
  writeDiffToTerminal,
} from '../../src/ink/session/delivery.js'
import { regionScrollTrustedNow, supportsExtendedKeys } from '../../src/ink/session/capabilities.js'
import { env as detectedEnv } from '../../src/utils/env.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TerminalQuerier,
  cursorPosition,
  da1,
  da2,
  decrqm,
  kittyKeyboard,
  oscColor,
  xtversion,
} from '../../src/ink/session/querier.js'
import type { TerminalResponse } from '../../src/ink/input/input-decoder.js'
import {
  getTerminalFocused,
  getTerminalFocusState,
  resetTerminalFocusState,
  setTerminalFocused,
  subscribeTerminalFocus,
} from '../../src/ink/session/focus-store.js'
import {
  INITIAL_STATE,
  type KeyParseState,
  parseMultipleKeypresses,
} from '../../src/ink/input/input-decoder.js'
import type { Diff } from '../../src/ink/frame.js'
import { BSU, ESU } from '../../src/ink/termio/dec.js'
import { getClearTerminalSequence } from '../../src/ink/session/capabilities.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function serialize(diff: Diff, skipSync: boolean): string {
  let captured = ''
  const fake = {
    stdout: {
      write(s: string) {
        captured += s
        return true
      },
      isTTY: false,
    },
  }
  writeDiffToTerminal(fake as never, diff, skipSync)
  return captured
}

console.log('native-core T5 — session + capability contract')

{
  check('empty diff ⇒ zero bytes (sync on)', serialize([], false) === '')
  check('empty diff ⇒ zero bytes (sync off)', serialize([], true) === '')

  const one: Diff = [{ type: 'stdout', content: 'hi' }]
  check('skipSync: raw content only', serialize(one, true) === 'hi')
  const synced = serialize(one, false)
  check('sync: BSU first', synced.startsWith(BSU), JSON.stringify(synced))
  check('sync: ESU last', synced.endsWith(ESU), JSON.stringify(synced))
  check('sync: content between', synced === BSU + 'hi' + ESU, JSON.stringify(synced))

  const table: Array<[Diff[number], string]> = [
    [{ type: 'carriageReturn' }, '\r'],
    [{ type: 'cursorHide' }, '\x1b[?25l'],
    [{ type: 'cursorShow' }, '\x1b[?25h'],
    [{ type: 'cursorTo', col: 7 }, '\x1b[7G'],
    [{ type: 'hyperlink', uri: '' }, '\x1b]8;;\x07'],
    [{ type: 'styleStr', str: '\x1b[31m' }, '\x1b[31m'],
    [{ type: 'clearTerminal', reason: 'resize' }, getClearTerminalSequence()],
  ]
  for (const [patch, expected] of table) {
    check(
      `patch ${patch.type} bytes`,
      serialize([patch], true) === expected,
      JSON.stringify({ got: serialize([patch], true), expected }),
    )
  }
  const clear2 = serialize([{ type: 'clear', count: 2 }], true)
  check('clear(2) is the eraseLines composition', clear2.includes('\x1b[2K') && clear2.includes('\x1b[1A'), JSON.stringify(clear2))
  check('clear(0) emits nothing', serialize([{ type: 'clear', count: 0 }], true) === '')
}

{
  const saved = { ...process.env }
  const wipe = (): void => {
    for (const k of [
      'TMUX', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'KITTY_WINDOW_ID',
      'VTE_VERSION', 'WT_SESSION', 'ZED_TERM', 'MERCURY_FORCE_SYNC_OUTPUT', 'MERCURY_NO_SYNC_OUTPUT',
      'ConEmuANSI', 'ConEmuPID', 'ConEmuTask',
    ]) {
      delete process.env[k]
    }
  }
  const restore = (): void => {
    wipe()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  }

  wipe()
  process.env.TERM_PROGRAM = 'iTerm.app'
  check('sync: iTerm sniffs true', isSynchronizedOutputSupported() === true)
  process.env.TMUX = '/tmp/tmux-1000/default,123,0'
  check('sync: TMUX kills it even for iTerm', isSynchronizedOutputSupported() === false)
  process.env.MERCURY_FORCE_SYNC_OUTPUT = '1'
  check('sync: TMUX beats FORCE (characterized)', isSynchronizedOutputSupported() === false)
  delete process.env.TMUX
  check('sync: FORCE wins without tmux', isSynchronizedOutputSupported() === true)
  process.env.MERCURY_NO_SYNC_OUTPUT = '1'
  check('sync: NO_SYNC hatch beats FORCE', isSynchronizedOutputSupported() === false)
  delete process.env.MERCURY_FORCE_SYNC_OUTPUT
  process.env.TERM_PROGRAM = 'iTerm.app'
  check('sync: NO_SYNC hatch beats the sniff', isSynchronizedOutputSupported() === false)
  delete process.env.MERCURY_NO_SYNC_OUTPUT
  wipe()
  process.env.VTE_VERSION = '6799'
  check('sync: VTE 6799 false', isSynchronizedOutputSupported() === false)
  process.env.VTE_VERSION = '6800'
  check('sync: VTE 6800 true', isSynchronizedOutputSupported() === true)
  wipe()
  process.env.KITTY_WINDOW_ID = '1'
  check('sync: kitty window id true', isSynchronizedOutputSupported() === true)
  wipe()
  process.env.TERM = 'foot-extra'
  check('sync: foot TERM true', isSynchronizedOutputSupported() === true)

  wipe()
  check('region scroll: clean env matches the platform', regionScrollTrustedNow() === (process.platform !== 'win32'))
  process.env.WT_SESSION = 'ba54c0s0-guid'
  check('region scroll: WT_SESSION never trusted (ConPTY)', regionScrollTrustedNow() === false)
  {
    const inkSrc = readFileSync(join(import.meta.dir, '../../src/ink/ink.tsx'), 'utf8')
    check(
      'the scroll fast path gates on sync output AND region-scroll truth (ink.tsx source ratchet)',
      inkSrc.includes('syncOutputSupportedNow() && regionScrollTrustedNow()'),
    )
  }

  wipe()
  process.env.TERM_PROGRAM = 'Apple_Terminal'
  check('decrqm probe: Apple_Terminal unsafe (the query would PRINT its p)', isDecrqmProbeSafe() === false)
  wipe()
  process.env.TERM_PROGRAM = 'iTerm.app'
  check('decrqm probe: iTerm safe', isDecrqmProbeSafe() === true)
  wipe()
  check('decrqm probe: unknown terminal safe (the probe is the point)', isDecrqmProbeSafe() === true)
  {
    const appSrc = readFileSync(join(import.meta.dir, '../../src/ink/components/App.tsx'), 'utf8')
    check(
      'boot batch gates decrqm(2026) on isDecrqmProbeSafe (App.tsx source ratchet)',
      appSrc.includes('isDecrqmProbeSafe() ? this.querier.send(decrqm(2026)) : Promise.resolve(undefined)') &&
        !/^\s*this\.querier\.send\(decrqm\(2026\)\),/m.test(appSrc),
    )
  }

  wipe()
  check('progress: non-TTY false', isProgressReportingAvailable() === false)

  restore()
}

{
  upgradeSyncOutputSupport()
  check('sync latch: upgraded ⇒ true', syncOutputSupportedNow() === true)
  check('sync latch: sticky', syncOutputSupportedNow() === true)

  setXtversionName('xterm.js(5.5.0)')
  check('xtversion: first write wins ⇒ xterm.js true', isXtermJs() === true)
  setXtversionName('ghostty 1.2.0')
  check('xtversion: second write ignored', isXtermJs() === true)
}

{
  const writes: string[] = []
  const querier = new TerminalQuerier({
    write: (s: string) => {
      writes.push(s)
      return true
    },
  } as never)
  let state: KeyParseState = INITIAL_STATE
  const pump = (bytes: string): void => {
    const [events, next] = parseMultipleKeypresses(state, bytes)
    state = next
    for (const e of events) {
      if (e.kind === 'response') querier.onResponse(e.response)
    }
  }

  const f0 = querier.flush()
  pump('\x1b[?62;22c')
  let f0done = false
  f0.then(() => {
    f0done = true
  })
  const q1 = querier.send(decrqm(2026))
  const f1 = querier.flush()
  pump('\x1b[?62;22c')
  let q1val: unknown = 'unset'
  let f1done = false
  q1.then(v => {
    q1val = v
  })
  f1.then(() => {
    f1done = true
  })
  pump('\x1b[?2026;2$y')
  const qa = querier.send(decrqm(2026))
  const qb = querier.send(decrqm(2026))
  pump('\x1b[?2026;1$y')
  pump('\x1b[?2026;2$y')
  let aVal: { mode: number; status: number } | undefined
  let bVal: { mode: number; status: number } | undefined
  qa.then(v => {
    aVal = v as never
  })
  qb.then(v => {
    bVal = v as never
  })
  const qc = querier.send(da1())
  pump('\x1b[?6')
  pump('2;22c')
  let cVal: unknown
  qc.then(v => {
    cVal = v
  })

  await new Promise(resolve => setTimeout(resolve, 0))
  check('mux: zero-query flush resolves', f0done === true)
  check('mux: pre-barrier query resolves undefined', q1val === undefined, JSON.stringify(q1val))
  check('mux: barrier resolves', f1done === true)
  check('mux: identical queries FIFO — first gets status 1', aVal?.status === 1, JSON.stringify(aVal))
  check('mux: identical queries FIFO — second gets status 2', bVal?.status === 2, JSON.stringify(bVal))
  check('mux: fragmented DA1 resolves', cVal !== undefined && (cVal as { params: number[] }).params[0] === 62, JSON.stringify(cVal))
  check(
    'mux: one write per flush, each flushed request riding its own batch',
    writes.length === 2 &&
      writes[0] === '\x1b[c' &&
      writes[1]?.includes('\x1b[?2026$p') === true &&
      writes.every(w => w.endsWith('\x1b[c')),
    JSON.stringify(writes),
  )
}

{
  resetTerminalFocusState()
  check('focus: unknown ≡ focused', getTerminalFocused() === true)
  check('focus: state reads unknown', getTerminalFocusState() === 'unknown')
  let notified = 0
  const unsub = subscribeTerminalFocus(() => {
    notified++
  })
  setTerminalFocused(false)
  check('focus: synchronous notify on set', notified === 1, String(notified))
  check('focus: blurred reads false', getTerminalFocused() === false)
  setTerminalFocused(false)
  check('focus: every set notifies (characterized)', notified === 2, String(notified))
  setTerminalFocused(true)
  check('focus: refocus notifies', notified === 3, String(notified))
  unsub()
  setTerminalFocused(false)
  check('focus: unsubscribed listener silent', notified === 3, String(notified))
  resetTerminalFocusState()
  check('focus: reset returns to unknown≡focused', getTerminalFocused() === true)
}

{
  const errnoThrow = (code: string): never => {
    const e = new Error(code) as NodeJS.ErrnoException
    e.code = code
    throw e
  }
  const data = Buffer.from('abcdefghij')
  {
    let calls = 0
    const sys: DeliverySyscalls = { writeSync: () => { calls++; return 1 }, sleep: () => {} }
    check('delivery: partial 1-byte writes complete', writeAllSync(7, data, sys) === true && calls === data.length, String(calls))
  }
  {
    let eagains = 0
    let sleeps = 0
    const sys: DeliverySyscalls = {
      writeSync: () => (eagains < 400 ? (eagains++, errnoThrow('EAGAIN')) : data.length),
      sleep: () => { sleeps++ },
    }
    check('delivery: exactly 400 EAGAINs survive (2.5ms quantum each)', writeAllSync(7, data, sys) === true && sleeps === 400, String(sleeps))
  }
  {
    const sys: DeliverySyscalls = { writeSync: () => errnoThrow('EAGAIN'), sleep: () => {} }
    check('delivery: the 401st EAGAIN gives up false', writeAllSync(7, data, sys) === false)
  }
  {
    let n = 0
    const sys: DeliverySyscalls = { writeSync: () => (n++ === 0 ? errnoThrow('EWOULDBLOCK') : data.length), sleep: () => {} }
    check('delivery: EWOULDBLOCK retries like EAGAIN', writeAllSync(7, data, sys) === true)
  }
  {
    let n = 0
    const sys: DeliverySyscalls = { writeSync: () => (n++ === 0 ? 3 : errnoThrow('EPIPE')), sleep: () => {} }
    check('delivery: EPIPE mid-write reads as delivered (exit path)', writeAllSync(7, data, sys) === true)
  }
  {
    const sys: DeliverySyscalls = { writeSync: () => errnoThrow('EIO'), sleep: () => {} }
    check('delivery: EIO reads as delivered', writeAllSync(7, data, sys) === true)
  }
  {
    const sys: DeliverySyscalls = { writeSync: () => errnoThrow('EBADF'), sleep: () => {} }
    let threw = false
    try {
      writeAllSync(7, data, sys)
    } catch {
      threw = true
    }
    check('delivery: unknown errno rethrows', threw)
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), 'native-core-tee-'))
  const teePath = join(dir, 'tee.jsonl')
  const savedTee = process.env.INK_WRITE_TEE
  const savedFull = process.env.INK_WRITE_TEE_FULL
  process.env.INK_WRITE_TEE = teePath
  delete process.env.INK_WRITE_TEE_FULL
  const diff: Diff = [{ type: 'stdout', content: 'tee shape probe' }]
  const streamTerm = { stdout: { write: () => true, isTTY: false }, stderr: {} } as never
  writeDiffToTerminal(streamTerm, diff, true)
  const okSys: DeliverySyscalls = { writeSync: (_fd, d) => d.length, sleep: () => {} }
  const fdTerm = { stdout: { write: () => true, isTTY: true, fd: 7 }, stderr: {} } as never
  writeDiffToTerminal(fdTerm, diff, true, okSys)
  process.env.INK_WRITE_TEE_FULL = '1'
  writeDiffToTerminal(streamTerm, diff, true)
  const lines = readFileSync(teePath, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  check('tee: three records written', lines.length === 3, String(lines.length))
  check('tee: stream flavor key order ts,len,path,delivered,sample',
    JSON.stringify(Object.keys(lines[0]!)) === JSON.stringify(['ts', 'len', 'path', 'delivered', 'sample']),
    JSON.stringify(Object.keys(lines[0]!)))
  check('tee: stream path label', lines[0]!.path === 'stream')
  check('tee: fd flavor key order ts,len,path,delivered,spins,waitMs,sample',
    JSON.stringify(Object.keys(lines[1]!)) === JSON.stringify(['ts', 'len', 'path', 'delivered', 'spins', 'waitMs', 'sample']),
    JSON.stringify(Object.keys(lines[1]!)))
  check('tee: fd path label + delivered', lines[1]!.path === 'fd7' && lines[1]!.delivered === true)
  check('tee: FULL flavor swaps sample for content',
    JSON.stringify(Object.keys(lines[2]!)) === JSON.stringify(['ts', 'len', 'path', 'delivered', 'content']),
    JSON.stringify(Object.keys(lines[2]!)))
  check('tee: .raw side-file carries the handed bytes',
    readFileSync(teePath + '.raw', 'utf8').includes('tee shape probe'))
  if (savedTee === undefined) delete process.env.INK_WRITE_TEE
  else process.env.INK_WRITE_TEE = savedTee
  if (savedFull === undefined) delete process.env.INK_WRITE_TEE_FULL
  else process.env.INK_WRITE_TEE_FULL = savedFull
  rmSync(dir, { recursive: true, force: true })
}

{
  const querier = new TerminalQuerier({ write: () => true } as never)
  let state: KeyParseState = INITIAL_STATE
  const pump = (bytes: string): void => {
    const [events, next] = parseMultipleKeypresses(state, bytes)
    state = next
    for (const e of events) {
      if (e.kind === 'response') querier.onResponse(e.response)
    }
  }
  let barrierDone = false
  let stealVal: unknown
  const barrier = querier.flush()
  const steal = querier.send(da1())
  barrier.then(() => {
    barrierDone = true
  })
  steal.then(v => {
    stealVal = v
  })
  pump('\u001b[?62;22c')
  await new Promise(resolve => setTimeout(resolve, 0))
  check('mux-steal: the explicit da1 stole the sentinel reply', stealVal !== undefined, JSON.stringify(stealVal))
  check('mux-steal: the earlier barrier is still pending', barrierDone === false)
  pump('\u001b[?62;22c')
  await new Promise(resolve => setTimeout(resolve, 0))
  check('mux-steal: the next DA1 fires the barrier', barrierDone === true)
}

{
  const saved = detectedEnv.terminal
  const expect: Array<[string, boolean]> = [
    ['ghostty', true],
    ['WezTerm', true],
    ['tmux', true],
    ['windows-terminal', true],
    ['xterm', false],
    ['', false],
  ]
  for (const [term, want] of expect) {
    detectedEnv.terminal = term as never
    check(`extended-keys: ${term || '(none)'} → ${want}`, supportsExtendedKeys() === want)
  }
  detectedEnv.terminal = saved
}

{
  type ModelQuery = { tag: string; matches: (r: TerminalResponse) => boolean; done: boolean }
  type ModelBatch = { queries: ModelQuery[]; flushTag?: string; closed: boolean }
  type Op =
    | { op: 'send'; kind: string; arg?: number; tag: string }
    | { op: 'flush'; tag: string }
    | { op: 'respond'; r: TerminalResponse }

  const BUILDERS: Record<string, (arg?: number) => { request: string; matches: (r: TerminalResponse) => boolean }> = {
    decrqm: a => decrqm(a!) as never,
    da2: () => da2() as never,
    osc: a => oscColor(a!) as never,
    kitty: () => kittyKeyboard() as never,
    xt: () => xtversion() as never,
    cur: () => cursorPosition() as never,
  }
  const MODEL_MATCH: Record<string, (arg: number | undefined, r: TerminalResponse) => boolean> = {
    decrqm: (a, r) => r.type === 'decrpm' && r.mode === a,
    da2: (_a, r) => r.type === 'da2',
    osc: (a, r) => r.type === 'osc' && r.code === a,
    kitty: (_a, r) => r.type === 'kittyKeyboard',
    xt: (_a, r) => r.type === 'xtversion',
    cur: (_a, r) => r.type === 'cursorPosition',
  }

  function modelRun(ops: Op[]): { log: string[]; unresolved: string[] } {
    const batches: ModelBatch[] = [{ queries: [], closed: false }]
    const log: string[] = []
    for (const op of ops) {
      const open = batches[batches.length - 1]!
      if (op.op === 'send') {
        open.queries.push({ tag: op.tag, matches: r => MODEL_MATCH[op.kind]!(op.arg, r), done: false })
      } else if (op.op === 'flush') {
        open.flushTag = op.tag
        open.closed = true
        batches.push({ queries: [], closed: false })
      } else if (op.r.type === 'da1') {
        const first = batches.find(b => b.closed)
        if (first) {
          for (const q of first.queries) {
            if (!q.done) {
              q.done = true
              log.push(`${q.tag}:undefined`)
            }
          }
          log.push(`${first.flushTag}:done`)
          batches.splice(batches.indexOf(first), 1)
        }
      } else {
        const q = batches.flatMap(b => b.queries).find(c => !c.done && c.matches(op.r))
        if (q) {
          q.done = true
          log.push(`${q.tag}:value`)
        }
      }
    }
    const unresolved = batches
      .flatMap(b => [...b.queries.filter(q => !q.done).map(q => q.tag), ...(b.closed ? [b.flushTag!] : [])])
      .sort()
    return { log, unresolved }
  }

  async function realRun(ops: Op[]): Promise<{ log: string[]; unresolved: string[] }> {
    const querier = new TerminalQuerier({ write: () => true } as never)
    const log: string[] = []
    const pending = new Set<string>()
    for (const op of ops) {
      if (op.op === 'send') {
        pending.add(op.tag)
        void querier.send(BUILDERS[op.kind]!(op.arg) as never).then(v => {
          pending.delete(op.tag)
          log.push(`${op.tag}:${v === undefined ? 'undefined' : 'value'}`)
        })
      } else if (op.op === 'flush') {
        pending.add(op.tag)
        void querier.flush().then(() => {
          pending.delete(op.tag)
          log.push(`${op.tag}:done`)
        })
      } else {
        querier.onResponse(op.r)
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    return { log, unresolved: [...pending].sort() }
  }

  let seed = 1234
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const KINDS = ['decrqm', 'da2', 'osc', 'kitty', 'xt', 'cur']
  const RESPONSES: Array<() => TerminalResponse> = [
    () => ({ type: 'decrpm', mode: 2026, status: 1 }),
    () => ({ type: 'decrpm', mode: 2027, status: 2 }),
    () => ({ type: 'da1', params: [1, 2] }),
    () => ({ type: 'da2', params: [41, 351] }),
    () => ({ type: 'osc', code: 11, data: 'rgb:11/22/33' }),
    () => ({ type: 'osc', code: 10, data: 'rgb:aa/bb/cc' }),
    () => ({ type: 'kittyKeyboard', flags: 1 }),
    () => ({ type: 'xtversion', name: 'ghostty 1.2.0' }),
    () => ({ type: 'cursorPosition', row: 3, col: 7 }),
  ]
  let divergences = 0
  const REPS = 300
  for (let rep = 0; rep < REPS; rep++) {
    const ops: Op[] = []
    const n = 4 + Math.floor(rnd() * 10)
    for (let k = 0; k < n; k++) {
      const roll = rnd()
      if (roll < 0.4) {
        const kind = KINDS[Math.floor(rnd() * KINDS.length)]!
        ops.push({ op: 'send', kind, arg: kind === 'decrqm' ? (rnd() < 0.5 ? 2026 : 2027) : 11, tag: `s${k}` })
      } else if (roll < 0.6) {
        ops.push({ op: 'flush', tag: `f${k}` })
      } else {
        ops.push({ op: 'respond', r: RESPONSES[Math.floor(rnd() * RESPONSES.length)]!() })
      }
    }
    const want = modelRun(ops)
    const got = await realRun(ops)
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      divergences++
      if (divergences <= 3) {
        console.log(`  [mux-fuzz diverge] rep ${rep}\n    ops:   ${JSON.stringify(ops)}\n    model: ${JSON.stringify(want)}\n    real:  ${JSON.stringify(got)}`)
      }
    }
  }
  check(`mux-fuzz: ${REPS} seeded schedules match the reference model`, divergences === 0, String(divergences))
}

if (failures > 0) {
  console.log(`\nnative-core session contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core session contract: green (${checks} checks)`)
