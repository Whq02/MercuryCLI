#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = pinScratchHome('paste-sent-whole')
for (const name of ['TYPESAFE_API_KEY', 'MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_SKIP_PROMPT_HISTORY', 'MERCURY_MODEL']) delete process.env[name]
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_JEV_BASE: 'http://127.0.0.1:1',
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_REDUCED_MOTION: '1',
  MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_OPERATOR: 'sam', BROWSER: '/usr/bin/true',
  MERCURY_HOME: join(HOME, 'proof-home'), MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
})
const PROJECT = join(HOME, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(process.env.MERCURY_HOME!, { recursive: true })
process.chdir(PROJECT)

mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
    return { kill() {}, on() {}, unref() {} }
  },
}))

const COLS = 120
const ROWS = 40
const PLACEHOLDER = 'Type a prompt'
const LANDING_NOTICE = 'the session is landing — your line sends when it lands'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const React = await import('react')
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
const { Chat } = await import('../../src/screens/Chat.js')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.js')
const history = await import('../../src/history.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { getCommands } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
markDaemonHaltStanddown()
const commands = await getCommands(PROJECT)

type Paste = { id: number; type: 'text' | 'image'; content: string; contentHash?: string; mediaType?: string; filename?: string }
type Handed = { text: string; pastes: Record<number, Paste>; mode: string | undefined }
const handed: Handed[] = []
const recording = Object.assign(new NoSessionConnector(), {
  sessionId: () => 'proof-session',
  sendWords: async (text: string, opts?: { mode?: string; pastedContents?: Record<number, Paste> }) => {
    handed.push({ text, pastes: { ...(opts?.pastedContents ?? {}) }, mode: opts?.mode })
    return { state: 'accepted' as const }
  },
})
async function wordsSent(send: Handed): Promise<string> {
  const resolved = await history.resolvePastedContents(send.text, send.pastes as never)
  return history.expandPastedTextRefs(send.text, resolved.pastedContents).trim()
}
function body(mark: string): string {
  let text = `${mark} begins. `
  for (let i = 1; text.length < 800; i++) text += `Sentence ${i} of the ${mark} text says nothing new. `
  return `${text}Reply with exactly the first word of this message and the number of the last sentence you can read.`
}
const bracketed = (text: string): string => `\x1b[200~${text}\x1b[201~`
const composerRow = (m: Mounted): string => m.lines().find(line => line.startsWith('│❯')) ?? '(no composer row)'
async function emptyComposer(m: Mounted): Promise<void> {
  await settle(260)
  pending.edit('')
  pending.setPastedContents({})
  pending.setMode('prompt')
  await waitFor(() => composerRow(m).includes(PLACEHOLDER), 3000)
}

initializeSurfaceRoute(ROOT_CHAT_ROUTE)
resetChromeModeLatchForTests()
pending.edit('')
pending.setMode('prompt')
pending.setPastedContents({})
slot.setFocusedSessionConnector(recording)
const h = React.createElement
const m = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))), COLS, ROWS)
await waitFor(() => composerRow(m).includes(PLACEHOLDER), 8000)
await settle(300)

section(`§1 a landed session at ${COLS}x${ROWS}: a paste and then Enter, at five distances`)
check('the composer painted its empty prompt row', composerRow(m).includes(PLACEHOLDER), composerRow(m))
const marks = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Gum', 'Hazel', 'Ivy', 'Juniper', 'Kauri', 'Larch']
let markAt = 0
for (const how of ['a bracketed paste', 'one burst with no brackets'] as const) {
  for (const waitMs of [0, 100, 300, 600, 1500]) {
    const text = body(marks[markAt++ % marks.length]!)
    const before = handed.length
    m.push(how === 'a bracketed paste' ? bracketed(text) : text)
    if (waitMs > 0) await settle(waitMs)
    const shown = composerRow(m).trimEnd()
    m.push(KEY.enter)
    const sent = await waitFor(() => handed.length > before, 2500)
    const words = sent ? await wordsSent(handed[before]!) : ''
    const held = !sent && pending.text().includes('[Pasted text #') && Object.values(pending.pastedContents()).some(paste => (paste as Paste).content === text)
    const label = `${how} of ${text.length} characters, Enter ${waitMs} ms later`
    check(`${label}: what is sent is the whole text, or the line stands in the composer with its text bound — never the placeholder alone`, sent ? words === text : held, sent ? `handed ${JSON.stringify(handed[before]!.text.slice(0, 60))} with ${Object.keys(handed[before]!.pastes).length} paste(s); sent ${words.length} characters: ${JSON.stringify(words.slice(0, 60))}` : `not sent; composer ${JSON.stringify(pending.text().slice(0, 60))}, pastes ${Object.keys(pending.pastedContents()).length}`)
    console.log(`        ${label}: composer before Enter ${JSON.stringify(shown.slice(0, 40))} · ${sent ? `sent ${words.length} characters` : `not sent, the composer holds ${JSON.stringify(pending.text().slice(0, 40))}`}`)
    await emptyComposer(m)
  }
}

section('§2 a session still landing: the line is armed, and it is sent whole when the session lands')
for (const how of ['a bracketed paste', 'one burst with no brackets'] as const) {
  const text = body(marks[markAt++ % marks.length]!)
  let land = (): void => {}
  const landing = slot.withLanding(new Promise<void>(resolve => { land = resolve }))
  slot.releaseFocusedSessionConnector()
  await settle(200)
  const before = handed.length
  m.push(how === 'a bracketed paste' ? bracketed(text) : text)
  await settle(500)
  const shown = composerRow(m).trimEnd()
  m.push(KEY.enter)
  const armed = await waitFor(() => m.screen().includes(LANDING_NOTICE), 3000)
  check(`${how}, Enter 500 ms later while the session lands: the composer showed the placeholder and the line was armed`, shown.includes('[Pasted text #') && armed && handed.length === before, `composer ${JSON.stringify(shown.slice(0, 60))} armed=${armed} handed=${handed.length - before}`)
  await settle(300)
  slot.setFocusedSessionConnector(recording)
  land()
  await landing
  const sent = await waitFor(() => handed.length > before, 4000)
  const words = sent ? await wordsSent(handed[before]!) : ''
  check(`${how}: when the session lands the whole text is sent, never the placeholder alone`, sent && words === text, sent ? `handed ${JSON.stringify(handed[before]!.text.slice(0, 60))} with ${Object.keys(handed[before]!.pastes).length} paste(s); sent ${words.length} characters: ${JSON.stringify(words.slice(0, 60))}` : 'nothing was sent')
  await history.flushHistoryNow()
  const recalled: Array<{ display: string; pastedContents: Record<number, Paste> }> = []
  for await (const entry of history.getHistory()) recalled.push(entry as never)
  const mine = recalled.filter(entry => Object.values(entry.pastedContents).some(paste => paste.content === text))
  check(`${how}: the prompt history holds the line once, with its text`, mine.length === 1 && mine[0]!.display.includes('[Pasted text #'), `${mine.length} entries of ${recalled.length} carry the text`)
  await emptyComposer(m)
}

section('§3 the same road with an image: an armed line keeps its image')
{
  let land = (): void => {}
  const landing = slot.withLanding(new Promise<void>(resolve => { land = resolve }))
  slot.releaseFocusedSessionConnector()
  await settle(200)
  const before = handed.length
  const image: Paste = { id: 7, type: 'image', content: 'iVBORw0KGgo=', mediaType: 'image/png', filename: 'image-7.png' }
  pending.setPastedContents({ 7: image } as never)
  pending.edit('[Image #7] what is in this picture')
  await waitFor(() => composerRow(m).includes('[Image #7]'), 3000)
  m.push(KEY.enter)
  const armed = await waitFor(() => m.screen().includes(LANDING_NOTICE), 3000)
  await settle(300)
  slot.setFocusedSessionConnector(recording)
  land()
  await landing
  const sent = await waitFor(() => handed.length > before, 4000)
  check('a line with an image, sent while the session lands, reaches the session with the image', armed && sent && handed[before]!.pastes[7]?.type === 'image' && handed[before]!.pastes[7]?.content === image.content, sent ? `handed ${JSON.stringify(handed[before]!.text)} with pastes ${JSON.stringify(Object.keys(handed[before]!.pastes))}` : `armed=${armed}, nothing was sent`)
  await emptyComposer(m)
}

section('§4 a second paste left as a draft while the first line waits: each keeps its own text')
{
  const first = body(marks[markAt++ % marks.length]!)
  const second = body(marks[markAt++ % marks.length]!)
  let land = (): void => {}
  const landing = slot.withLanding(new Promise<void>(resolve => { land = resolve }))
  slot.releaseFocusedSessionConnector()
  await settle(200)
  const before = handed.length
  m.push(bracketed(first))
  await waitFor(() => composerRow(m).includes('[Pasted text #'), 3000)
  await settle(300)
  m.push(KEY.enter)
  const armed = await waitFor(() => m.screen().includes(LANDING_NOTICE), 3000)
  await settle(300)
  m.push(bracketed(second))
  await waitFor(() => composerRow(m).includes('[Pasted text #'), 3000)
  await settle(300)
  const draft = pending.text()
  slot.setFocusedSessionConnector(recording)
  land()
  await landing
  const sent = await waitFor(() => handed.length > before, 4000)
  const words = sent ? await wordsSent(handed[before]!) : ''
  const own = sent ? Object.values(handed[before]!.pastes).map(paste => paste.content) : []
  check('the waiting line is sent whole, with its own paste and no other', armed && sent && words === first && own.length === 1 && own[0] === first, sent ? `handed ${JSON.stringify(handed[before]!.text.slice(0, 40))} with ${own.length} paste(s), ${own.map(content => JSON.stringify(content.slice(0, 16))).join(' ')}; sent ${words.length} characters` : `armed=${armed}, nothing was sent`)
  await settle(300)
  check('the draft pasted meanwhile still stands in the composer with its text bound', draft.includes('[Pasted text #') && pending.text() === draft && Object.values(pending.pastedContents()).some(paste => (paste as Paste).content === second), `the draft was ${JSON.stringify(draft)}; the composer holds ${JSON.stringify(pending.text())} with ${Object.keys(pending.pastedContents()).length} paste(s)`)
  m.push(KEY.enter)
  const sentDraft = await waitFor(() => handed.length > before + 1, 3000)
  const draftWords = sentDraft ? await wordsSent(handed[before + 1]!) : ''
  check('…and Enter then sends that draft whole', sentDraft && draftWords === second, sentDraft ? `sent ${draftWords.length} characters: ${JSON.stringify(draftWords.slice(0, 40))}` : 'nothing was sent')
  await emptyComposer(m)
}

section('§5 a landing that ends with no session: the line comes back to the composer with its text bound')
{
  const text = body(marks[markAt++ % marks.length]!)
  let land = (): void => {}
  const landing = slot.withLanding(new Promise<void>(resolve => { land = resolve }))
  slot.releaseFocusedSessionConnector()
  await settle(200)
  const before = handed.length
  m.push(bracketed(text))
  await waitFor(() => composerRow(m).includes('[Pasted text #'), 3000)
  await settle(300)
  const line = pending.text()
  m.push(KEY.enter)
  const armed = await waitFor(() => m.screen().includes(LANDING_NOTICE) && pending.text() === '', 3000)
  land()
  await landing
  const back = await waitFor(() => pending.text() === line, 4000)
  const bound = Object.values(pending.pastedContents()).some(paste => (paste as Paste).content === text)
  check('the refused line is back in the composer as it was sent', armed && back && handed.length === before, `armed=${armed}; the composer holds ${JSON.stringify(pending.text())}, was ${JSON.stringify(line)}`)
  check('…with its pasted text still bound to the placeholder', back && bound && history.danglingReferences(pending.text(), pending.pastedContents()).length === 0, `${Object.keys(pending.pastedContents()).length} paste(s) in the composer; dangling ${JSON.stringify(history.danglingReferences(pending.text(), pending.pastedContents()).map(reference => reference.match))}`)
}

m.unmount()
if (failures === 0) await releaseScratchHome(HOME)
else console.log(`scratch home kept: ${HOME}`)
console.log(`\n${failures === 0 ? `prove-paste-sent-whole: ${checks} checks, 0 failed` : `prove-paste-sent-whole: ${checks} checks, ${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
