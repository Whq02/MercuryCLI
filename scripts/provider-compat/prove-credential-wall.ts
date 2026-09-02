#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-credential-wall.ts — THE CREDENTIAL WALL
//  (ledger L25 + L23's inline arm, the operator's ruling): a credential
//  that fails MID-CHAT — a revoked sign-in, a key past its cap — paints the
//  estate's ONE honest line ("<Family> sign-in expired / key limit reached
//  — switch providers (/model) or reconnect (/logins <family>)"), never the
//  wire's raw JSON; the concourse's row receipt speaks the same words.
//
//   §1 the pure classifier — the two walls in every wire spelling; the
//      neighbours (a plain expired token, a bare 403, a 429) stay theirs;
//      the line's one spelling per cause; the reconnect doors.
//   §2 the first-party door — the SDK's 401 "OAuth access token has been
//      revoked" (the operator's blob, envelope and all), the older 403
//      spelling, and the OBSERVED-expired 401: each paints the line under
//      the error-row prefix. POISON: no brace, no envelope word, no
//      errorDetails on the row; a plain expired 401 keeps the generic
//      presenter (no false attribution — the auth-honesty pin's own law).
//   §3 the compat door — OpenRouter's 403 "Key limit exceeded" through the
//      REAL client (fixture fetch) → the typed fault → the wall → the line;
//      the terminal seam consults the owner BEFORE the fault text (source).
//   §4 the row receipt — the live composer's gate refuses a walled row with
//      the IDENTICAL line; the row's own states outrank it; a dead sign-in
//      in the credential store and a polled OpenRouter cap each derive the
//      line for a model id; the screen threads it per row (source).
//   §5 one truth — the /logins family words are ONE set in two files; the
//      row carries the record's model; the owner names no vendor by hand.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'credential-wall-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
// Every store this prover touches lives in scratch — pinned BEFORE any src
// import so a missed dir default can never reach the real home.
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
delete process.env.NODE_ENV
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
// STAMP-SIM before any src import (the prove-refresh-legs-user-agent
// precedent): the UA owners read the build stamp bare — the OP-4 pinned
// source shapes — so a raw-source drive of any request leg (the §3 compat
// stream, the §4 key poll) threw "MACRO is not defined" into the client's
// fault path and the pin's first run red on the runner, not the wall
// (the adjudication).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.OPENROUTER_API_KEY
// The polled-cap leg rides the catalogue door; a harness-wide traffic-off
// pin would refuse the fixture fetch before it answers.
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const {
  classifyCredentialWall,
  credentialWallLine,
  credentialWallLineForModel,
  isRevokedSignInText,
  observedCredentialWall,
  reconnectDoorFor,
} = await import('../../src/services/providers/credentialWall.ts')
const { clearOAuthTokenCache, __resetKnownDeadRefreshTokensForTest } = await import('../../src/utils/auth.ts')

const credsPath = join(HOME, '.credentials.json')
/** The credential store's states, exactly as the auth-honesty prover seeds them. */
const seed = (oauth: Record<string, unknown> | null): void => {
  __resetKnownDeadRefreshTokensForTest()
  clearOAuthTokenCache()
  writeFileSync(credsPath, JSON.stringify(oauth === null ? {} : { claudeAiOauth: oauth }))
  clearOAuthTokenCache()
}
const DEAD_SIGN_IN = { accessToken: 'at-dead', refreshToken: '', expiresAt: Date.now() - 60_000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null }
const REFRESHABLE_SIGN_IN = { accessToken: 'at-old', refreshToken: 'rt-alive', expiresAt: Date.now() - 60_000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null }

const SIGN_IN_LINE = 'Anthropic sign-in expired — switch providers (/model) or reconnect (/logins anthropic)'
const KEY_LIMIT_LINE = 'OpenRouter key limit reached — switch providers (/model) or connect another key (/logins openrouter)'
const OPERATOR_BLOB = '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked"}}'

// ── §1: the pure classifier and the line ────────────────────────────────────
console.log('§1 — the pure classifier: two walls in every wire spelling; the neighbours keep their own presenters')
{
  check("401 + \"OAuth access token has been revoked\" (the operator's blob) ⇒ sign-in", classifyCredentialWall(401, OPERATOR_BLOB) === 'sign-in')
  check('403 + "OAuth token has been revoked" (the older spelling) ⇒ sign-in', classifyCredentialWall(403, 'OAuth token has been revoked') === 'sign-in')
  check("403 + \"Key limit exceeded\" (OpenRouter's per-key cap) ⇒ key-limit", classifyCredentialWall(403, 'Key limit exceeded') === 'key-limit')
  check('402 + the cap phrase ⇒ key-limit (the credit status the same cap can ride)', classifyCredentialWall(402, 'key limit exceeded') === 'key-limit')
  check('401 + "OAuth token expired" is NOT a wall (the refresh lap owns it — no false attribution)', classifyCredentialWall(401, 'OAuth token expired') === undefined)
  check('a bare 403 names no wall', classifyCredentialWall(403, '403 {"error":"forbidden"}') === undefined)
  check('a 429 carrying the phrase is no wall (the status is part of the fact)', classifyCredentialWall(429, 'OAuth token has been revoked') === undefined)
  check('no status ⇒ no wall', classifyCredentialWall(undefined, 'OAuth token has been revoked') === undefined)
  check('the class-string needle reads both spellings and not the expired one', isRevokedSignInText('OAuth access token has been revoked') && isRevokedSignInText('OAuth token has been revoked') && !isRevokedSignInText('OAuth token expired'))
  // THE SHAPE LAW (the lead's, on this lane's specimen): a wall is a status
  // class plus a phrase FAMILY — the next spelling drift must not reopen
  // the hole. Both real payloads, then the drifts the wire may serve.
  const OPENROUTER_BLOB = '403 {"error":{"message":"Key limit exceeded","code":403}}'
  check("the REAL OpenRouter payload (envelope and all) ⇒ key-limit", classifyCredentialWall(403, OPENROUTER_BLOB) === 'key-limit')
  check('drift: 401 + "access token was revoked" ⇒ sign-in', classifyCredentialWall(401, 'access token was revoked') === 'sign-in')
  check('drift: 403 + "Revoked token." (reversed order, capitalised) ⇒ sign-in', classifyCredentialWall(403, 'Revoked token.') === 'sign-in')
  check('drift: 401 + "The OAuth token is revoked; sign in again" ⇒ sign-in', classifyCredentialWall(401, 'The OAuth token is revoked; sign in again') === 'sign-in')
  check('drift: 403 + "key limit reached" ⇒ key-limit', classifyCredentialWall(403, 'key limit reached') === 'key-limit')
  check('drift: 403 + "API key credit limit exceeded" ⇒ key-limit', classifyCredentialWall(403, 'API key credit limit exceeded') === 'key-limit')
  check('drift: 401 + "Key quota hit for this key" ⇒ key-limit (the auth status the cap may ride)', classifyCredentialWall(401, 'Key quota hit for this key') === 'key-limit')
  check('fence: 403 + "rate limit exceeded" is NOT a wall (no KEY word — a 429\'s sentence on the wrong status)', classifyCredentialWall(403, 'rate limit exceeded') === undefined)
  check('fence: 429 + "API key limit exceeded" is NOT a wall (the status class keeps rate limits out)', classifyCredentialWall(429, 'API key limit exceeded') === undefined)
  check('fence: 401 + "token expired; the refresh token is still valid" is NOT a wall (EXPIRED is the refresh lap\'s word)', classifyCredentialWall(401, 'token expired; the refresh token is still valid') === undefined)
  check('fence: the two words must share one clause — "token" in one sentence and "revoked" in the next is no wall', classifyCredentialWall(401, 'Invalid token. Access to this organization was revoked') === undefined)
  check('fence: a 500 carrying the phrase is no wall', classifyCredentialWall(500, 'OAuth token has been revoked') === undefined)
  // One needle, every reader: the retry ladder's fail-fast and the OAuth
  // 401-retry read the SAME family — no second spelling lives anywhere.
  const retrySrc = read('src/services/api/withRetry.ts')
  const httpSrc = read('src/utils/http.ts')
  check('the retry ladder reads the shared family (no phrase copy of its own)', retrySrc.includes('isRevokedSignInText(errorMessage(error))') && !retrySrc.includes("'OAuth token has been revoked'"))
  check('the OAuth 401-retry reads the shared family (no phrase copy of its own)', httpSrc.includes('isRevokedSignInText(') && !httpSrc.includes("'OAuth token has been revoked'"))
  // The phrase keeps EXACTLY ONE home in the presenter file: the legacy
  // render leg getTokenRevokedErrorMessage (kept for persisted transcripts
  // and the export — the CARDFIX receipt's own documented keep). The live
  // doors read the classifier; a second phrase copy is the drift this
  // needle refuses. (Re-pinned: the original ban
  // contradicted the keep it shipped beside and red on its first run.)
  const errorsSrc = read('src/services/api/errors.ts')
  const keptAt = errorsSrc.indexOf('export function getTokenRevokedErrorMessage')
  check('the presenter and the compat seam read the classifier, never a phrase (one kept render-leg home)', (errorsSrc.match(/has been revoked/g) ?? []).length === 1 && keptAt > 0 && errorsSrc.slice(keptAt, keptAt + 300).includes('has been revoked') && !read('src/services/providers/openaicompat/compatChatCallModel.ts').includes('has been revoked'))
  const signIn = credentialWallLine('anthropic', 'sign-in')
  check('the sign-in line: family · state · the switch door · the reconnect door', signIn === SIGN_IN_LINE, signIn)
  const cap = credentialWallLine('openrouter', 'key-limit')
  check('the key-limit line: family · state · the switch door · the key door', cap === KEY_LIMIT_LINE, cap)
  const headless = credentialWallLine('anthropic', 'sign-in', { nonInteractive: true })
  check('the headless spelling names the flag and the interactive door honestly', headless.includes('--model') && headless.includes('/logins anthropic') && headless.includes('interactive session') && !headless.includes('/model)'), headless)
  check('every family word gets its /logins door', ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek'].every(f => reconnectDoorFor(f) === `/logins ${f}`))
  check('the compat slot and the local lane name their key door (no /logins leg exists for them)', reconnectDoorFor('openai-compat') === '/router key compat' && reconnectDoorFor('local') === '/router key local')
  check('an unknown family still gets a door the product has', reconnectDoorFor('nowhere') === '/logins')
  check('the line never carries a brace or a quote in any cause', [signIn, cap, headless].every(l => !/[{}"]/.test(l)))
}

// ── §2: the first-party door ────────────────────────────────────────────────
console.log('§2 — the first-party door: the SDK presenter paints the line, never the envelope')
{
  const { APIError } = await import('@anthropic-ai/sdk')
  const { getAssistantMessageFromError, API_ERROR_MESSAGE_PREFIX } = await import('../../src/services/api/errors.ts')
  // The presenter derives its arm from the posture cell (bootstrap/state's
  // getIsNonInteractiveSession), and a bun proof process is non-interactive
  // by default — so the pin's first run painted the headless spellings
  // under checks written for the interactive ones (the
  // adjudication). These legs DRIVE the interactive arm; §1 already pins
  // the headless spellings through explicit { nonInteractive: true } calls.
  const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
  setIsInteractive(true)
  const textOf = (m: { message: { content: unknown } }): string => {
    const content = m.message.content as Array<{ type?: string; text?: string }>
    return content.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
  }
  const mk = (status: number, type: string, message: string) =>
    new APIError(status, { type: 'error', error: { type, message } }, undefined, undefined as never)

  const revoked401 = mk(401, 'authentication_error', 'OAuth access token has been revoked')
  check("the fixture carries the operator's blob (status + JSON envelope in the SDK message)", revoked401.message === OPERATOR_BLOB, revoked401.message)
  seed(null)
  const row = getAssistantMessageFromError(revoked401, 'claude-opus-5')
  const painted = textOf(row as never)
  check('401 revoked paints the ONE line under the error-row prefix', painted === `${API_ERROR_MESSAGE_PREFIX}: ${SIGN_IN_LINE}`, painted)
  check('POISON: no brace, no quote, no envelope word in the transcript row', !/[{}"]/.test(painted) && !painted.includes('authentication_error') && !painted.includes('401'))
  check('the row is typed authentication_failed and carries NO errorDetails (the payload lives in the debug log only)', (row as { error?: string }).error === 'authentication_failed' && (row as { errorDetails?: unknown }).errorDetails === undefined)
  const painted403 = textOf(getAssistantMessageFromError(mk(403, 'permission_error', 'OAuth token has been revoked'), 'claude-opus-5') as never)
  check('the older 403 spelling paints the SAME line (one owner)', painted403 === painted, painted403)

  // 22b — the OBSERVED-expired 401 (a dead refresh token) no longer carries
  // the envelope either; the auth-honesty needles hold.
  const expired401 = mk(401, 'authentication_error', 'OAuth token expired')
  seed(DEAD_SIGN_IN)
  const paintedExpired = textOf(getAssistantMessageFromError(expired401, 'claude-opus-5') as never)
  check('an OBSERVED-expired 401 speaks the same line ("Anthropic sign-in expired" + "/logins" — the auth-honesty needles)', paintedExpired === painted && paintedExpired.includes('Anthropic sign-in expired') && paintedExpired.includes('/logins'), paintedExpired)
  check('POISON: the observed-expired row carries no envelope either', !/[{}"]/.test(paintedExpired))
  seed(null)
  const plain401 = textOf(getAssistantMessageFromError(expired401, 'claude-opus-5') as never)
  check('a plain expired 401 with nothing observed keeps the generic presenter — no false "sign-in expired"', !plain401.includes('sign-in expired'), plain401.slice(0, 120))
  // The generic tail keeps the provider's SENTENCE and drops its envelope
  // (the same law, one status down the ladder): attributed, brace-free,
  // the error-row prefix spelling the painter recognises still leading.
  check('the generic 401 row carries the provider\'s sentence, attributed, under the recognised prefix', plain401 === `Please run /logins. ${API_ERROR_MESSAGE_PREFIX} (401): Anthropic says: OAuth token expired`, plain401)
  check('POISON: the generic tail carries no envelope either', !/[{}"]/.test(plain401) && !plain401.includes('authentication_error'))
  const bare403 = new APIError(403, undefined as never, 'forbidden', undefined as never)
  const painted403bare = textOf(getAssistantMessageFromError(bare403, 'claude-opus-5') as never)
  check('a body-less 403 shows the non-JSON tail verbatim, unattributed (it may be SDK text, not provider words)', painted403bare === `Please run /logins. ${API_ERROR_MESSAGE_PREFIX} (403): forbidden`, painted403bare)

  const src = read('src/services/api/errors.ts')
  const wallAt = src.indexOf('const wall = classifyCredentialWall(status, message)')
  // Anchor without the closing period: the source comment grew into a
  // sentence ("Generic 401/403 — the provider's own SENTENCE rides the
  // row") after this needle was written, so the dotted anchor missed and
  // the order check red with the order intact.
  const genericAt = src.indexOf('// 23. Generic 401/403')
  check('source: the wall branch sits BEFORE the observed-expired branch and the generic tail', wallAt > 0 && genericAt > wallAt && src.indexOf('isAnthropicOAuthSignInExpired()', wallAt) < genericAt)
  check('source: the payload goes to the debug log in both wall branches', src.slice(wallAt, genericAt).split('logForDebugging(').length - 1 >= 2)
  check('source: the presenter names no family by hand — routeOfModel + providerDisplayName speak', src.includes('credentialWallLine(routeOfModel(model)') && !src.includes("credentialWallLine('anthropic'"))
  check("source: the class string reads the shared needle (both spellings)", src.includes("if (isRevokedSignInText(message)) return 'token_revoked'"))
}

// ── §3: the compat door ─────────────────────────────────────────────────────
console.log('§3 — the compat door: OpenRouter\'s 403 "Key limit exceeded" through the real client → the line')
{
  const { streamCompatChat, mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
  const { compatFaultToTypedError, compatTerminalFaultText } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
  const { openrouterLaneProfile } = await import('../../src/services/providers/openrouter/openrouterCallModel.ts')
  const body = JSON.stringify({ error: { message: 'Key limit exceeded', code: 403 } })
  const fetchImpl = (async () =>
    new Response(body, { status: 403, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  let fault: import('../../src/services/providers/openaicompat/compatChatClient.ts').CompatFault | undefined
  for await (const ev of streamCompatChat({
    apiKey: 'fixture',
    url: 'https://openrouter.invalid/api/v1/chat/completions',
    request: { model: 'openai/gpt-x', messages: [{ role: 'user', content: 'hi' }] },
    fetchImpl,
  })) {
    if (ev.type === 'stream-fault') fault = ev.fault
  }
  check("the client folds the 403 body into a typed fault (message = the provider's sentence, status kept)", fault !== undefined && fault.status === 403 && fault.message === 'Key limit exceeded', JSON.stringify(fault))
  check('the fault classifies as the key-limit wall', fault !== undefined && classifyCredentialWall(fault.status, fault.message) === 'key-limit')
  check('the line the seam paints (POISON: no brace)', credentialWallLine('openrouter', 'key-limit') === KEY_LIMIT_LINE && !KEY_LIMIT_LINE.includes('{'))
  // Without the wall the seam spoke of a REJECTED CREDENTIAL — a cap is not
  // that; the wall outranks the fault text.
  const typed = fault === undefined ? 'unknown' : compatFaultToTypedError(fault as never)
  const old = fault === undefined ? '' : compatTerminalFaultText(openrouterLaneProfile, fault, typed as never)
  check('without the wall the seam called the cap a rejected credential — the wall outranks it', old.includes('rejected the credential'), old)
  const mapped = mapCompatHttpFailure(403, { error: { message: 'Key limit exceeded', code: 403 } })
  check('mapCompatHttpFailure agrees with the client (status 403 · the sentence · the wall)', mapped.status === 403 && mapped.message === 'Key limit exceeded' && classifyCredentialWall(mapped.status, mapped.message) === 'key-limit')

  const src = read('src/services/providers/openaicompat/compatChatCallModel.ts')
  const seamAt = src.indexOf('const wall = classifyCredentialWall(outcome.fault.status, outcome.fault.message)')
  const faultTextAt = src.indexOf('compatTerminalFaultText(profile, outcome.fault, typed', seamAt)
  const seam = seamAt > 0 && faultTextAt > seamAt ? src.slice(seamAt, faultTextAt) : ''
  check('source: the terminal seam consults the wall BEFORE the fault text and returns on it', seam !== '' && seam.includes('return'))
  check('source: the wall row carries no errorDetails (the payload goes to the debug log) and records the cap for the usability owner', seam.includes('logForDebugging(') && seam.includes('recordLaneBillingRefusal(profile.lane, { detail: wireSaid, remedy: line })') && !seam.includes('outcome.fault.code)'))
  check('source: the wall row is typed by cause (a cap is a credit fact, a revoked sign-in an auth fact)', seam.includes("wall === 'key-limit' ? 'billing_error' : 'authentication_failed'"))
}

// ── §4: the row receipt ─────────────────────────────────────────────────────
console.log("§4 — the row receipt: the live composer's gate speaks the identical line for a walled row")
{
  const { liveComposerGateOf } = await import('../../src/components/concourse/ConcourseScreen.tsx')
  type Row = import('../../src/components/concourse/contracts.ts').ConcourseRowV1
  const row = (over: Partial<Row> = {}): Row => ({
    sessionId: 's1',
    title: 'the walled chat',
    state: 'working',
    projectLabel: 'p',
    ownerLabel: null,
    ageLabel: null,
    seats: null,
    workspaceDir: '/w',
    modelId: 'claude-opus-5',
    ...over,
  })
  const gate = liveComposerGateOf(row(), false, 'live', SIGN_IN_LINE)
  check('a walled working row refuses the send with the IDENTICAL line (one owner, two doors)', gate.ok === false && (gate as { line: string }).line === SIGN_IN_LINE)
  check('no wall ⇒ the row accepts words as before (the placeholder names it)', liveComposerGateOf(row(), false, 'live').ok === true)
  check("the row's own states outrank the wall (a parked row keeps its parked line)", (liveComposerGateOf(row({ state: 'parked' }), false, 'live', SIGN_IN_LINE) as { line: string }).line.startsWith('parked —'))
  check('needs-you outranks the wall (asks are answered in the chat)', (liveComposerGateOf(row({ state: 'needs-you' }), false, 'live', SIGN_IN_LINE) as { line: string }).line === 'needs you · ↵↵ to answer')

  // The observed facts derive the line for a model id — the store, never a probe.
  seed(DEAD_SIGN_IN)
  check('a DEAD claude.ai sign-in observed in the store derives the sign-in line for a first-party model id', credentialWallLineForModel('claude-opus-5') === SIGN_IN_LINE, credentialWallLineForModel('claude-opus-5') ?? 'undefined')
  check("a legacy record key ('fable') routes home and reads the same wall", credentialWallLineForModel('fable') === SIGN_IN_LINE)
  seed(REFRESHABLE_SIGN_IN)
  check('a refreshable sign-in is NO wall (the recovery lap owns it)', credentialWallLineForModel('claude-opus-5') === undefined)
  seed(null)
  check("no sign-in at all is no wall here (the no-credential line is another owner's)", credentialWallLineForModel('claude-opus-5') === undefined && observedCredentialWall('anthropic') === undefined)
  check('a model id nobody carries derives nothing', credentialWallLineForModel(undefined) === undefined && credentialWallLineForModel('') === undefined)

  // The polled OpenRouter cap (openrouterUsageState's key truth).
  const { __resetOpenrouterUsageStateForTest, refreshOpenrouterKeyUsage } = await import('../../src/services/providers/openrouter/openrouterUsageState.ts')
  __resetOpenrouterUsageStateForTest()
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture'
  const capped = (async () =>
    new Response(JSON.stringify({ data: { label: 'fixture', limit: 10, limit_remaining: 0, usage: 10 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  const usage = await refreshOpenrouterKeyUsage({ force: true, fetchImpl: capped })
  check('the polled key truth states a reached cap (limit 10, remaining 0)', usage !== null && usage.limit === 10 && usage.limitRemaining === 0, JSON.stringify(usage))
  check('a reached cap derives the key-limit line for an openrouter-routed model id', credentialWallLineForModel('openrouter/openai/gpt-x') === KEY_LIMIT_LINE, credentialWallLineForModel('openrouter/openai/gpt-x') ?? 'undefined')
  __resetOpenrouterUsageStateForTest()
  check('nothing observed ⇒ no wall for the same id', credentialWallLineForModel('openrouter/openai/gpt-x') === undefined)
  // The seam's own record (the same process) derives it until a turn settles.
  const { recordLaneBillingRefusal, recordLaneTurnSettled, __resetLaneBillingStateForTest } = await import('../../src/services/providers/laneBillingState.ts')
  __resetLaneBillingStateForTest()
  recordLaneBillingRefusal('openrouter', { detail: 'http-403: Key limit exceeded', remedy: KEY_LIMIT_LINE })
  check("the seam's recorded key-limit refusal derives the line until a turn settles", credentialWallLineForModel('openrouter/openai/gpt-x') === KEY_LIMIT_LINE)
  recordLaneBillingRefusal('openrouter', { detail: 'http-402: insufficient credits', remedy: 'top up' })
  check('a plain credit refusal is NOT the key-limit wall (its own presenter speaks)', credentialWallLineForModel('openrouter/openai/gpt-x') === undefined)
  recordLaneTurnSettled('openrouter')
  __resetLaneBillingStateForTest()
  delete process.env.OPENROUTER_API_KEY

  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check("source: the screen derives the wall per snapshot beat from the row's model and hands it to the gate", screen.includes('credentialWallLineForModel(row.modelId)') && screen.includes('wallLineBySession.get(sel.sessionId)') && screen.includes('}, [sessionRows])'))
  check('source: the gate reads the wall AFTER the row states, before the accepting placeholder', (() => { const at = screen.indexOf("if (credentialWall !== undefined) return { ok: false, line: credentialWall }"); return at > screen.indexOf("if (sel.state === 'needs-you' || openAsk)") && at < screen.indexOf('return { ok: true, placeholder: `message ${sel.title}') })())
  check("source: the broadcast fan skips a walled row with the gate's line (the row receipt)", screen.includes('reason: `skipped — ${rowGate.line}`'))
}

// ── §5: one truth ───────────────────────────────────────────────────────────
console.log("§5 — one truth: the reconnect vocabulary, the row's model, no vendor by hand")
{
  const wallSrc = read('src/services/providers/credentialWall.ts')
  const workerSrc = read('src/services/concourse/workerModels.ts')
  const setOf = (src: string): string => {
    const m = /LOGINS_FAMILY_WORDS = new Set\(\[([^\]]+)\]\)/.exec(src)
    return m?.[1]?.replace(/\s/g, '') ?? ''
  }
  check("the /logins family words are ONE set in two files (the coordinator's refusal action and the wall's door)", setOf(wallSrc) !== '' && setOf(wallSrc) === setOf(workerSrc), `${setOf(wallSrc)} vs ${setOf(workerSrc)}`)
  check("the row contract declares the record's model and the snapshot fills it", read('src/components/concourse/contracts.ts').includes('modelId?: string') && read('src/services/concourse/concourseSnapshot.ts').includes('{ modelId: rec.modelKey }'))
  check('the wall owner names no vendor by hand — the family words come from providerDisplayName', !/'(Anthropic|OpenAI|OpenRouter|Claude)'/.test(wallSrc.replace(/\/\/.*$/gm, '')) && wallSrc.includes('providerDisplayName(route)'))
  check('the owner reads facts already observed — never a fetch, never a probe', !/fetch\(|refresh[A-Z]\w*\(/.test(wallSrc))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-credential-wall: ALL LAWS HOLD' : `\nprove-credential-wall: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
