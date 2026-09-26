#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'prove-zai-quota-decoder-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_ZAI_API_BASE = 'http://127.0.0.1:1/coding/paas/v4'
for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'HF_TOKEN', 'HUGGINGFACE_TOKEN']) delete process.env[name]
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function finish(): never {
  console.log(`\nzai quota decoder: ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

const ROOT = join(import.meta.dir, '..', '..')
const READER = 'src/services/providers/zai/zaiUsageState.ts'
const NOW = 1_790_000_000_000

const PRO_CAPTURE = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 17, nextResetTime: 1782724971179 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 3, nextResetTime: 1783305486997 },
      {
        type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 0, remaining: 1000, percentage: 0, nextResetTime: 1785292686976,
        usageDetails: [{ modelCode: 'search-prime', usage: 0 }, { modelCode: 'web-reader', usage: 0 }, { modelCode: 'zread', usage: 0 }],
      },
    ],
    level: 'pro',
  },
  success: true,
}
const LITE_CAPTURE = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 9855, remaining: 145, percentage: 98, nextResetTime: 1786685679998 },
    ],
    level: 'lite',
  },
  success: true,
}
const AUTH_MISSING = { code: 1001, msg: 'Authorization Token Missing', success: false }
const AUTH_FAILED = { code: 1000, msg: 'Authentication failed', success: false }
const PLAN_EXPIRED = { code: 1309, msg: 'The coding plan has expired', success: false }
const NO_PLAN = { code: 1234, msg: 'The current user has no coding plan', success: false }

section('§0 the reader exists')
const readerPresent = existsSync(join(ROOT, READER))
check(`the Z.ai quota reader exists (${READER})`, readerPresent, 'no such module on this tree: no Z.ai usage reader, the rail and /usage can print no window for GLM')
if (!readerPresent) finish()

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const reader = await import(join(ROOT, READER)) as typeof import('../../src/services/providers/zai/zaiUsageState.ts')
const owner = await import('../../src/services/providers/providerUsage.ts')

section('§1 the Pro capture (the TOKENS_LIMIT spelling): two credit windows and the tool-call quota')
{
  const quota = reader.decodeZaiQuota(PRO_CAPTURE, NOW)
  check('the capture decodes, stamped at the read time', quota !== undefined && quota.observedAtMs === NOW, JSON.stringify(quota))
  check("the tier rides as the wire's level", quota?.level === 'pro', quota?.level)
  const credit = quota?.windows.filter(w => w.kind === 'credit') ?? []
  check('the two TOKENS_LIMIT rows are credit windows: unit 3 × 5 = the 5-hour window, unit 6 × 1 = the week', credit.map(w => w.windowMinutes).join(',') === '300,10080', JSON.stringify(credit))
  check("each credit window's usedPct is the wire's percentage, not a division", credit.map(w => w.usedPct).join(',') === '17,3', JSON.stringify(credit))
  check('each credit window carries its epoch-millisecond reset verbatim', credit[0]?.resetsAtMs === 1782724971179 && credit[1]?.resetsAtMs === 1783305486997, JSON.stringify(credit))
  check('a credit row without usage/currentValue states no used, limit or remaining (never a guessed zero)', credit.every(w => w.used === undefined && w.limit === undefined && w.remaining === undefined), JSON.stringify(credit))
  const tools = quota?.windows.find(w => w.kind === 'tool-calls')
  check('the TIME_LIMIT row is the monthly tool-call quota: limit 1000, used 0, remaining 1000, 0%', tools !== undefined && tools.limit === 1000 && tools.used === 0 && tools.remaining === 1000 && tools.usedPct === 0 && tools.windowMinutes === 30 * 24 * 60, JSON.stringify(tools))
  check('its per-tool details ride by code', tools?.details?.map(d => `${d.code}:${d.used}`).join(',') === 'search-prime:0,web-reader:0,zread:0', JSON.stringify(tools?.details))
}

section('§2 the Lite capture (the CREDIT_LIMIT rename, the idle 5-hour row without a reset)')
{
  const quota = reader.decodeZaiQuota(LITE_CAPTURE, NOW)
  check("the tier is 'lite'", quota?.level === 'lite', quota?.level)
  const credit = quota?.windows.filter(w => w.kind === 'credit') ?? []
  check('the CREDIT_LIMIT spelling decodes to the same two credit windows', credit.map(w => w.windowMinutes).join(',') === '300,10080', JSON.stringify(credit))
  check('the idle 5-hour row keeps its 0% and its stated budget, with NO reset (the wire stated none)', credit[0]?.usedPct === 0 && credit[0]?.limit === 2000 && credit[0]?.used === 0 && credit[0]?.remaining === 2000 && credit[0]?.resetsAtMs === undefined, JSON.stringify(credit[0]))
  check('the weekly row carries 98% with its used, remaining and reset', credit[1]?.usedPct === 98 && credit[1]?.used === 9855 && credit[1]?.remaining === 145 && credit[1]?.resetsAtMs === 1786685679998, JSON.stringify(credit[1]))
  check('no tool-call row was invented for a capture that stated none', quota?.windows.every(w => w.kind === 'credit') === true, JSON.stringify(quota?.windows))
}

section('§3 tolerances: unknown rows are skipped, never guessed; nothing decodes ⇒ undefined')
{
  const odd = reader.decodeZaiQuota({
    success: true,
    code: 200,
    data: {
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 150, nextResetTime: 1782724971 },
        { type: 'CREDIT_LIMIT', unit: 9, number: 2, percentage: 40 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1 },
        { type: 'SOMETHING_ELSE', unit: 3, number: 5, percentage: 50 },
        'not a row',
      ],
      level: '',
    },
  }, NOW)
  check('a percentage past 100 clamps to 100; an epoch-second reset becomes milliseconds', odd?.windows[0]?.usedPct === 100 && odd?.windows[0]?.resetsAtMs === 1782724971000, JSON.stringify(odd?.windows[0]))
  check("an unknown unit keeps the row with no windowMinutes (labelled 'win' downstream), never a guessed length", odd?.windows[1]?.usedPct === 40 && odd?.windows[1]?.windowMinutes === undefined, JSON.stringify(odd?.windows[1]))
  check('a row without a percentage is skipped; an unknown type is skipped; a non-object row is skipped', odd?.windows.length === 2, JSON.stringify(odd?.windows))
  check('an empty level is no level', odd?.level === undefined, JSON.stringify(odd?.level))
  check('an envelope with no decodable row is undefined (no fabricated meter)', reader.decodeZaiQuota({ success: true, code: 200, data: { limits: [{ type: 'CREDIT_LIMIT' }], level: 'pro' } }, NOW) === undefined)
  check('a body that is not an object is undefined', reader.decodeZaiQuota('nope', NOW) === undefined && reader.decodeZaiQuota(null, NOW) === undefined)
  check("the vendor's success rule: no code and success unstated still decodes; code 0 decodes", reader.decodeZaiQuota({ data: { limits: PRO_CAPTURE.data.limits } }, NOW) !== undefined && reader.decodeZaiQuota({ code: 0, data: { limits: PRO_CAPTURE.data.limits } }, NOW) !== undefined)
  check('success:false never decodes even with rows present', reader.decodeZaiQuota({ ...PRO_CAPTURE, success: false }, NOW) === undefined)
  check('a non-200 code never decodes even with rows present', reader.decodeZaiQuota({ ...PRO_CAPTURE, code: 1309 }, NOW) === undefined)
}

section('§4 the logical failures ride HTTP 200: the verdict and its one line')
{
  const missing = reader.zaiQuotaVerdict(AUTH_MISSING)
  check('code 1001 is a refusal carrying its code and msg', missing.ok === false && missing.code === 1001 && missing.message === 'Authorization Token Missing', JSON.stringify(missing))
  check('1000 and 1001 are the auth codes (the one Bearer retry fires on them); 1309 and the no-plan msg are not', reader.isZaiAuthCode(1000) && reader.isZaiAuthCode(1001) && !reader.isZaiAuthCode(1309) && !reader.isZaiAuthCode(1234) && !reader.isZaiAuthCode(undefined))
  const words = (body: unknown, status = 200) => {
    const verdict = reader.zaiQuotaVerdict(body)
    return verdict.ok ? 'ok' : reader.zaiQuotaFailureWords({ kind: 'refused', status, atMs: NOW, ...(verdict.code !== undefined ? { code: verdict.code } : {}), ...(verdict.message !== undefined ? { message: verdict.message } : {}) })
  }
  check("an auth refusal's line: 'no usage read (1001 Authorization Token Missing)'", words(AUTH_MISSING) === 'no usage read (1001 Authorization Token Missing)', words(AUTH_MISSING))
  check("code 1000: 'no usage read (1000 Authentication failed)'", words(AUTH_FAILED) === 'no usage read (1000 Authentication failed)', words(AUTH_FAILED))
  check("an expired plan: 'no usage read (1309 The coding plan has expired)'", words(PLAN_EXPIRED) === 'no usage read (1309 The coding plan has expired)', words(PLAN_EXPIRED))
  check("a valid key with no plan (the msg names the coding plan; the code is a placeholder): 'usage: not on a coding plan'", words(NO_PLAN) === 'usage: not on a coding plan', words(NO_PLAN))
  check('the no-plan verdict is typed, not a substring the surfaces match', reader.isZaiNoPlanFailure({ kind: 'refused', status: 200, code: 1234, message: NO_PLAN.msg, atMs: NOW }) && !reader.isZaiNoPlanFailure({ kind: 'refused', status: 200, code: 1309, message: PLAN_EXPIRED.msg, atMs: NOW }))
  check("an HTTP refusal with no body code: 'no usage read (HTTP 503)'", reader.zaiQuotaFailureWords({ kind: 'refused', status: 503, atMs: NOW }) === 'no usage read (HTTP 503)')
  check("an unreachable host: 'no usage read (unreachable · <the transport words>)'", reader.zaiQuotaFailureWords({ kind: 'unreachable', message: 'connection refused', atMs: NOW }) === 'no usage read (unreachable · connection refused)')
  check('a success envelope is ok', reader.zaiQuotaVerdict(PRO_CAPTURE).ok === true && reader.zaiQuotaVerdict({ data: {} }).ok === true)
  const long = reader.zaiQuotaFailureWords({ kind: 'refused', status: 200, code: 1309, message: 'x'.repeat(400), atMs: NOW })
  check('a runaway msg is bounded to one line', long.length < 120, String(long.length))
}

section('§5 the owner composes the credit windows as Kimi-shaped views; the tool quota is a figure, never a window')
{
  const quota = reader.decodeZaiQuota(PRO_CAPTURE, NOW)!
  const views = owner.zaiQuotaWindowViews(quota)
  check("the views are the 5h then 7d pair, keyed and labelled like Kimi's", views.map(v => `${v.key}/${v.label}`).join(',') === '5h/5h,7d/7d', JSON.stringify(views))
  check('each view carries the stated percent, reset, stamp and the endpoint feed', views.every(v => v.state === 'live' && v.source === 'endpoint' && v.observedAtMs === NOW) && views[0]?.usedPct === 17 && views[0]?.resetsAtMs === 1782724971179 && views[1]?.usedPct === 3 && views[1]?.resetsAtMs === 1783305486997, JSON.stringify(views))
  check('the tool-call row is not among the windows', views.length === 2)
  const figures = owner.zaiQuotaFigures(quota)
  check("the tool-call quota rides as one figure: '0 of 1000' MCP tool calls this month, stamped, with its reset", figures.length === 1 && figures[0]?.key === 'tool-calls' && figures[0]?.value === '0 of 1000' && figures[0]?.label === 'MCP tool calls this month' && figures[0]?.resetsAtMs === 1785292686976 && figures[0]?.observedAtMs === NOW && figures[0]?.source === 'endpoint', JSON.stringify(figures))
  const lite = reader.decodeZaiQuota(LITE_CAPTURE, NOW)!
  const liteViews = owner.zaiQuotaWindowViews(lite)
  check('the idle 5h row is a live 0% view with no reset (never an invented one)', liteViews[0]?.usedPct === 0 && liteViews[0]?.resetsAtMs === undefined && liteViews[1]?.usedPct === 98, JSON.stringify(liteViews))
  check('a capture without a tool quota yields no figure', owner.zaiQuotaFigures(lite).length === 0)
  check('null is no views and no figures', owner.zaiQuotaWindowViews(null).length === 0 && owner.zaiQuotaFigures(null).length === 0)
}

section('§6 the facade arm: a coding key meters windows; a general key keeps one honest line; the old injections keep their shape')
{
  const spend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  const quota = reader.decodeZaiQuota(PRO_CAPTURE, NOW)!
  const coding = owner.usageForProvider('zai', { zaiKeyPresent: () => true, zaiAccount: () => ({ plan: 'coding', source: 'stored' }), zaiQuota: () => quota, spend: () => spend })
  check("a coding key with a record: 'subscription-windows', the 5h/7d views, tier 'GLM Coding Pro', no absence, no credits", coding.shape === 'subscription-windows' && coding.sourceKind === 'api-key' && coding.windows.map(w => w.key).join(',') === '5h,7d' && coding.tier === 'GLM Coding Pro' && coding.absence === undefined && coding.credits === undefined && coding.label === 'GLM Coding Plan usage', JSON.stringify({ shape: coding.shape, tier: coding.tier, label: coding.label, windows: coding.windows.map(w => w.key), absence: coding.absence }))
  check('its figures carry the tool-call quota', coding.figures?.[0]?.key === 'tool-calls', JSON.stringify(coding.figures))
  const summary = owner.usageSummaryWords(coding, NOW + 12_000)
  check("the prose summary reads 'GLM Coding Pro · 5h 17% · resets … · 7d 3% · resets … · endpoint-fed · read 12 s ago'", summary.startsWith('GLM Coding Pro · 5h 17% · resets ') && summary.includes(' · 7d 3% · resets ') && summary.includes('endpoint-fed · read 12 s ago'), summary)
  const binding = owner.bindingWindowOf(coding, 'glm-4.7')
  check("the binding window is the highest-used credit window, worded '5h window'", binding?.window.key === '5h' && binding?.windowName === '5h window', JSON.stringify(binding))
  const unread = owner.usageForProvider('zai', { zaiKeyPresent: () => true, zaiAccount: () => ({ plan: 'coding', source: 'stored' }), zaiQuota: () => null, spend: () => spend })
  check("a coding key before its first answer: the windows shape with no windows, tier 'GLM Coding Plan', no absence", unread.shape === 'subscription-windows' && unread.windows.length === 0 && unread.tier === 'GLM Coding Plan' && unread.absence === undefined && unread.readerNote === undefined, JSON.stringify(unread))
  const failed = owner.usageForProvider('zai', { zaiKeyPresent: () => true, zaiAccount: () => ({ plan: 'coding', source: 'stored' }), zaiQuota: () => null, zaiQuotaFailure: () => ({ kind: 'refused', status: 200, code: 1309, message: 'The coding plan has expired', atMs: NOW }), spend: () => spend })
  check("a refused read with nothing observed: the reader's one line in prose and compact", failed.readerNote === 'no usage read (1309 The coding plan has expired)' && failed.readerNoteCompact === failed.readerNote && failed.windows.length === 0, JSON.stringify(failed))
  const stale = owner.usageForProvider('zai', { zaiKeyPresent: () => true, zaiAccount: () => ({ plan: 'coding', source: 'stored' }), zaiQuota: () => quota, zaiQuotaFailure: () => ({ kind: 'refused', status: 503, atMs: NOW + 1 }), spend: () => spend })
  check('a later failure leaves the last observation standing with the note beside it', stale.windows.length === 2 && stale.readerNote === 'no usage read (HTTP 503)', JSON.stringify(stale.readerNote))
  const older = owner.usageForProvider('zai', { zaiKeyPresent: () => true, zaiAccount: () => ({ plan: 'coding', source: 'stored' }), zaiQuota: () => quota, zaiQuotaFailure: () => ({ kind: 'refused', status: 503, atMs: NOW - 1 }), spend: () => spend })
  check('a failure older than the record says nothing (the record answered after it)', older.readerNote === undefined)
  const noPlan = owner.usageForProvider('zai', { zaiKeyPresent: () => true, zaiAccount: () => ({ plan: 'coding', source: 'stored' }), zaiQuota: () => null, zaiQuotaFailure: () => ({ kind: 'refused', status: 200, code: 1234, message: NO_PLAN.msg, atMs: NOW }), spend: () => spend })
  check("a key the endpoint says has no coding plan: one line, 'usage: not on a coding plan', the api-spend shape, no windows, no note", noPlan.shape === 'api-spend' && noPlan.absence === 'usage: not on a coding plan' && noPlan.windows.length === 0 && noPlan.readerNote === undefined && noPlan.tier === 'API billing', JSON.stringify(noPlan))
  const general = owner.usageForProvider('zai', { zaiKeyPresent: () => true, zaiAccount: () => ({ plan: 'general', source: 'stored' }), spend: () => spend })
  check('a general key: the api-spend shape, API billing, no windows, and the one honest line naming the billing console', general.shape === 'api-spend' && general.tier === 'API billing' && general.windows.length === 0 && general.absence === 'No usage road for a general Z.AI key — https://z.ai/manage-apikey/billing is the view' && general.credits?.state === 'unreported', JSON.stringify(general))
  const env = owner.usageForProvider('zai', { zaiKeyPresent: () => true, zaiAccount: () => ({ plan: 'general', source: 'env' }), spend: () => spend })
  check('an env key is a general key', env.shape === 'api-spend' && env.absence === general.absence)
  const legacy = owner.usageForProvider('zai', { zaiKeyPresent: () => true, spend: () => spend })
  check('an injection that states only key presence reads as a general key (the older proofs keep their shape)', legacy.shape === 'api-spend' && legacy.label === 'Z.AI usage' && legacy.tier === 'API billing' && typeof legacy.absence === 'string', JSON.stringify(legacy))
  const none = owner.usageForProvider('zai', { zaiKeyPresent: () => false, spend: () => spend })
  check('no key: the why-not, unchanged', none.sourceKind === 'none' && none.whyNot === 'not connected — /logins zai adds a key')
  check('the general line carries no date and no claim that nothing was found', !/\d{4}-\d{2}-\d{2}/.test(general.absence ?? '') && !/found/.test(general.absence ?? ''))
}

finish()
