#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { DOMElement, DOMNode } from '../../src/screen/renderer/dom.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|XAI_|MERCURY_COMPAT_|MERCURY_USAGE_SEED)/.test(name)) delete process.env[name]
}
const scratch = mkdtempSync(join(tmpdir(), 'usage-oauth-credits-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
delete process.env.NODE_ENV
const localeString = Date.prototype.toLocaleString
Date.prototype.toLocaleString = function (_locales, options) { return localeString.call(this, 'en-US', { ...options, timeZone: 'UTC' }) }
const localeDateString = Date.prototype.toLocaleDateString
Date.prototype.toLocaleDateString = function (_locales, options) { return localeDateString.call(this, 'en-US', { ...options, timeZone: 'UTC' }) }

const ROOT = join(import.meta.dir, '../..')
const framesArg = process.argv.indexOf('--frames')
const frameDir = framesArg < 0 ? undefined : process.argv[framesArg + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
const WHOAMI = JSON.parse(readFileSync(join(ROOT, 'scripts/provider-compat/fixtures/huggingface-whoami-v2-documented.json'), 'utf8')) as { user: Record<string, unknown> & { periodEnd: number } }
const HF_ACCESS_TOKEN = 'hf_oauth_fixture_access_token_000001'

const hits: { method: string; path: string; bearer: string | undefined }[] = []
const server = createServer((req, res) => {
  hits.push({ method: req.method ?? '', path: req.url ?? '', bearer: req.headers.authorization })
  if (req.method === 'GET' && req.url === '/api/whoami-v2') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(WHOAMI.user))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"fixture: no such road"}')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
process.env.MERCURY_HUGGINGFACE_HUB_BASE = base
process.env.MERCURY_HUGGINGFACE_API_BASE = `${base}/v1`
process.env.MERCURY_GEMINI_API_BASE = `${base}/v1beta`

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()

async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
await stub('../../src/models/catalogue/computedDefault.js', () => ({ recentSignIns: () => ['gemini', 'huggingface', 'anthropic', 'openai', 'moonshot', 'deepseek', 'zai', 'openrouter', 'openai-compat', 'local'].map(family => ({ family })) }))
await stub('../../src/models/roads/openai/openaiCatalogue.js', () => ({ getGptSeatAvailability: () => ({ state: 'absent', ids: [], reason: 'fixture' }) }))
await stub('../../src/models/roads/catalogueOnDemand.js', () => ({ readCatalogueIfPending: async () => undefined }))
await stub('../../src/models/roads/huggingface/huggingfaceCatalogue.js', () => ({ getHuggingfaceAvailability: () => ({ state: 'absent', liveIds: [], reason: 'catalogue not read in this proof' }) }))
await stub('../../src/screen/model-picker/useCatalogueEpoch.js', () => ({ useCatalogueEpoch: () => 0 }))
await stub('../../src/screen/keys/useKeybinding.js', () => ({ useKeybinding: () => undefined }))
await stub('../../src/models/roads/local/localDiscovery.js', () => ({ getCachedLocalDiscovery: () => undefined, refreshLocalDiscovery: async () => undefined }))
await stub('../../src/screen/keys/ConfigurableShortcutHint.js', () => ({ ConfigurableShortcutHint: () => null }))
await stub('../../src/screen/settings/Settings.js', () => ({ nextSettingsOpen: (() => { let n = 0; return () => ++n })() }))

const geminiAccounts = await import('../../src/models/roads/gemini/geminiAccounts.js')
writeFileSync(
  geminiAccounts.geminiAuthPathForDisplay(),
  JSON.stringify({
    version: 1,
    client: { clientId: '000000000000-fixture.apps.googleusercontent.com' },
    tokens: { accessToken: 'ya29.fixture-access-token', refreshToken: '1//fixture-refresh-token', accessTokenExpiresAtMs: Date.now() + 3_600_000, scope: 'https://www.googleapis.com/auth/cloud-platform' },
    preferredSource: 'oauth',
  }) + '\n',
  { mode: 0o600 },
)
const hfAccounts = await import('../../src/models/roads/huggingface/huggingfaceAccounts.js')
hfAccounts.writeHuggingfaceTokens(
  { accessToken: HF_ACCESS_TOKEN, refreshToken: 'hf_oauth_fixture_refresh', accessTokenExpiresAtMs: Date.now() + 8 * 3_600_000, scope: 'openid profile inference-api' },
  { username: 'fixture-user', fullName: 'Fixture User', observedAtMs: Date.now() },
)
const { recordSignIn } = await import('../../src/models/sign-in/account-ledger/signInLedger.js')
recordSignIn('gemini', 'oauth')
recordSignIn('huggingface', 'oauth')

const owner = await import('../../src/models/roads/providerUsage.js')
const { JEV_USAGE_LABEL, Usage } = await import('../../src/screen/settings/Usage.js')
const { Box, render, flushPendingSyncWork, EventEmitter } = await import('../../src/screen/themedRenderer.js')
const { default: StdinContext } = await import('../../src/screen/renderer/elements/StdinContext.js')
const { default: squashText } = await import('../../src/screen/renderer/squash-text-nodes.js')

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const settle = async (): Promise<void> => {
  for (let index = 0; index < 12; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}
function textRuns(node: DOMNode): string[] {
  if (node.nodeName === '#text') return []
  if (node.nodeName === 'ink-text') return [squashText(node)]
  return node.childNodes.flatMap(textRuns)
}
let token = 0
async function mount(width: number, columns: number) {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: 80 }) as unknown as NodeJS.WriteStream
  const root = React.createRef<DOMElement>()
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(Box, { ref: root, flexDirection: 'column' }, React.createElement(Usage, { width, rowBudget: 70, openToken: ++token } as never)))
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    runs: () => (root.current ? textRuns(root.current).filter(run => run !== '' && !run.startsWith(JEV_USAGE_LABEL)) : []),
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}

console.log('the two OAuth sign-ins paint their credits words: the Google account and the Hugging Face account, at 80 and 120 columns')

section('§1 the owner before the tab: the Google sign-in and the Hugging Face sign-in are the active sources')
{
  const gm = owner.usageForProvider('gemini')
  const hf = owner.usageForProvider('huggingface')
  check("gemini: the Google sign-in is the active source with the 'Google sign-in' tier and the one credits spelling", gm.sourceKind === 'oauth' && gm.tier === 'Google sign-in' && owner.usageCreditsLine(gm.credits) === `credits: ${owner.CREDITS_UNREPORTED_WORDS}`, JSON.stringify({ kind: gm.sourceKind, tier: gm.tier }) + ' — fix usageForProvider and usageCreditsLine in src/models/roads/providerUsage.ts so the Google sign-in is the oauth source with tier Google sign-in and the one credits spelling')
  check("huggingface: the sign-in is the active source, unread — 'Hugging Face sign-in' — with the one credits spelling and no plan yet", hf.sourceKind === 'oauth' && hf.tier === 'Hugging Face sign-in' && owner.usageCreditsLine(hf.credits) === `credits: ${owner.CREDITS_UNREPORTED_WORDS}` && hf.figures === undefined, JSON.stringify({ kind: hf.sourceKind, tier: hf.tier, figures: hf.figures }) + ' — fix usageForProvider in src/models/roads/providerUsage.ts (the Hugging Face view is huggingfaceUsageView in src/models/roads/provider-usage/huggingface.ts) so the unread sign-in is oauth, tier Hugging Face sign-in, with no figures')
  check('no road has been asked before a meter is shown', hits.length === 0, JSON.stringify(hits) + ' — usageForProvider in src/models/roads/providerUsage.ts must not call any road before the Usage tab is mounted')
}

const periodEnd = new Date(WHOAMI.user.periodEnd * 1000).toLocaleDateString()
const expectedPlanRow = new RegExp(`^PRO plan · payment method on file · period ends ${periodEnd.replace(/[/]/g, '\\/')} · endpoint-fed · read \\d+ s ago$`)
for (const [width, columns] of [[80, 80], [120, 120]] as const) {
  section(`§2 the tab at ${columns} columns (body width ${width}): the words on the surface`)
  const board = await mount(width, columns)
  const frame = board.frame()
  const runs = board.runs()
  const lines = frame.split('\n')
  check(`${columns}: every provider mounts without an error`, !frame.includes('RENDER ERROR'), 'a provider section threw while painting; read the RENDER ERROR text in the frame and fix the section in src/screen/settings/usage/sections.tsx')
  check(`${columns}: every painted line fits the body width`, lines.every(line => stringWidth(line) <= width), String(Math.max(...lines.map(line => stringWidth(line)))) + ' is the widest line; wrap or shorten the row that overflows in src/screen/settings/usage/lines.tsx')
  const geminiAt = runs.indexOf('Gemini usage')
  const hfAt = runs.indexOf('Hugging Face usage')
  check(`${columns}: the two signed-in families lead the board, the session's family first`, geminiAt >= 0 && hfAt >= 0 && geminiAt < 2 && geminiAt !== hfAt, `${geminiAt} ${hfAt} — the signed-in families must lead the board; fix orderUsageSections in src/screen/settings/usage/plan.ts`)
  const geminiEnd = runs.findIndex((run, index) => index > geminiAt && /^[A-Z][A-Za-z. ]+ usage$/.test(run))
  const geminiRuns = runs.slice(geminiAt, geminiEnd === -1 ? undefined : geminiEnd)
  const googleSlot = geminiRuns.indexOf('Google account') + 1
  check(`${columns}: the Gemini section carries its credits line right under its identity line, and the Google account slot carries none of its own`, geminiRuns[1] === 'Google account (OAuth)' && geminiRuns[2] === `credits: ${owner.CREDITS_UNREPORTED_WORDS}` && googleSlot > 0 && geminiRuns[googleSlot] === 'Google account (OAuth)' && !geminiRuns[googleSlot + 1]?.startsWith('This session') && geminiRuns[googleSlot + 1] !== `credits: ${owner.CREDITS_UNREPORTED_WORDS}`, JSON.stringify(geminiRuns.slice(0, 3).concat(geminiRuns.slice(googleSlot, googleSlot + 3))) + ' — the credits line belongs right under the identity line and nowhere in the slot; fix the credits line in src/screen/settings/usage/lines.tsx')
  check(`${columns}: the Gemini absence line names what Google states (nothing) and the view`, geminiRuns.some(run => run.includes('no usage endpoint, no quota headers on its replies') && run.includes('Quotas page') && run.includes('Google AI Studio')), geminiRuns.join(' | ') + ' — the absence line is the words in src/models/roads/gemini/geminiUsageState.ts; restore them there or paint them in src/screen/settings/usage/sections.tsx')
  check(`${columns}: the key slot of the Gemini section is absent and carries no credits line of its own`, geminiRuns.filter(run => run === `credits: ${owner.CREDITS_UNREPORTED_WORDS}`).length === 1, geminiRuns.join(' | ') + ' — the Gemini section must paint exactly one credits line, under its identity line; fix src/screen/settings/usage/lines.tsx')
  const nextHeading = runs.findIndex((run, index) => index > hfAt && /^[A-Z][A-Za-z. ]+ usage$/.test(run))
  const hfRuns = runs.slice(hfAt, nextHeading === -1 ? undefined : nextHeading)
  const signIn = hfRuns.indexOf('Hugging Face account (fixture-user)')
  check(`${columns}: the Hugging Face section carries its credits line right under its identity line, and the sign-in slot carries none of its own`, hfRuns[1] === 'Signed in as fixture-user' && hfRuns[2] === `credits: ${owner.CREDITS_UNREPORTED_WORDS}` && signIn >= 0 && !hfRuns[signIn + 1]?.startsWith('This session') && hfRuns[signIn + 1] !== `credits: ${owner.CREDITS_UNREPORTED_WORDS}`, JSON.stringify(hfRuns.slice(0, 3).concat(hfRuns.slice(signIn, signIn + 3))) + ' — the credits line belongs right under the identity line and nowhere in the sign-in slot; fix the credits line in src/screen/settings/usage/lines.tsx')
  const planRow = hfRuns.find(run => run.startsWith('PRO plan'))
  check(`${columns}: the plan row is the Hub's stated plan with the period end and the read's feed + age`, planRow !== undefined && expectedPlanRow.test(planRow), (planRow ?? hfRuns.join(' | ')) + ' — the plan row is built by huggingfacePlanFigures in src/models/roads/provider-usage/huggingface.ts and painted by src/screen/settings/usage/lines.tsx')
  check(`${columns}: the Hugging Face billing line names what whoami-v2 states, what it does not, and the billing page`, hfRuns.some(run => run.startsWith('Billing: no spend or credit API is documented') && run.includes('whoami-v2') && run.includes('not the credits used or left') && run.includes('huggingface.co/settings/billing')), hfRuns.join(' | ') + ' — the billing words live in src/models/roads/huggingface/huggingfaceUsageState.ts; restore them there')
  check(`${columns}: exactly two credits lines on the board — one per OAuth sign-in — and never a stated balance`, runs.filter(run => run === `credits: ${owner.CREDITS_UNREPORTED_WORDS}`).length === 2 && !runs.some(run => /USD \d/.test(run)), runs.join(' | ') + ' — only the Gemini and Hugging Face OAuth sign-ins may paint a credits line, and none may state a balance; fix src/screen/settings/usage/lines.tsx')
  const wrapped = lines.filter(line => !line.startsWith(JEV_USAGE_LABEL)).join('\n').replace(/\s+/g, ' ')
  check(`${columns}: the frame itself shows both credits lines and the plan row (wrapped, never truncated; the JEV row keeps its own credits line apart)`, wrapped.split(`credits: ${owner.CREDITS_UNREPORTED_WORDS}`).length === 3 && wrapped.includes('PRO plan · payment method on file'), frame + ' — the credits lines and the plan row must wrap, never truncate; fix the Text wrap in src/screen/settings/usage/lines.tsx')
  if (frameDir !== undefined) writeFileSync(join(frameDir, `usage-oauth-credits-${columns}.txt`), frame + '\n')
  board.close()
}

section('§3 the reader behind the words: one loopback read, the stored bearer, nothing asked of Google')
{
  const whoami = hits.filter(hit => hit.path === '/api/whoami-v2')
  check('the Hub was asked whoami-v2 exactly once across both mounts (the second mount served the observation inside the floor)', whoami.length === 1, JSON.stringify(hits) + ' — the Hugging Face whoami-v2 read must serve the second mount from its observation inside the floor instead of asking again')
  check('the ask carried the stored sign-in token as its bearer', whoami[0]?.method === 'GET' && whoami[0]?.bearer === `Bearer ${HF_ACCESS_TOKEN}`, JSON.stringify(whoami) + ' — the whoami-v2 read must send the stored sign-in token as its bearer; see src/models/roads/huggingface/huggingfaceAccounts.ts')
  check('no request reached the Gemini base or any other road', hits.every(hit => hit.path === '/api/whoami-v2'), JSON.stringify(hits) + ' — a usage read must ask only the Hub whoami-v2 road; find the extra request in src/models/roads/providerUsage.ts and src/models/roads/gemini/geminiUsageState.ts')
  const hf = owner.usageForProvider('huggingface')
  check("after the read the tier is the stated plan — 'Hugging Face PRO' — and the plan figure carries the Hub's period end", hf.tier === 'Hugging Face PRO' && hf.figures?.find(f => f.key === 'plan')?.resetsAtMs === WHOAMI.user.periodEnd * 1000, JSON.stringify({ tier: hf.tier, figures: hf.figures }) + ' — after the whoami-v2 read the tier and the plan figure must come from the stated plan; fix src/models/roads/provider-usage/huggingface.ts')
}

server.close()
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-oauth-credits-words${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
