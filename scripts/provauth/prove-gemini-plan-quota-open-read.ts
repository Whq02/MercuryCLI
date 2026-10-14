#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.GOOGLE_API_KEY
delete process.env.GEMINI_API_KEY
delete process.env.MERCURY_GEMINI_OAUTH_CLIENT_ID
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
delete process.env.MERCURY_USAGE_POLL_MS

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const within = <T,>(promise: Promise<T>, ms = 4000): Promise<T | 'timed-out'> =>
  Promise.race([promise, new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), ms))])

const PRO = { id: 'g1-pro-tier', name: 'Google AI Pro' }
const FREE = { id: 'free-tier', name: 'Free', isDefault: true }
const assist = {
  rosterReads: 0,
  rosterStatus: 200,
  remaining: 0.8,
  roster(): Record<string, Record<string, unknown>> {
    return {
      'gemini-4-argon-high': { displayName: 'Gemini 4 Argon', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: { remainingFraction: this.remaining, resetTime: '2026-10-15T00:00:00Z' } },
      'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: { remainingFraction: 0.77, resetTime: '2026-10-15T00:00:00Z' } },
    }
  },
}
let serial = 0
const googleServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/token') {
      serial += 1
      return Response.json({ access_token: `ya29.plan-${serial}`, refresh_token: `1//refresh-${serial}`, expires_in: 3600, scope: 'x', token_type: 'Bearer' })
    }
    if (url.pathname.startsWith('/oauth2/v1/userinfo')) return Response.json({ email: 'plan@example.invalid', verified_email: true })
    return new Response('not found', { status: 404 })
  },
})
const assistServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (!(req.headers.get('authorization') ?? '').startsWith('Bearer ya29.plan-')) return Response.json({ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }, { status: 401 })
    if (url.pathname === '/v1internal:loadCodeAssist') return Response.json({ currentTier: PRO, paidTier: PRO, allowedTiers: [FREE, PRO], cloudaicompanionProject: 'project-fixture-123' })
    if (url.pathname === '/v1internal:fetchAvailableModels') {
      assist.rosterReads += 1
      if (assist.rosterStatus !== 200) return Response.json({ error: { code: assist.rosterStatus, message: 'roster refused', status: 'PERMISSION_DENIED' } }, { status: assist.rosterStatus })
      return Response.json({ models: assist.roster(), imageGenerationModelIds: [], agentModelSorts: [] })
    }
    return new Response('not found', { status: 404 })
  },
})
const googleBase = `http://127.0.0.1:${googleServer.port}`
const assistBase = `http://127.0.0.1:${assistServer.port}`
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = `${googleBase}/token`
process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = `${googleBase}/auth`
process.env.MERCURY_GOOGLE_USERINFO_BASE = googleBase
process.env.MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE = assistBase
process.env.MERCURY_ANTIGRAVITY_MANIFEST_BASE = 'https://example.invalid'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const accounts = await import('../../src/services/providers/gemini/geminiAccounts.ts')
const catalogue = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const owner = await import('../../src/services/providers/providerUsage.ts')
const freshness = await import('../../src/services/providers/usageFreshness.ts')
const sleep = async (): Promise<void> => {}

async function signIn(): Promise<'resolved' | 'rejected' | 'timed-out'> {
  const handles = accounts.beginGeminiPlanBrowserConnect({ skipBrowserOpen: true, loopbackPort: 0, sleep })
  await new Promise(resolve => setTimeout(resolve, 30))
  const port = handles.boundLoopbackPort()
  const state = new URL(handles.authorizeUrl).searchParams.get('state') ?? ''
  if (port === undefined) return 'timed-out'
  await within(fetch(`http://127.0.0.1:${port}/oauth-callback?code=OK&state=${encodeURIComponent(state)}`))
  const flow = await within(handles.result.then(() => 'resolved' as const, () => 'rejected' as const))
  return flow
}

const quotaOf = (): { value?: string; observedAtMs?: number; stamp?: string; note?: string } => {
  const view = owner.usageForProvider('gemini')
  const figure = view.figures?.find(f => f.key === 'plan-quota:gemini-4-argon-high')
  return {
    ...(figure?.value !== undefined ? { value: figure.value } : {}),
    ...(figure?.observedAtMs !== undefined ? { observedAtMs: figure.observedAtMs } : {}),
    ...(figure !== undefined ? { stamp: freshness.usageSourceWords(figure) } : {}),
    ...(view.readerNote !== undefined ? { note: view.readerNote } : {}),
  }
}
const SIX_HOURS = 6 * 3_600_000
function ageTheLastRead(): void {
  const snapshot = catalogue.getCachedGeminiCatalogue('plan')
  if (snapshot !== null) snapshot.fetchedAtMs -= SIX_HOURS
}

try {
  console.log('── a Google sign-in holds the plan; the roster read with it carries the quota rows ──')
  writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1 }), { mode: 0o600 })
  check('the sign-in resolves and the plan is the active source', (await signIn()) === 'resolved' && accounts.resolveGeminiAccount()?.kind === 'plan')
  const first = await catalogue.refreshGeminiCatalogue('plan', { force: true })
  const readsAfterFirst = assist.rosterReads
  check('the first roster read lands the quota row', first?.models.some(m => m.id === 'gemini-4-argon-high' && m.quota?.remainingFraction === 0.8) === true && quotaOf().value === '80%', j(quotaOf()))

  console.log('── the popup opens: one read through the owner\'s door, bounded by the one floor every family honours ──')
  const floor = freshness.usagePollTtlMs()
  check('the floor is the endpoint readers\' one floor (60 s) and the quota figures read stale past twice it, as every endpoint figure does', floor === 60_000 && freshness.usageStaleAfterMs() === 120_000 && quotaOf().stamp === 'endpoint-fed · read 0 s ago', j({ floor, stale: freshness.usageStaleAfterMs(), stamp: quotaOf().stamp }))
  await owner.refreshProviderUsage('gemini', { reason: 'open' })
  check('an open inside the floor serves the last observation — no roster request', assist.rosterReads === readsAfterFirst, String(assist.rosterReads - readsAfterFirst))
  ageTheLastRead()
  check("the owner's shape: a roster read six hours ago paints as stale with its age", quotaOf().stamp === 'endpoint-fed · stale · last read 6 h ago', j(quotaOf()))
  assist.remaining = 0.42
  await owner.refreshProviderUsage('gemini', { reason: 'open' })
  const reread = quotaOf()
  check('an open past the floor reads the roster once (the catalogue\'s own 5-minute horizon notwithstanding) and the quota row moves with it, the stamp reading the new read', assist.rosterReads === readsAfterFirst + 1 && reread.value === '42%' && (reread.observedAtMs ?? 0) >= Date.now() - 5_000 && reread.stamp === 'endpoint-fed · read 0 s ago' && reread.note === undefined, j(reread))
  await owner.refreshProviderUsage('gemini', { reason: 'open' })
  check('a second open at once makes no second request (the floor)', assist.rosterReads === readsAfterFirst + 1, String(assist.rosterReads - readsAfterFirst))
  assist.remaining = 0.4
  await owner.refreshProviderUsage('gemini', { reason: 'operator' })
  check('the operator\'s own ask is never refused for the floor', assist.rosterReads === readsAfterFirst + 2 && quotaOf().value === '40%', j({ reads: assist.rosterReads - readsAfterFirst, value: quotaOf().value }))
  await owner.refreshProviderUsage('gemini', { reason: 'sign-in' })
  check('a sign-in moves the account: the roster is read at once', assist.rosterReads === readsAfterFirst + 3, String(assist.rosterReads - readsAfterFirst))

  console.log('── a refused roster: the last figures stand with their age, and the refusal is said in Google\'s words ──')
  assist.rosterStatus = 403
  ageTheLastRead()
  const beforeRefusal = quotaOf()
  await owner.refreshProviderUsage('gemini', { reason: 'open' })
  const refused = quotaOf()
  check('the refused read made one request, kept the last quota row with its age, and the owner names the refusal', assist.rosterReads === readsAfterFirst + 4 && refused.value === beforeRefusal.value && refused.observedAtMs === beforeRefusal.observedAtMs && refused.stamp === 'endpoint-fed · stale · last read 6 h ago' && refused.note === "no quota read (Google's Code Assist roster refused the credential (HTTP 403))", j(refused))
  await owner.refreshProviderUsage('gemini', { reason: 'open' })
  check('an open inside the floor after a failure does not re-ask', assist.rosterReads === readsAfterFirst + 4, String(assist.rosterReads - readsAfterFirst))
  assist.rosterStatus = 200
  await owner.refreshProviderUsage('gemini', { reason: 'operator' })
  check('the next successful read clears the refusal and the stamp reads the new read', assist.rosterReads === readsAfterFirst + 5 && quotaOf().note === undefined && quotaOf().value === '40%' && quotaOf().stamp === 'endpoint-fed · read 0 s ago', j(quotaOf()))

  console.log('── the source law: the section rides the one door; the door has the Gemini arm ──')
  const usageTsx = read('src/components/Settings/Usage.tsx')
  const wrapper = usageTsx.slice(usageTsx.indexOf('function EngineUsageSection('), usageTsx.indexOf("if (section.id === 'gemini') return <GeminiUsageSection"))
  check("every family section, the Gemini one included, asks the owner's door once on mount through the one wrapper hook", wrapper.includes('const usage = useOwnerUsage(section.id, section.family.credentialed)') && usageTsx.includes("if (section.id === 'gemini') return <GeminiUsageSection") && (usageTsx.match(/useOwnerUsage\('gemini'/g) ?? []).length === 0)
  check('the section and the compact lines paint the reader\'s note when a read was refused', usageTsx.includes('{planActive && usage.readerNote !== undefined ? <Text dimColor>{usage.readerNote}</Text> : null}') && usageTsx.includes("(section.id === 'openrouter' || section.id === 'gemini') && usage.readerNote !== undefined"))
  const ownerSrc = read('src/services/providers/providerUsage.ts')
  check('the refresh door carries a gemini arm that reads the plan quota', /case 'gemini': \{\s*const \{ refreshGeminiPlanQuota \}/.test(ownerSrc))

  console.log('── a key lane has no plan quota: the door reads nothing ──')
  accounts.disconnectGeminiPlan()
  process.env.GEMINI_API_KEY = 'AIza-fixture-key-not-real'
  const readsBeforeKey = assist.rosterReads
  await owner.refreshProviderUsage('gemini', { reason: 'operator' })
  check('with a key as the active source the door makes no roster request', accounts.resolveGeminiAccount()?.kind === 'api-key' && assist.rosterReads === readsBeforeKey, j({ kind: accounts.resolveGeminiAccount()?.kind, reads: assist.rosterReads - readsBeforeKey }))
} finally {
  googleServer.stop(true)
  assistServer.stop(true)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-gemini-plan-quota-open-read (${passes} pass, ${failures} fail)`)
process.exit(failures === 0 ? 0 : 1)
