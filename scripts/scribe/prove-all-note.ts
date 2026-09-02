#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-all-note.ts
//  PROOF (#47 S10+S11): the `/all` one-way mirror + the bus `note` kind.
//   (a) buildNote → serialize → parse round-trips as kind 'note' with the text;
//   (b) buildBackAgentUserFrame(note) → "[operator note] <text>" stdin frame;
//   (c) envelopeProse(note) → the text; classifyAuthor(a note teammate msg) → 'operator'
//       (the operator's voice, NEVER the Implementer — the fabrication floor holds);
//   (d) drainScribeDispatches delivers a note IMMEDIATELY and it does NOT consume the
//       one-dispatch-per-drain budget (note + 2 dispatches, busy=false ⇒ note + exactly
//       one dispatch deliver; busy=true ⇒ the note still delivers, dispatches all held);
//   (e) the /all command: fork+scribe gated, supportsNonInteractive, routes a note to
//       the Implementer inbox AND returns the message text (so the Scribe sees it too);
//   (f) commands.ts registers it.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-all-note.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' /all one-way mirror + bus note kind (#47 S10+S11) — proof')
console.log('============================================================')

const bus = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')
const bridge = (await import('../../src/daemon/scribeDispatchBridge.js')) as typeof import('../../src/daemon/scribeDispatchBridge.js')
const tabs = (await import('../../src/components/mercury-ui/scribeChatTabs.js')) as typeof import('../../src/components/mercury-ui/scribeChatTabs.js')

section('(a) buildNote round-trips as kind "note"')
const note = bus.buildNote('team-lead', 'heads up: the prod schema uses snake_case')
const ser = bus.serializeScribeEnvelope(note)
const parsed = bus.parseScribeEnvelope(ser)
check("buildNote().kind === 'note'", note.kind === 'note')
check('note carries the text', note.text === 'heads up: the prod schema uses snake_case')
check("note.from is the operator/team-lead (never 'implementer')", note.from === 'team-lead')
check('parse round-trips the note (note is a recognized scribe envelope)', parsed?.kind === 'note')

section('(b) buildBackAgentUserFrame(note) → "[operator note] …" stdin frame')
const frame = JSON.parse(bridge.buildBackAgentUserFrame(note))
check("frame.type === 'user'", frame.type === 'user')
check('frame tags it as an operator note', typeof frame.message?.content === 'string' && frame.message.content.startsWith('[operator note] '))
check('frame carries the note text', frame.message.content.includes('snake_case'))

section('(c) classifyAuthor(a note) → operator; envelopeProse(note) → the text')
check('envelopeProse(note) renders the text', tabs.envelopeProse(note) === note.text)
const noteMsg = {
  type: 'user',
  message: { role: 'user', content: `<teammate-message teammate_id="team-lead">\n${ser}\n</teammate-message>` },
}
check("classifyAuthor(note teammate msg) === 'operator' (never 'implement')", tabs.classifyAuthor(noteMsg as Parameters<typeof tabs.classifyAuthor>[0]) === 'operator')

section('(d) drain: a note delivers immediately and does NOT consume the dispatch budget')
const tmp = mkdtempSync(join(tmpdir(), 'hermes-note-'))
process.env.MERCURY_CONFIG_DIR = tmp
try {
  const mailbox = await import('../../src/utils/teammateMailbox.js')
  const w = (text: string, from = 'team-lead') =>
    mailbox.writeToMailbox('implementer', { from, text, timestamp: new Date().toISOString() }, 'scribe')
  // a note + TWO dispatches in the same inbox
  await w(ser)
  await w(bus.serializeScribeEnvelope(bus.buildDispatch('scribe', 'task one', { title: 'A' })), 'scribe')
  await w(bus.serializeScribeEnvelope(bus.buildDispatch('scribe', 'task two', { title: 'B' })), 'scribe')

  const replies: string[] = []
  const roster = { reply: async (_s: string, t: string) => { replies.push(t); return true } }

  // busy=false ⇒ note delivers + EXACTLY ONE dispatch (one-at-a-time). If the note had
  // consumed the dispatch budget, delivered would be 1, not 2.
  const delivered = await bridge.drainScribeDispatches(roster, {
    short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => false,
  })
  check('busy=false ⇒ delivered 2 (the note + exactly one dispatch)', delivered === 2, `delivered=${delivered}`)
  check('the note frame was delivered (not held)', replies.some(t => JSON.parse(t).message.content.startsWith('[operator note] ')))
  check('exactly ONE dispatch frame delivered (one-at-a-time preserved)', replies.filter(t => /task (one|two)/.test(JSON.parse(t).message.content)).length === 1)

  // busy=true ⇒ the note STILL delivers (context, not back-pressured); dispatches all held.
  const tmp2 = mkdtempSync(join(tmpdir(), 'hermes-note2-'))
  process.env.MERCURY_CONFIG_DIR = tmp2
  await w(ser)
  await w(bus.serializeScribeEnvelope(bus.buildDispatch('scribe', 'busy task', { title: 'C' })), 'scribe')
  const replies2: string[] = []
  const roster2 = { reply: async (_s: string, t: string) => { replies2.push(t); return true } }
  const delivered2 = await bridge.drainScribeDispatches(roster2, {
    short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => true,
  })
  check('busy=true ⇒ delivered 1 (the note; the dispatch is held)', delivered2 === 1, `delivered=${delivered2}`)
  check('the one delivered frame IS the note (not the held dispatch)', replies2.length === 1 && JSON.parse(replies2[0]!).message.content.startsWith('[operator note] '))
} catch (e) {
  check('drain note test ran', false, String(e).split('\n')[0])
} finally {
  delete process.env.MERCURY_CONFIG_DIR
}

section('(e) the /all command — fork+scribe gated, routes a note + echoes to the Scribe')
const scribeMode = await import('../../src/utils/scribeMode.js')
scribeMode.setScribeMode(true)
const allCmd = (await import('../../src/commands/all/index.js')).default
check("/all is type 'local' named 'all'", allCmd.type === 'local' && allCmd.name === 'all')
check('/all is enabled (fork + scribe mode on)', allCmd.isEnabled?.() === true)
check('/all supportsNonInteractive', allCmd.supportsNonInteractive === true)
const tmp3 = mkdtempSync(join(tmpdir(), 'hermes-allcmd-'))
process.env.MERCURY_CONFIG_DIR = tmp3
try {
  const { call } = await allCmd.load!()
  const BC = bus.OPERATOR_BROADCAST_LABEL
  const out = await call!('use snake_case for the new columns', { options: {} } as never, {} as never)
  check('/all returns the LABELED broadcast value (the Scribe sees it labeled [operator broadcast])', (out as { type?: string; value?: string }).type === 'text' && (out as { value?: string }).value!.startsWith(BC + ' use snake_case for the new columns'))
  const mailbox = await import('../../src/utils/teammateMailbox.js')
  const inbox = await mailbox.readUnreadMessages('implementer', 'scribe')
  const routedEnv = inbox.map(m => bus.parseScribeEnvelope(m.text)).find(e => e?.kind === 'note') as { kind?: string; text?: string; broadcast?: boolean } | undefined
  check('/all routed a BROADCAST note to the Implementer inbox (broadcast:true)', !!routedEnv && routedEnv.broadcast === true)
  check('the routed note carries the operator text', !!routedEnv && routedEnv.text === 'use snake_case for the new columns')
  // daemon-off honesty: bus OFF ⇒ the Scribe-visible return SAYS the Implementer half is queued
  const SBL = process.env.MERCURY_SCRIBE_BUS_LIVE
  process.env.MERCURY_SCRIBE_BUS_LIVE = '0'
  const offOut = await call!('rebuild the index', { options: {} } as never, {} as never)
  check('/all daemon-off ⇒ honest "queued for the Implementer" notice in the return', /Queued for the Implementer/.test((offOut as { value?: string }).value ?? ''))
  SBL === undefined ? delete process.env.MERCURY_SCRIBE_BUS_LIVE : (process.env.MERCURY_SCRIBE_BUS_LIVE = SBL)
  // gate-off: scribe mode off ⇒ /all not enabled (byte-identical default)
  scribeMode.setScribeMode(false)
  check('/all disabled when scribe mode is off (operator→Scribe-only)', allCmd.isEnabled?.() === false)
} catch (e) {
  check('/all call ran', false, String(e).split('\n')[0])
} finally {
  delete process.env.MERCURY_CONFIG_DIR
  scribeMode.setScribeMode(false)
}

section('(f) commands.ts registers /all')
const cmds = src('commands.ts')
check("commands.ts imports the /all command", /import all from '\.\/commands\/all\/index\.js'/.test(cmds))
check('commands.ts lists `all` in the registry', /\ball,\n/.test(cmds) || /\n\s*all,/.test(cmds))

section('(g) #47 BROADCAST upgrade — flag round-trips, labels on both sides, single source of truth')
const bnote = bus.buildNote('team-lead', 'use snake_case', { broadcast: true })
const pnote = bus.buildNote('team-lead', 'plain note', {})
check('buildNote({broadcast:true}).broadcast === true', bnote.broadcast === true)
check('broadcast flag parse round-trips', (bus.parseScribeEnvelope(bus.serializeScribeEnvelope(bnote)) as { broadcast?: boolean })?.broadcast === true)
check('a PLAIN note has no broadcast flag (additive, not a rename — stays byte-identical)', pnote.broadcast === undefined && !('broadcast' in (bus.parseScribeEnvelope(bus.serializeScribeEnvelope(pnote)) as object)))
// the Implementer-side label is broadcast-aware (the flag drives it, not a blanket rename)
check('broadcast note frame ⇒ starts "[operator broadcast] "', JSON.parse(bridge.buildBackAgentUserFrame(bnote)).message.content.startsWith(bus.OPERATOR_BROADCAST_LABEL + ' '))
check('plain note frame ⇒ STILL "[operator note] "', JSON.parse(bridge.buildBackAgentUserFrame(pnote)).message.content.startsWith(bus.OPERATOR_NOTE_LABEL + ' '))
// a broadcast note is still kind 'note' ⇒ same Phase-1 path ⇒ still never consumes the dispatch budget
{
  const tmpG = mkdtempSync(join(tmpdir(), 'hermes-bc-'))
  process.env.MERCURY_CONFIG_DIR = tmpG
  try {
    const mb = await import('../../src/utils/teammateMailbox.js')
    await mb.writeToMailbox('implementer', { from: 'team-lead', text: bus.serializeScribeEnvelope(bnote), timestamp: new Date().toISOString() }, 'scribe')
    await mb.writeToMailbox('implementer', { from: 'scribe', text: bus.serializeScribeEnvelope(bus.buildDispatch('scribe', 'real task', { title: 'T' })), timestamp: new Date().toISOString() }, 'scribe')
    const replies: string[] = []
    const delivered = await bridge.drainScribeDispatches({ reply: async (_s: string, t: string) => { replies.push(t); return true } }, { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => false })
    check('broadcast note + dispatch ⇒ both delivered (broadcast did NOT consume the dispatch budget)', delivered === 2 && replies.some(t => /operator broadcast/.test(JSON.parse(t).message.content)) && replies.some(t => /real task/.test(JSON.parse(t).message.content)))
  } finally {
    delete process.env.MERCURY_CONFIG_DIR
  }
}
// SINGLE SOURCE OF TRUTH: the literal must be byte-identical at the delivery site AND in both packs.
const LIT = bus.OPERATOR_BROADCAST_LABEL
check('OPERATOR_BROADCAST_LABEL is exactly "[operator broadcast]"', LIT === '[operator broadcast]')
check('the delivery site (scribeDispatchBridge) imports the const (no inlined copy)', /OPERATOR_BROADCAST_LABEL/.test(src('daemon', 'scribeDispatchBridge.ts')))
check('the Scribe pack briefs [operator broadcast] (recognition rule)', src('utils', 'scribe', 'scribePack.ts').includes(LIT) && /scribe-operator-broadcast/.test(src('utils', 'scribe', 'scribePack.ts')))
check('the Implementer pack briefs [operator broadcast] (NOT a task)', src('utils', 'scribe', 'implementerPack.ts').includes(LIT))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL /all + NOTE PROOFS PASS')
else console.log(`❌ ${failures} /all + NOTE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
