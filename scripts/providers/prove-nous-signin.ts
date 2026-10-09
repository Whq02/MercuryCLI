#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { nousFixture, NOUS_FIXTURE_API_KEY, NOUS_FIXTURE_CLIENT_ID, NOUS_FIXTURE_SCOPE, NOUS_FIXTURE_USER_CODE } from './lib/nous-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TOOL_DEFER = '1'
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_MODEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[name]
const fixture = nousFixture()
Object.assign(process.env, fixture.signinEnv)

let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const EXPIRED_LINE = 'Nous Portal sign-in expired — sign in again (/logins nous) or use an API key'
const OFFER = '/logins nous retries the sign-in or stores an API key.'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const oauth = await import('../../src/services/providers/nous/nousOauth.ts')
const accounts = await import('../../src/services/providers/nous/nousAccounts.ts')
const login = await import('../../src/services/providers/nous/nousLogin.ts')
const cat = await import('../../src/services/providers/nous/nousCatalogue.ts')
const usageState = await import('../../src/services/providers/nous/nousUsageState.ts')
const owner = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
const readinessForRoute = (model: string) => resolvePrimaryAgentBackend(model)!.readiness()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
type Message = import('../../src/types/message.ts').Message
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

async function turn(model: string, prompt: string): Promise<{ captures: typeof fixture.requests; errors: string[]; settled: AssistantMessage[] }> {
  const before = fixture.requests.length
  const errors: string[] = []
  const settled: AssistantMessage[] = []
  const messages: Message[] = [createUserMessage({ content: prompt })]
  for await (const item of routedCallModel({
    messages: messages as never,
    systemPrompt: ['Fixture system'] as never,
    thinkingConfig: { type: 'enabled', budgetTokens: 1024 } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false } as never,
  })) {
    if (item.type === 'assistant') {
      if (item.isApiErrorMessage) errors.push(item.message.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(''))
      else settled.push(item as AssistantMessage)
    }
  }
  return { captures: fixture.requests.slice(before), errors, settled }
}

type LoginEvent = import('../../src/services/providers/nous/nousLogin.ts').NousDeviceLoginEvent
async function signIn(): Promise<{ outcome: Awaited<ReturnType<typeof login.runNousDeviceLogin>>; events: LoginEvent[]; captures: typeof fixture.requests }> {
  const before = fixture.requests.length
  const events: LoginEvent[] = []
  const outcome = await login.runNousDeviceLogin({ sleep: ms => sleep(Math.min(ms, 20)), onEvent: e => events.push(e) })
  return { outcome, events, captures: fixture.requests.slice(before) }
}

function child(mode: 'refresh' | 'read'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['run', join(import.meta.dir, 'lib', 'nous-signin-child.ts'), mode], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', chunk => { out += String(chunk) })
    proc.stderr.on('data', chunk => { err += String(chunk) })
    proc.on('close', code => {
      const line = out.trim().split('\n').at(-1) ?? ''
      try {
        resolve(JSON.parse(line) as Record<string, unknown>)
      } catch {
        reject(new Error(`child ${mode} rc=${code}: ${out.slice(-400)} ${err.slice(-400)}`))
      }
    })
  })
}

try {
  console.log('── signed out: the family offers the door and the key leg, nothing invented ──')
  check('no credential ⇒ the family is not usable and the sign-in file is absent', !resolveProviderUsability().nous.usable && accounts.resolveNousAccount() === undefined && oauth.nousStoredTokens() === undefined)
  check('the connect rows are the sign-in and the key', login.NOUS_CONNECT_ROWS.map(r => r.value).join(',') === 'device,key' && login.NOUS_CONNECT_ROWS[0]!.label.includes('Nous Portal account'))

  console.log('── the door: start → the browser URL shown → poll (pending, then approved) → the pair stored → the receipt ──')
  const first = await signIn()
  const start = first.captures.find(c => c.path === '/api/oauth/device/code')
  check('the START request is a form POST carrying the Portal client id and the invoke scope, under Mercury\'s own user agent', start?.method === 'POST' && start.body?.client_id === NOUS_FIXTURE_CLIENT_ID && start.body?.scope === NOUS_FIXTURE_SCOPE && /^mercury\//.test(start.headers['user-agent'] ?? ''), JSON.stringify({ body: start?.body, ua: start?.headers['user-agent'] }))
  const waiting = first.events.find(e => e.phase === 'waiting') as Extract<LoginEvent, { phase: 'waiting' }> | undefined
  check('the wait event carries the user code and the Portal\'s complete verification URL for the browser', waiting?.start.userCode === NOUS_FIXTURE_USER_CODE && waiting.start.verificationUriComplete === `${fixture.base}/device?user_code=${NOUS_FIXTURE_USER_CODE}` && waiting.start.intervalSec === 1, JSON.stringify(waiting?.start))
  const polls = first.captures.filter(c => c.path === '/api/oauth/token' && c.body?.grant_type === 'urn:ietf:params:oauth:grant-type:device_code')
  check('the poll is the device-code grant with the client id; one pending answer, then the pair', polls.length === 2 && polls.every(p => p.body?.client_id === NOUS_FIXTURE_CLIENT_ID && p.body?.device_code !== undefined), `${polls.length} polls`)
  check('the events read starting → waiting → finishing', first.events[0]?.phase === 'starting' && first.events.at(-1)?.phase === 'finishing')
  const stored = oauth.nousStoredTokens()
  check('the pair is stored beside the key, auth-scoped, mode 600, with the Portal-handed inference base and the account id', stored !== undefined && stored.refreshToken === 'rt-fixture-1' && stored.accountId === 'user-fixture' && stored.inferenceBase === `${fixture.base}/v1` && (statSync(oauth.nousAuthPathForDisplay()).mode & 0o777) === 0o600 && oauth.nousAuthPathForDisplay().startsWith(proofHome), JSON.stringify({ stored, mode: (statSync(oauth.nousAuthPathForDisplay()).mode & 0o777).toString(8) }))
  check('the sign-in is the preferred source and the account resolves as a sign-in', oauth.readPreferredNousSource() === 'signin' && accounts.resolveNousAccount()?.kind === 'signin' && accounts.resolveNousAccount()?.expired === undefined)
  check('the receipt names the plan and the usable credits read with the sign-in token, never a token value', first.outcome.ok && first.outcome.receipt.startsWith('Nous Portal sign-in stored (auth-scoped, mode 600) · plan Plus (tier 2) · USD 42.50 usable credits') && !first.outcome.receipt.includes(stored!.accessToken) && !first.outcome.receipt.includes('rt-fixture'), first.outcome.receipt)
  const accountRead = first.captures.find(c => c.path === '/api/oauth/account')
  check('the account was read with the access token as the bearer', accountRead?.headers.authorization === `Bearer ${stored!.accessToken}`)
  check('the user-facing words never name the other product', !/hermes/i.test(first.outcome.receipt) && !login.NOUS_CONNECT_ROWS.some(r => /hermes/i.test(r.label)) && !/hermes/i.test(EXPIRED_LINE))

  console.log('── every surface reads signed in: usability, /model availability, the backend, the slot ──')
  check('the usability resolver reads the sign-in as an oauth credential, usable', resolveProviderUsability().nous.usable && resolveProviderUsability().nous.credential === 'oauth', JSON.stringify(resolveProviderUsability().nous))
  await cat.refreshNousCatalogue({ force: true })
  const availability = cat.getNousAvailability()
  check('/model lists the Portal rows under the sign-in', availability.state === 'ready' && availability.source.startsWith('Nous Portal sign-in') && availability.modelCount === 35, JSON.stringify(availability))
  const modelsRead = fixture.requests.filter(c => c.path === '/v1/models').at(-1)
  check('the catalogue read rode the sign-in token', modelsRead?.headers.authorization === `Bearer ${stored!.accessToken}`)
  const ready = readinessForRoute('nous/anthropic/claude-sonnet-4.6')
  check('the backend reads configured on the sign-in', ready.state === 'configured' && ready.detail?.includes('Nous Portal sign-in') === true, JSON.stringify(ready))
  const slot = deriveFamilySlotGroups().flatMap(g => g.slots).find(s => s.id === 'nous:signin')
  check('/accounts shows the sign-in slot, signed in, removable', slot?.kind === 'oauth' && slot.signedIn && slot.active && slot.removal.route === 'nous-signin', JSON.stringify(slot))

  console.log('── a turn on the token: the bearer is the access token on the Portal-handed inference base ──')
  const turn1 = await turn('nous/anthropic/claude-sonnet-4.6', 'Say OK')
  const chat = turn1.captures.find(c => c.path === '/v1/chat/completions')
  check('the turn settles with the access token as the bearer and the Portal slug', turn1.errors.length === 0 && chat?.headers.authorization === `Bearer ${stored!.accessToken}` && chat.body?.model === 'anthropic/claude-sonnet-4.6', JSON.stringify({ errors: turn1.errors, auth: chat?.headers.authorization?.slice(0, 16) }))
  check('the reply settles', turn1.settled.flatMap(m => m.message.content).some(b => b.type === 'text' && (b as { text: string }).text.includes('OK from the Portal fixture')))

  console.log('── /usage from the account road with the sign-in token ──')
  usageState.__resetNousUsageForTest()
  await owner.refreshProviderUsage('nous', { force: true })
  const meter = owner.usageForProvider('nous')
  check('the meter reads the account with the sign-in: plan and usable credits, source oauth', meter.sourceKind === 'oauth' && meter.credits.state === 'reported' && meter.credits.display === 'USD 42.50 usable credits' && (meter.figures ?? []).some(f => f.key === 'plan' && f.value === 'Plus (tier 2)'), JSON.stringify({ kind: meter.sourceKind, credits: meter.credits }))
  check('the last account read carried the access token', fixture.requests.filter(c => c.path === '/api/oauth/account').at(-1)?.headers.authorization === `Bearer ${stored!.accessToken}`)

  console.log('── the refresh rotation: one grant, the refresh token in its header, the new pair written before the old is forgotten ──')
  const refreshBefore = fixture.requests.length
  const rotated = await oauth.refreshNousTokens(undefined, true)
  const refreshReq = fixture.requests.slice(refreshBefore).filter(c => c.path === '/api/oauth/token')
  check('exactly one refresh grant left, as a form with the client id and the refresh token in the x-nous-refresh-token header', refreshReq.length === 1 && refreshReq[0]!.body?.grant_type === 'refresh_token' && refreshReq[0]!.body?.client_id === NOUS_FIXTURE_CLIENT_ID && refreshReq[0]!.headers['x-nous-refresh-token'] === 'rt-fixture-1' && refreshReq[0]!.body?.refresh_token === undefined, JSON.stringify(refreshReq.map(r => ({ body: r.body, header: r.headers['x-nous-refresh-token'] }))))
  check('the rotated pair is the stored pair', rotated?.refreshToken === 'rt-fixture-2' && oauth.nousStoredTokens()?.refreshToken === 'rt-fixture-2' && oauth.nousStoredTokens()?.accessToken === rotated.accessToken)
  check('a fresh pair is not refreshed again without force', (await oauth.refreshNousTokens())?.refreshToken === 'rt-fixture-2' && fixture.requests.filter(c => c.path === '/api/oauth/token').length === fixture.requests.slice(0, refreshBefore).filter(c => c.path === '/api/oauth/token').length + 1)
  check('a turn after the rotation rides the new access token', (await turn('nous/anthropic/claude-sonnet-4.6', 'Say OK')).captures.find(c => c.path === '/v1/chat/completions')?.headers.authorization === `Bearer ${rotated!.accessToken}`)

  console.log('── two processes never race one grant: the second waits on the lock and adopts the first\'s rotation ──')
  let releaseHold: () => void = () => {}
  fixture.oauth.tokenHold = new Promise<void>(resolve => { releaseHold = resolve })
  const raceBefore = fixture.requests.length
  const mine = oauth.refreshNousTokens(undefined, true)
  await sleep(300)
  const peer = child('refresh')
  await sleep(1500)
  releaseHold()
  fixture.oauth.tokenHold = undefined
  const [mineDone, peerDone] = await Promise.all([mine, peer])
  const raceGrants = fixture.requests.slice(raceBefore).filter(c => c.path === '/api/oauth/token')
  check('one refresh grant served both processes', raceGrants.length === 1 && mineDone?.refreshToken === 'rt-fixture-3', `${raceGrants.length} grants; mine ${mineDone?.refreshToken}`)
  check('the second process adopted the first\'s rotated pair instead of spending the old token', peerDone.beforeRefresh === 'rt-fixture-2' && peerDone.afterRefresh === 'rt-fixture-3' && peerDone.error === undefined, JSON.stringify(peerDone))
  check('the store holds the one live pair', oauth.nousStoredTokens()?.refreshToken === 'rt-fixture-3' && fixture.oauth.liveRefresh === 'rt-fixture-3')

  console.log('── a Portal fault keeps the pair: 5xx and the edge firewall never sign out ──')
  fixture.oauth.refreshStatus = 503
  let faultWords = ''
  try { await oauth.refreshNousTokens(undefined, true) } catch (error) { faultWords = error instanceof Error ? error.message : String(error) }
  check('a 503 keeps the stored pair and says retry', faultWords.includes('HTTP 503') && faultWords.includes('kept') && oauth.nousStoredTokens()?.refreshToken === 'rt-fixture-3' && oauth.nousSigninRefusal() === undefined, faultWords)
  fixture.oauth.refreshStatus = 403
  fixture.oauth.refreshEdge = 'deny'
  faultWords = ''
  try { await oauth.refreshNousTokens(undefined, true) } catch (error) { faultWords = error instanceof Error ? error.message : String(error) }
  check('an edge-mitigated 403 keeps the stored pair', faultWords.includes('HTTP 403') && oauth.nousStoredTokens()?.refreshToken === 'rt-fixture-3' && oauth.nousSigninRefusal() === undefined, faultWords)
  fixture.oauth.refreshStatus = 200
  fixture.oauth.refreshEdge = undefined

  console.log('── an outage at refresh time: a still-valid token rides the turn; an expired one names the fault and the key leg, never "expired sign-in" ──')
  const live = oauth.nousStoredTokens()!
  oauth.writeNousTokens({ ...live, expiresAtMs: Date.now() + 60_000 })
  fixture.oauth.refreshStatus = 503
  const outageTurn = await turn('nous/anthropic/claude-sonnet-4.6', 'Say OK')
  check('a token inside the refresh skew but still valid rides the turn when the Portal cannot refresh it', outageTurn.errors.length === 0 && outageTurn.captures.find(c => c.path === '/v1/chat/completions')?.headers.authorization === `Bearer ${live.accessToken}` && outageTurn.captures.some(c => c.path === '/api/oauth/token'), JSON.stringify(outageTurn.errors))
  oauth.writeNousTokens({ ...live, expiresAtMs: Date.now() - 1_000 })
  const expiredOutage = await turn('nous/anthropic/claude-sonnet-4.6', 'Say OK')
  check('an expired token the Portal cannot refresh refuses before the wire with the fault and the key leg, keeping the pair', expiredOutage.captures.filter(c => c.path === '/v1/chat/completions').length === 0 && expiredOutage.errors.length === 1 && expiredOutage.errors[0]!.includes('could not refresh the sign-in (HTTP 503') && expiredOutage.errors[0]!.includes(OFFER) && !expiredOutage.errors[0]!.includes(EXPIRED_LINE) && oauth.nousStoredTokens()?.refreshToken === live.refreshToken && oauth.nousSigninRefusal() === undefined, JSON.stringify(expiredOutage.errors))
  fixture.oauth.refreshStatus = 200
  const recovered = await turn('nous/anthropic/claude-sonnet-4.6', 'Say OK')
  check('when the Portal answers again the next turn refreshes and rides the new token', recovered.errors.length === 0 && oauth.nousStoredTokens()?.refreshToken === 'rt-fixture-4' && recovered.captures.find(c => c.path === '/v1/chat/completions')?.headers.authorization === `Bearer ${oauth.nousStoredTokens()?.accessToken}`, JSON.stringify({ errors: recovered.errors, rt: oauth.nousStoredTokens()?.refreshToken }))

  console.log('── a lost race / a reused refresh token: invalid_grant ⇒ SIGNED OUT on every surface through the durable mark ──')
  fixture.oauth.spentRefresh.add('rt-fixture-4')
  let deadWords = ''
  try { await oauth.refreshNousTokens(undefined, true) } catch (error) { deadWords = error instanceof Error ? error.message : String(error) }
  check('the refresh refusal is the one plain line', deadWords.startsWith(EXPIRED_LINE) && deadWords.includes('invalid_grant'), deadWords)
  const mark = oauth.nousSigninRefusal()
  check('the mark stands beside the credential and the refresh token is blanked, the token values untouched by the note', mark?.code === 'invalid_grant' && mark.status === 400 && oauth.nousStoredTokens()?.refreshToken === '' && !JSON.stringify(mark).includes('rt-fixture') && !readFileSync(oauth.nousAuthPathForDisplay(), 'utf8').includes('rt-fixture-4'), JSON.stringify(mark))
  check('the usability resolver reads signed out with the line', !resolveProviderUsability().nous.usable && resolveProviderUsability().nous.blockers.some(b => b.startsWith(EXPIRED_LINE)), JSON.stringify(resolveProviderUsability().nous.blockers))
  check('/model reads the line', cat.getNousAvailability().state === 'disabled' && (cat.getNousAvailability() as { reason: string }).reason === EXPIRED_LINE, JSON.stringify(cat.getNousAvailability()))
  check('the backend reads the line', readinessForRoute('nous/anthropic/claude-sonnet-4.6').state === 'unavailable' && readinessForRoute('nous/anthropic/claude-sonnet-4.6').reason === EXPIRED_LINE, JSON.stringify(readinessForRoute('nous/anthropic/claude-sonnet-4.6')))
  const expiredSlot = deriveFamilySlotGroups().flatMap(g => g.slots).find(s => s.id === 'nous:signin')
  check('the slot reads the line, not signed in', expiredSlot?.signedIn === false && expiredSlot.stateNote === EXPIRED_LINE, JSON.stringify(expiredSlot))
  const deadTurn = await turn('nous/anthropic/claude-sonnet-4.6', 'Say OK')
  check('a turn refuses before any request with the line', deadTurn.captures.filter(c => c.path === '/v1/chat/completions').length === 0 && deadTurn.errors.length === 1 && deadTurn.errors[0]!.includes(EXPIRED_LINE), JSON.stringify(deadTurn.errors))
  const cold = await child('read')
  check('a cold second process reads the mark on every surface', (cold.refusal as { code?: string } | null)?.code === 'invalid_grant' && cold.usable === false && (cold.blockers as string[]).some(b => b.startsWith(EXPIRED_LINE)) && (cold.availability as { reason?: string }).reason === EXPIRED_LINE && cold.slotNote === EXPIRED_LINE && cold.slotSignedIn === false, JSON.stringify(cold))

  console.log('── the key leg stands beside the expired sign-in: a stored key wins and reads usable ──')
  const keyed = await login.storeNousApiKeyLogin(NOUS_FIXTURE_API_KEY)
  check('the key leg stores and reads the account as .30 shipped it', keyed.ok && keyed.receipt.startsWith('Nous Portal API key stored (auth-scoped, mode 600) · plan Plus (tier 2)'), keyed.receipt)
  check('with the key stored the family is usable again on the key', resolveProviderUsability().nous.usable && accounts.resolveNousAccount()?.kind === 'api-key' && resolveProviderUsability().nous.credential === 'api-key')
  const keyedTurn = await turn('nous/anthropic/claude-sonnet-4.6', 'Say OK')
  check('a turn rides the key', keyedTurn.errors.length === 0 && keyedTurn.captures.find(c => c.path === '/v1/chat/completions')?.headers.authorization === `Bearer ${NOUS_FIXTURE_API_KEY}`)
  const slotOf = (id: string) => deriveFamilySlotGroups().flatMap(g => g.slots).find(s => s.id === id)
  const removeSlot = (id: string): void => { const found = slotOf(id); if (found) executeSlotRemoval(found) }
  removeSlot('nous:stored-key')
  check('removing the key leaves the expired sign-in, still signed out', slotOf('nous:stored-key') === undefined && !resolveProviderUsability().nous.usable && accounts.resolveNousAccount()?.expired === true, JSON.stringify(deriveFamilySlotGroups().flatMap(g => g.slots).filter(s => s.family === 'nous').map(s => s.id)))
  removeSlot('nous:signin')
  check('forgetting the sign-in clears the pair and the mark', oauth.nousStoredTokens() === undefined && oauth.nousSigninRefusal() === undefined && accounts.resolveNousAccount() === undefined)

  console.log('── a new sign-in after the mark clears it ──')
  fixture.oauth.outcome = 'approved'
  const again = await signIn()
  check('the second sign-in stores a fresh pair with no mark', again.outcome.ok && oauth.nousStoredTokens()?.refreshToken === 'rt-fixture-5' && oauth.nousSigninRefusal() === undefined && resolveProviderUsability().nous.usable, again.outcome.receipt)
  removeSlot('nous:signin')

  console.log('── the failure roads each end at the key leg with one plain line ──')
  fixture.oauth.outcome = 'denied'
  const denied = await signIn()
  check('declined in the browser: one line, nothing stored, the key leg offered', !denied.outcome.ok && denied.outcome.receipt === `Nous Portal sign-in was declined in the browser — nothing stored. ${OFFER}` && oauth.nousStoredTokens() === undefined, denied.outcome.receipt)
  fixture.oauth.outcome = 'expired'
  const expired = await signIn()
  check('an expired code: one line, nothing stored, the key leg offered', !expired.outcome.ok && expired.outcome.receipt === `Nous Portal sign-in code expired before it was approved — nothing stored. ${OFFER}` && oauth.nousStoredTokens() === undefined, expired.outcome.receipt)
  fixture.oauth.outcome = 'approved'
  fixture.oauth.clientIds.clear()
  const refusedId = await signIn()
  check('a refused client id: the Portal\'s own words in one line, nothing stored, the key leg offered', !refusedId.outcome.ok && refusedId.outcome.receipt.startsWith('Nous Portal sign-in could not start: the Portal refused the sign-in request (HTTP 400: Unsupported OAuth client_id') && refusedId.outcome.receipt.endsWith(OFFER) && oauth.nousStoredTokens() === undefined && refusedId.captures.filter(c => c.path === '/api/oauth/token').length === 0, refusedId.outcome.receipt)
  fixture.oauth.clientIds.add(NOUS_FIXTURE_CLIENT_ID)
  fixture.oauth.startStatus = 503
  const down = await signIn()
  check('a Portal fault at start: one line, nothing stored, the key leg offered', !down.outcome.ok && down.outcome.receipt.includes('HTTP 503') && down.outcome.receipt.endsWith(OFFER) && oauth.nousStoredTokens() === undefined, down.outcome.receipt)
  fixture.oauth.startStatus = 200
  const savedPortal = process.env.MERCURY_NOUS_PORTAL_BASE
  process.env.MERCURY_NOUS_PORTAL_BASE = 'http://127.0.0.1:1'
  const unreachable = await signIn()
  check('an unreachable Portal: one line, nothing stored, the key leg offered', !unreachable.outcome.ok && unreachable.outcome.receipt === `Nous Portal sign-in could not start: the Nous Portal did not answer — nothing stored. ${OFFER}`, unreachable.outcome.receipt)
  process.env.MERCURY_NOUS_PORTAL_BASE = savedPortal
  const cancelledRun = await login.runNousDeviceLogin({ sleep: ms => sleep(Math.min(ms, 20)), cancelled: () => true })
  check('a cancel before the start: nothing stored, the key leg offered', !cancelledRun.ok && cancelledRun.receipt === `Nous Portal sign-in cancelled — nothing stored. ${OFFER}`, cancelledRun.receipt)
  check('every failure line is one sentence of plain words naming no other product, the Portal\'s echoed client id included', [denied, expired, refusedId, down, unreachable].every(r => !/hermes|\n|stack|Error:/i.test(r.outcome.receipt)), [denied, expired, refusedId, down, unreachable].map(r => r.outcome.receipt).join(' | '))

  console.log('── the env key wins over a stored sign-in ──')
  const third = await signIn()
  process.env.NOUS_API_KEY = NOUS_FIXTURE_API_KEY
  check('NOUS_API_KEY wins over the sign-in on every read', third.outcome.ok && accounts.resolveNousAccount()?.label === 'NOUS_API_KEY (env)' && accounts.resolveNousCredentialSnapshot()?.source === 'env' && deriveFamilySlotGroups().flatMap(g => g.slots).find(s => s.id === 'nous:signin')?.active === false)
  delete process.env.NOUS_API_KEY
  check('without the env pin the sign-in is active again', accounts.resolveNousAccount()?.kind === 'signin')
} finally {
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
console.log(failures === 0 ? `\nNOUS SIGN-IN GREEN (${passes} checks; loopback fixture, no live host)` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
