#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'one-credential-wall-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
delete process.env.NODE_ENV
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.OPENROUTER_API_KEY
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const J = (...parts: string[]): string => parts.join('')

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { classifyCredentialWall, credentialWallLine, reconnectDoorFor } = await import('../../src/services/providers/credentialWall.ts')
const { providerDisplayName } = await import('../../src/services/providers/routeLaw.ts')
const { clearOAuthTokenCache, __resetKnownDeadRefreshTokensForTest } = await import('../../src/utils/auth.ts')

const FAMILIES = ['anthropic', 'openai', 'zai', 'moonshot', 'deepseek', 'xai', 'meta', 'openai-compat', 'openrouter', 'gemini', 'huggingface', 'local', 'mistral', 'nous', 'zen']
const OWNER_WIRE = 'OAuth authentication is currently not allowed for this organization'
const EMAIL = 'owner@example.com'
const POSTURES: Array<{ name: string; opts: { nonInteractive?: boolean } }> = [
  { name: 'interactive', opts: {} },
  { name: 'headless', opts: { nonInteractive: true } },
]

const shapeOf = (route: string, line: string): string =>
  line.split(providerDisplayName(route)).join('<family>').split(reconnectDoorFor(route)).join('<door>')

console.log('§1 — the table: every family, every cause, both postures — one shape but for the name and the door')
{
  type Row = { status: number; wire: string; credential?: 'sign-in' | 'key'; cause: 'sign-in' | 'key-limit'; what: string }
  const ROWS: Row[] = [
    { status: 401, wire: '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked"}}', cause: 'sign-in', what: 'a revoked sign-in, the 401 spelling' },
    { status: 403, wire: 'OAuth token has been revoked', cause: 'sign-in', what: 'a revoked sign-in, the 403 spelling' },
    { status: 403, wire: OWNER_WIRE, credential: 'sign-in', cause: 'sign-in', what: "the owner's wire on a sign-in: the provider's own sentence, the status and the credential decide" },
    { status: 401, wire: 'the subscription behind this sign-in has lapsed', credential: 'sign-in', cause: 'sign-in', what: 'any 401 on a sign-in, whatever the sentence' },
    { status: 403, wire: '{"error":{"message":"Key limit exceeded","code":403}}', cause: 'key-limit', what: 'a key past its cap (403)' },
    { status: 402, wire: 'API key credit limit exceeded', cause: 'key-limit', what: 'a key past its cap (402)' },
  ]
  for (const posture of POSTURES) {
    for (const row of ROWS) {
      const shapes = new Set<string>()
      const lines: string[] = []
      for (const family of FAMILIES) {
        const cause = classifyCredentialWall(row.status, row.wire, row.credential)
        if (cause !== row.cause) {
          lines.push(`${family}: classified ${String(cause)}`)
          shapes.add(`MISCLASSIFIED ${family}`)
          continue
        }
        const line = credentialWallLine(family, cause, posture.opts)
        lines.push(`${family.padEnd(13)} ${line}`)
        shapes.add(shapeOf(family, line))
      }
      check(`${posture.name} · ${row.what} ⇒ ${row.cause}: one shape over ${FAMILIES.length} families`, shapes.size === 1, [...shapes].slice(0, 3).join(' | '))
      if (posture.name === 'interactive' && row.what.startsWith("the owner's")) for (const l of lines) console.log(`        ${l}`)
      const names = FAMILIES.filter(f => !lines.some(l => l.startsWith(f.padEnd(13)) && l.includes(providerDisplayName(f))))
      check(`${posture.name} · ${row.what}: every line names its family`, names.length === 0, names.join(', '))
    }
  }
  check('the shape names the family once and the door once, nothing else of the family', [...FAMILIES].every(f => shapeOf(f, credentialWallLine(f, 'sign-in')) === '<family> sign-in expired — switch providers (/model) or reconnect (<door>)'), shapeOf('zen', credentialWallLine('zen', 'sign-in')))
  check('the key-cap shape', FAMILIES.every(f => shapeOf(f, credentialWallLine(f, 'key-limit')) === '<family> key limit reached — switch providers (/model) or connect another key (<door>)'))
  check('the headless shape names the flag and the interactive door honestly', FAMILIES.every(f => shapeOf(f, credentialWallLine(f, 'sign-in', { nonInteractive: true })) === '<family> sign-in expired — switch providers (--model) or reconnect (<door>, in an interactive session)'))
  check('every door is one the product has: /logins <family> for the sign-in families, the key variable for the two without a sign-in leg', FAMILIES.every(f => reconnectDoorFor(f) === (f === 'openai-compat' ? 'MERCURY_COMPAT_API_KEY' : f === 'local' ? 'MERCURY_LOCAL_API_KEY' : `/logins ${f}`)))
  check('no line carries a brace, a quote or the word organization in any family or posture', FAMILIES.every(f => POSTURES.every(p => (['sign-in', 'key-limit'] as const).every(c => !/[{}"]|organi[sz]ation/i.test(credentialWallLine(f, c, p.opts))))))

  check("a key's 401/403 that names no wall family is NOT a wall — its presenter names the variable", classifyCredentialWall(403, OWNER_WIRE, 'key') === undefined && classifyCredentialWall(401, 'invalid x-api-key', 'key') === undefined)
  check('no credential fact and no wall family ⇒ no wall (the pure two-fact reading stands)', classifyCredentialWall(403, OWNER_WIRE) === undefined && classifyCredentialWall(401, 'OAuth token expired') === undefined)
  check('a sign-in on a 402 is no wall by credential alone (the credit status keeps its presenter)', classifyCredentialWall(402, 'payment required', 'sign-in') === undefined)
  check('a 429 or a 500 on a sign-in is never a wall', classifyCredentialWall(429, OWNER_WIRE, 'sign-in') === undefined && classifyCredentialWall(500, OWNER_WIRE, 'sign-in') === undefined)
  check("a key past its cap stays the key wall even on a sign-in credential (the provider's words outrank the fact)", classifyCredentialWall(403, 'Key limit exceeded', 'sign-in') === 'key-limit')
}

console.log("§2 — the owner's wire: the first-party presenter paints the shared line with the account, never a sentence about an organisation")
{
  const { APIError } = await import('../../src/services/api/sdkErrors.js')
  const { getAssistantMessageFromError, API_ERROR_MESSAGE_PREFIX } = await import('../../src/services/api/errors.ts')
  const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
  const { isClaudeAISubscriber } = await import('../../src/utils/auth.ts')
  const credsPath = join(HOME, '.credentials.json')
  const seed = (oauth: Record<string, unknown> | null): void => {
    __resetKnownDeadRefreshTokensForTest()
    clearOAuthTokenCache()
    writeFileSync(credsPath, JSON.stringify(oauth === null ? {} : { claudeAiOauth: oauth }))
    clearOAuthTokenCache()
  }
  const LIVE_SIGN_IN = { accessToken: 'at-live', refreshToken: 'rt-alive', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null }
  const textOf = (m: { message: { content: unknown } }): string =>
    (m.message.content as Array<{ type?: string; text?: string }>).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
  const mk = (status: number, type: string, message: string) =>
    new APIError(status, { type: 'error', error: { type, message } }, undefined, undefined as never)

  saveGlobalConfig((current: Record<string, unknown>) => ({ ...current, oauthAccount: { accountUuid: 'uuid-owner-fixture', emailAddress: EMAIL, organizationUuid: 'org-owner-fixture' } }))
  seed(LIVE_SIGN_IN)
  check('the fixture seats a live Claude subscription sign-in', isClaudeAISubscriber() === true)
  const owner403 = mk(403, 'permission_error', OWNER_WIRE)
  check("the fixture carries the owner's wire (status + envelope in the SDK message)", owner403.message === `403 {"type":"error","error":{"type":"permission_error","message":"${OWNER_WIRE}"}}`, owner403.message)

  setIsInteractive(true)
  const row = getAssistantMessageFromError(owner403, 'claude-opus-5')
  const painted = textOf(row as never)
  console.log(`        interactive: ${painted}`)
  check('the 403 paints the shared sign-in line with the account, under the error-row prefix', painted === `${API_ERROR_MESSAGE_PREFIX}: ${credentialWallLine('anthropic', 'sign-in')} · account ${EMAIL}`, painted)
  check('never the word organization (nor account-has-no-access, nor contact-your-administrator)', !/organi[sz]ation|does not have access|administrator/i.test(painted), painted)
  check('POISON: no brace, no quote, no envelope word, no status on the row', !/[{}"]/.test(painted) && !painted.includes('permission_error') && !painted.includes('403'))
  check('typed authentication_failed, no errorDetails (the wire goes to the debug log only)', (row as { error?: string }).error === 'authentication_failed' && (row as { errorDetails?: unknown }).errorDetails === undefined)
  const painted401 = textOf(getAssistantMessageFromError(mk(401, 'authentication_error', OWNER_WIRE), 'claude-opus-5') as never)
  check('the 401 spelling paints the SAME line', painted401 === painted, painted401)

  setIsInteractive(false)
  const headless = textOf(getAssistantMessageFromError(owner403, 'claude-opus-5') as never)
  console.log(`        headless:    ${headless}`)
  check('headless: the shared headless spelling with the account', headless === `${API_ERROR_MESSAGE_PREFIX}: ${credentialWallLine('anthropic', 'sign-in', { nonInteractive: true })} · account ${EMAIL}`, headless)
  check('headless: never the word organization', !/organi[sz]ation|does not have access|administrator/i.test(headless), headless)
  setIsInteractive(true)

  seed(null)
  check('the fixture seats no sign-in', isClaudeAISubscriber() === false)
  const noSignIn = textOf(getAssistantMessageFromError(owner403, 'claude-opus-5') as never)
  check('with no sign-in seated the same wire never claims "sign-in expired" (no false attribution) and no Mercury sentence about an organisation is spoken', !noSignIn.includes('sign-in expired') && !/does not have access|administrator/i.test(noSignIn), noSignIn)
  check("…the row is the generic tail: Anthropic's own sentence, attributed, typed authentication_failed", noSignIn.includes('Anthropic says:') && (getAssistantMessageFromError(owner403, 'claude-opus-5') as { error?: string }).error === 'authentication_failed', noSignIn)
  saveGlobalConfig((current: Record<string, unknown>) => ({ ...current, oauthAccount: undefined }))
}

console.log("§3 — the compat door: OpenRouter's real client answers the table's shape")
{
  const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
  const body = JSON.stringify({ error: { message: 'Key limit exceeded', code: 403 } })
  const fetchImpl = (async () => new Response(body, { status: 403, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  let fault: { status?: number; message: string } | undefined
  for await (const ev of streamCompatChat({
    apiKey: 'fixture',
    url: 'https://openrouter.invalid/api/v1/chat/completions',
    request: { model: 'openai/gpt-x', messages: [{ role: 'user', content: 'hi' }] },
    fetchImpl,
  })) {
    if (ev.type === 'stream-fault') fault = ev.fault
  }
  const cause = fault === undefined ? undefined : classifyCredentialWall(fault.status, fault.message)
  check('the real client folds the 403 into a fault the classifier reads as the key wall', cause === 'key-limit', JSON.stringify(fault))
  const line = cause === undefined ? '' : credentialWallLine('openrouter', cause)
  check("the compat seam's line is the table's OpenRouter row", shapeOf('openrouter', line) === '<family> key limit reached — switch providers (/model) or connect another key (<door>)' && line.includes('OpenRouter') && line.includes('/logins openrouter'), line)
  const seam = read('src/services/providers/openaicompat/compatChatCallModel.ts')
  check('source: the compat seam reads the shared classifier and paints the shared line for its lane', seam.includes("classifyCredentialWall(outcome.fault.status, outcome.fault.message, recovery !== undefined ? 'sign-in' : undefined)") && seam.includes('credentialWallLine(profile.lane, wall)'))
}

console.log('§4 — the source: the Anthropic-only machinery is gone; one classifier, fed the credential')
{
  const errors = read('src/services/api/errors.ts')
  const painter = read('src/components/messages/AssistantTextMessage.tsx')
  const noComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const errorsCode = noComments(errors)
  check('the presenter hands the classifier the credential the wire carried', errorsCode.includes('classifyCredentialWall(status, message, anthropicWireCredential(model, status))'))
  check('the organisation phrase and its branch are gone (no constant, no class string)', !errors.includes(J('OAUTH_ORG_NOT_', 'ALLOWED')) && !errors.includes(J('oauth_org_', 'not_allowed')) && !errorsCode.includes(J('not allowed for this ', 'organization')))
  check("no Mercury sentence about an organisation's access remains in the presenter", !/organi[sz]ation does not have access/i.test(errorsCode))
  check('the painter still owns the error styling of the key-refusal words it keeps', painter.includes(J('isInvalid', 'CredentialWords(text)')))
  check('the revoked-token constant and its getter are gone; the revoked phrase has no copy in the presenter (the classifier is its one home)', !errors.includes(J('TOKEN_REVOKED_', 'ERROR_MESSAGE')) && !errors.includes(J('getTokenRevoked', 'ErrorMessage')) && !/has been revoked/.test(errorsCode))
  check('no Mercury sentence about an account\'s access remains anywhere in the presenter or the painter', !/does not have access/i.test(errorsCode) && !/does not have access/i.test(noComments(painter)))
  check('the painter compares no retired constant (a wall line is an error-row prefix line like every other family\'s)', !painter.includes(J('TOKEN_REVOKED_', 'ERROR_MESSAGE')) && !painter.includes(J('ORG_DISABLED_', 'ERROR_MESSAGE')))
  check('the disabled-organisation constants and their 400 branch are gone', !errors.includes(J('ORG_DISABLED_', 'ERROR_MESSAGE')) && !errorsCode.includes(J('organization has been ', 'disabled')) && !errorsCode.includes(J('organization associated with ', 'ANTHROPIC_API_KEY')))
  check('the presenter decides from status and the credential, never from a sentence about organisations (no such word in its code)', !/organi[sz]ation/i.test(errorsCode))
}

console.log('§5 — a 400 Anthropic calls a disabled organisation is no longer detected by name: it paints what every family\'s unrecognised 400 paints — the generic row with the provider\'s own sentence inside it, no Mercury sentence of its own')
{
  const { APIError } = await import('../../src/services/api/sdkErrors.js')
  const { getAssistantMessageFromError, API_ERROR_MESSAGE_PREFIX } = await import('../../src/services/api/errors.ts')
  const { decodeApiErrorBlobMessage } = await import('../../src/services/api/errorUtils.ts')
  const SENTENCE = 'This organization has been disabled.'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-env-key-not-real'
  const row = getAssistantMessageFromError(new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: SENTENCE } }, undefined, undefined as never), 'claude-opus-5')
  delete process.env.ANTHROPIC_API_KEY
  const text = (row.message.content as Array<{ type?: string; text?: string }>).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
  console.log(`        env key, 400: ${text}`)
  check('the row is the generic error row under the prefix, not an authentication kind (no login flow opens)', text.startsWith(`${API_ERROR_MESSAGE_PREFIX} (400): `) && (row as { error?: string }).error !== 'authentication_failed', text)
  check("Anthropic's own sentence rides the row itself, the envelope never does (the card has nothing left to decode)", text === `${API_ERROR_MESSAGE_PREFIX} (400): Anthropic says: ${SENTENCE}` && !text.includes('{') && decodeApiErrorBlobMessage(text) === undefined, text)
  check('Mercury speaks no sentence of its own about the organisation or the variable', !/organi[sz]ation associated|Update or unset|use your subscription instead/i.test(text), text)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-one-credential-wall: ALL LAWS HOLD' : `prove-one-credential-wall: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
