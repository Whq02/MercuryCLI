#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
const SCRATCH_ROOT = process.env.MERCURY_CONFIG_DIR?.trim() || tmpdir()
mkdirSync(SCRATCH_ROOT, { recursive: true })
const HOME = mkdtempSync(join(SCRATCH_ROOT, 'sign-in-fresh-'))
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|XAI_|META_|MODEL_API_KEY$|HF_|HUGGINGFACE_|AWS_|AZURE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
Object.assign(process.env, {
  HOME,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_AUTH_SCOPE_DIR: HOME,
  MERCURY_HOME: HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_EVOLUTION_LEDGER: '0',
  TZ: 'UTC',
  LANG: 'en_GB.UTF-8',
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const NOW = Date.now()
const HOUR = 3_600_000
const DAY = 24 * HOUR

const tokenCalls: Array<{ grant: string | undefined; refresh: string | undefined }> = []
let grantVerdict: 'invalid_grant' | 'renew' = 'invalid_grant'
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/v1/oauth/token') {
      const body = (await request.json()) as Record<string, string | undefined>
      tokenCalls.push({ grant: body.grant_type, refresh: body.refresh_token })
      if (grantVerdict === 'invalid_grant') return Response.json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, { status: 400 })
      return Response.json({ access_token: 'renewed-access-0002', refresh_token: 'renewed-refresh-0002', expires_in: 8 * 3600, scope: 'user:inference user:profile', token_type: 'Bearer' })
    }
    return new Response(null, { status: 404 })
  },
})
process.env.MERCURY_ANTHROPIC_OAUTH_BASE = `http://127.0.0.1:${server.port}`

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}

const credentialsPath = join(HOME, '.credentials.json')
const writeCredentials = (claudeAiOauth: Record<string, unknown>): void => {
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth }, null, 2) + '\n', { mode: 0o600 })
}
const oauth = (over: Record<string, unknown>) => ({
  accessToken: 'fixture-access-0001',
  refreshToken: 'fixture-refresh-0001',
  expiresAt: NOW + 30 * DAY,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  ...over,
})
writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', theme: 'dark' }) + '\n')

const auth = await import('../../src/utils/auth.ts')
const fresh = await import('../../src/utils/accounts/signInFreshness.ts')
const ledger = await import('../../src/utils/accounts/signInLedger.ts')
const { credentialWallLineForModel } = await import('../../src/services/providers/credentialWall.ts')
const { promptBehindAuthWall } = await import('../../src/utils/messages/authWallHold.ts')
const { decideResend } = await import('../../src/hooks/useAuthWallHold.ts')
const { deriveFamilySlotGroups } = await import('../../src/services/providers/accountSlots.ts')
const { loginsGlance } = await import('../../src/components/BootLoginsScreen.tsx')
const { runHealthReport } = await import('../../src/utils/healthReport.ts')

const reread = (): void => {
  auth.clearOAuthTokenCache()
  auth.invalidateOnDiskChange()
}

section('§1 a valid sign-in: nothing new, no network')
writeCredentials(oauth({}))
reread()
{
  const verdict = await fresh.checkAnthropicSignInFresh()
  check('the state is valid and no probe ran', verdict.state === 'valid' && verdict.probed === false, JSON.stringify(verdict))
  check('the token endpoint was never called', tokenCalls.length === 0, String(tokenCalls.length))
  check('the boot glance keeps its standing words', loginsGlance(deriveFamilySlotGroups()).endsWith('signed in'), loginsGlance(deriveFamilySlotGroups()))
  check('no wall stands for an Anthropic model', credentialWallLineForModel('claude-sonnet-4-5') === undefined)
}

section('§2 a lapsed token with a dead refresh grant (the field case): the open-time check finds it before any prompt')
writeCredentials(oauth({ expiresAt: NOW - HOUR }))
reread()
auth.__resetKnownDeadRefreshTokensForTest()
{
  check('before the check, the estate reads the sign-in as alive (the W-01 silence: /health 3 minutes earlier flagged nothing)', auth.isAnthropicOAuthSignInExpired() === false)
  const epochBefore = ledger.signInLedgerEpoch()
  const verdict = await fresh.checkAnthropicSignInFresh()
  check('the check tried the refresh once (the only network call, and only because the expiry had passed)', tokenCalls.length === 1 && tokenCalls[0]?.grant === 'refresh_token', JSON.stringify(tokenCalls))
  check('the verdict is expired, probed', verdict.state === 'expired' && verdict.probed === true, JSON.stringify(verdict))
  check('the dead grant is blanked on disk, so every process reads the same fact', (JSON.parse(readFileSync(credentialsPath, 'utf8')) as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth.refreshToken === '')
  check('the sign-in epoch moved so the boot face re-reads', ledger.signInLedgerEpoch() > epochBefore)
  check('the estate now observes the wall', auth.isAnthropicOAuthSignInExpired() === true)
  check("the boot screen's Logins row says so (PROPOSED WORDS)", loginsGlance(deriveFamilySlotGroups()) === 'Anthropic sign-in expired — sign in again', loginsGlance(deriveFamilySlotGroups()))
  check('the composer gate carries the existing one line, unchanged', credentialWallLineForModel('claude-sonnet-4-5') === 'Anthropic sign-in expired — switch providers (/model) or reconnect (/logins anthropic)', credentialWallLineForModel('claude-sonnet-4-5'))
  const again = await fresh.checkAnthropicSignInFresh()
  check('a second check is local: expired without another network call', again.state === 'expired' && again.probed === false && tokenCalls.length === 1, JSON.stringify(again))
}

section('§3 /health names the expired sign-in (PROPOSED ROW WORDS) and renews a lapsed-but-live one')
{
  const report = await runHealthReport({ depth: 'fast' })
  const row = report.sections.flatMap(s => s.checks).find(c => c.id === 'auth-anthropic')
  check('the Anthropic row is a warning', row?.status === 'warn', JSON.stringify(row))
  check('its evidence ends in sign-in expired', row?.evidence.endsWith('— sign-in expired') === true, row?.evidence)
  check('its fix is the existing one line', row?.fix === 'Anthropic sign-in expired — switch providers (/model) or reconnect (/logins anthropic)', row?.fix)
  grantVerdict = 'renew'
  writeCredentials(oauth({ expiresAt: NOW - HOUR, refreshToken: 'fixture-refresh-0003' }))
  reread()
  auth.__resetKnownDeadRefreshTokensForTest()
  const renewed = await runHealthReport({ depth: 'fast' })
  const okRow = renewed.sections.flatMap(s => s.checks).find(c => c.id === 'auth-anthropic')
  check('a lapsed token whose refresh grant is alive is renewed by the check and the row is ok', okRow?.status === 'ok' && okRow.evidence === 'bearer token via claude.ai (renewed on this check)', JSON.stringify(okRow))
  check('the renewed pair is on disk', (JSON.parse(readFileSync(credentialsPath, 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken === 'renewed-access-0002')
  grantVerdict = 'invalid_grant'
}

section('§4 the prompt behind a sign-in wall is held, and sent again once /logins lands a credential')
const WALL_LINE = 'API Error: Anthropic sign-in expired — switch providers (--model) or reconnect (/logins anthropic, in an interactive session)'
const user = (uuid: string, text: string, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] }, ...extra })
const wall = (uuid: string) => ({ type: 'assistant', uuid, timestamp: new Date().toISOString(), isApiErrorMessage: true, error: 'authentication_failed', message: { id: 'err', role: 'assistant', type: 'message', content: [{ type: 'text', text: WALL_LINE }], usage: {}, model: 'fixture', stop_reason: null, stop_sequence: null } })
const reply = (uuid: string, text: string) => ({ type: 'assistant', uuid, timestamp: new Date().toISOString(), message: { id: uuid, role: 'assistant', type: 'message', content: [{ type: 'text', text }], usage: {}, model: 'fixture', stop_reason: null, stop_sequence: null } })
const system = (uuid: string) => ({ type: 'system', uuid, subtype: 'turn_duration', content: '1s', timestamp: new Date().toISOString() })
const BRIEF = 'اقرأ سندات الأرض في المجلد وابدأ بالجدول 🙏\n\nThen the long brief, three paragraphs.'
{
  const held = promptBehindAuthWall([user('u1', BRIEF), wall('e1'), system('s1')] as never)
  check('the prompt before the wall row is held, whole, with system rows after the wall ignored', held !== null && held.text === BRIEF && held.errorUuid === 'e1' && held.mode === 'prompt', JSON.stringify(held).slice(0, 100))
  check('a wall with a real reply between it and the prompt holds nothing (the prompt was answered)', promptBehindAuthWall([user('u1', BRIEF), reply('r1', 'partial answer'), wall('e1')] as never) === null)
  check('an ordinary turn holds nothing', promptBehindAuthWall([user('u1', BRIEF), reply('r1', 'answer')] as never) === null)
  check('an API error of another kind holds nothing', promptBehindAuthWall([user('u1', BRIEF), { ...wall('e1'), error: 'rate_limit' }] as never) === null)
  check('a meta user row is skipped on the walk back to the prompt', promptBehindAuthWall([user('u1', BRIEF), user('m1', '<system-reminder>x</system-reminder>', { isMeta: true }), wall('e1')] as never)?.text === BRIEF)
  const hold = { errorUuid: 'e1', text: BRIEF, mode: 'prompt' as const, epoch: 7, model: 'claude-sonnet-4-5' }
  check('after /logins with no credential landed (cancelled), the words stay in the composer', decideResend(hold, { door: 'logins', epoch: 7, model: hold.model, walled: false, composerText: BRIEF }) === 'keep')
  check('after /logins landed a credential but the wall still stands, keep', decideResend(hold, { door: 'logins', epoch: 8, model: hold.model, walled: true, composerText: BRIEF }) === 'keep')
  check('after /logins landed a credential and the wall is gone, the composer\'s unchanged words are sent again', decideResend(hold, { door: 'logins', epoch: 8, model: hold.model, walled: false, composerText: BRIEF }) === 'send')
  check('words the operator edited are theirs to send', decideResend(hold, { door: 'logins', epoch: 8, model: hold.model, walled: false, composerText: BRIEF + ' and more' }) === 'keep')
  check('/model to another family that is not walled sends them again', decideResend(hold, { door: 'model', epoch: 7, model: 'gpt-5.5', walled: false, composerText: BRIEF }) === 'send')
  check('/model closed on the same model keeps', decideResend(hold, { door: 'model', epoch: 7, model: hold.model, walled: false, composerText: BRIEF }) === 'keep')
  check('nothing held, nothing sent', decideResend(null, { door: 'logins', epoch: 8, model: hold.model, walled: false, composerText: BRIEF }) === 'none')
}

section('§5 the wiring: the chat restores the held words to an empty composer and rides the /logins and /model doors; the boot runs the check once')
{
  const chat = readFileSync(join(ROOT, 'src/screens/Chat.tsx'), 'utf8')
  check('Chat mounts the hold over the focused transcript with the composer and the effective model', chat.includes('useAuthWallHold(\n    messages,') && chat.includes("restore: (text: string) => setInputValue(text)"))
  check('the /logins and /model completions ask the hold to resend with the composer taken once (rearmed)', chat.includes("if (seatCommand.name === 'logins' || seatCommand.name === 'model') {") && chat.includes("authWallHold.afterDoor(seatCommand.name, hold => {\n            void onSubmitRef.current(hold.text, INERT_PROMPT_HELPERS, undefined, { rearmed: true });"))
  const setup = readFileSync(join(ROOT, 'src/setup.ts'), 'utf8')
  check('an interactive boot runs the sign-in check once at open', setup.includes('if (getIsInteractive() && !getIsNonInteractiveSession()) void signInsCheckedAtOpen()'))
  const health = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
  check('/health probes the OpenAI subscription the same way and names an expired one (PROPOSED ROW WORDS)', health.includes("evidence: 'ChatGPT subscription — sign-in expired'") && health.includes("credentialWallLine('openai', 'sign-in')"))
}

server.stop(true)
rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ prove-sign-in-checked-before-send GREEN' : `\n❌ prove-sign-in-checked-before-send RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
