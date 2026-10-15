import { geminiOauthClientConfig, geminiOauthConnected, geminiPlanFacts, resolveGeminiAccount, resolveGeminiApiKey } from '../services/providers/gemini/geminiAccounts.js'
import { geminiPlanTierWords } from '../services/providers/gemini/geminiPlanAccess.js'
import { geminiPlanUsageFigures } from '../services/providers/providerUsage.js'
import { geminiLaneModelsByLastUse } from '../services/providers/gemini/geminiPlanQuota.js'
import { geminiPlanActiveQuotaWords } from './Settings/usageLine.js'
import { focusedSessionModelFacts } from '../services/engine-connector/focusedConnector.js'
import { formatAge } from '../utils/healthCertCore.js'
import { KEY_PAGES } from './loginFamilyRows.js'

interface GeminiGuidePage {
  address: string
  observedAt: string
  source: string
}

export type GeminiGuideStepNumber = 1 | 2 | 3 | 4 | 5 | 6

interface GeminiGuideStep {
  number: GeminiGuideStepNumber
  title: string
  detail: string
  page?: GeminiGuidePage
  overviewPage?: GeminiGuidePage
}

const OBSERVED_AT = '2026-09-20'
const GOOGLE_QUICKSTART = "Google's OAuth quickstart for the Gemini API (ai.google.dev/gemini-api/docs/oauth, last updated 2026-08-24)"
const CONSOLE_OWN_PAGE = "the Google Cloud Console's own page, answering an unsigned request"
const AI_STUDIO_OWN_PAGE = "Google AI Studio's own page, answering an unsigned request"

export const GEMINI_API_KEY_PAGE: GeminiGuidePage = {
  address: `https://${KEY_PAGES.gemini}`,
  observedAt: OBSERVED_AT,
  source: AI_STUDIO_OWN_PAGE,
}

export const GEMINI_GOOGLE_ACCOUNT_STEPS: readonly GeminiGuideStep[] = [
  {
    number: 1,
    title: 'Create a Google Cloud project',
    detail: 'Name a project on the page that opens and press Create — a project you already own works as well.',
    page: { address: 'https://console.cloud.google.com/projectcreate', observedAt: OBSERVED_AT, source: CONSOLE_OWN_PAGE },
  },
  {
    number: 2,
    title: 'Enable the Gemini API on it',
    detail: 'Pick that project on the page that opens (it can create one too) and press Enable: it switches on the Generative Language API.',
    page: {
      address: 'https://console.cloud.google.com/flows/enableapi?apiid=generativelanguage.googleapis.com',
      observedAt: OBSERVED_AT,
      source: GOOGLE_QUICKSTART,
    },
  },
  {
    number: 3,
    title: 'Set up the consent screen for testing',
    detail:
      'On the Audience page choose External as the user type and add your own Google address under Test users — Google lets an unpublished app sign in only its listed test users. A project not set up yet asks you to press Get started first (name the app, External, a contact email) on the overview page.',
    page: { address: 'https://console.developers.google.com/auth/audience', observedAt: OBSERVED_AT, source: GOOGLE_QUICKSTART },
    overviewPage: { address: 'https://console.developers.google.com/auth/overview', observedAt: OBSERVED_AT, source: GOOGLE_QUICKSTART },
  },
  {
    number: 4,
    title: 'Create an OAuth client for a desktop app',
    detail: 'Press Create client, choose the application type Desktop app, name it anything and create — copy the client id it shows.',
    page: { address: 'https://console.developers.google.com/auth/clients', observedAt: OBSERVED_AT, source: GOOGLE_QUICKSTART },
  },
  {
    number: 5,
    title: 'Paste the client id',
    detail: 'The client secret is optional for a desktop app. The id is kept for good: your next sign-in starts at step 6.',
  },
  {
    number: 6,
    title: 'Sign in with Google in the browser',
    detail:
      'Pick your account, choose Continue past "Google hasn\'t verified this app", then Allow — Google sends the browser back here and the sign-in completes.',
  },
]

export function geminiGuideStep(number: GeminiGuideStepNumber): GeminiGuideStep {
  return GEMINI_GOOGLE_ACCOUNT_STEPS[number - 1]!
}

export function geminiGuidePages(): GeminiGuidePage[] {
  const pages: GeminiGuidePage[] = [GEMINI_API_KEY_PAGE]
  for (const step of GEMINI_GOOGLE_ACCOUNT_STEPS) {
    if (step.page) pages.push(step.page)
    if (step.overviewPage) pages.push(step.overviewPage)
  }
  return pages
}

export interface GeminiConnectFacts {
  keySource?: 'env-google' | 'env-gemini' | 'stored'
  clientSource?: 'env' | 'stored'
  oauthConnected: boolean
  planConnected?: boolean
  planTier?: string
  planTierReadAtMs?: number
  planActiveQuota?: string
  active?: 'oauth' | 'api-key' | 'plan'
}

type GeminiConnectRowAction = 'activate' | 'enter'

type GeminiConnectRowValue = 'plan' | 'key' | 'google' | 'client'

function storedSourceCount(facts: GeminiConnectFacts): number {
  return (facts.planConnected ? 1 : 0) + (facts.oauthConnected ? 1 : 0) + (facts.keySource !== undefined ? 1 : 0)
}

export function geminiConnectRowAction(facts: GeminiConnectFacts, value: GeminiConnectRowValue): GeminiConnectRowAction {
  if (storedSourceCount(facts) < 2) return 'enter'
  if (value === 'plan') return facts.planConnected && facts.active !== 'plan' ? 'activate' : 'enter'
  if (value === 'key') return facts.keySource !== undefined && facts.active !== 'api-key' ? 'activate' : 'enter'
  if (value === 'google') return facts.oauthConnected && facts.active !== 'oauth' ? 'activate' : 'enter'
  return 'enter'
}

export const GEMINI_CONNECT_TITLE = 'Connect Google Gemini'
export const GEMINI_CONNECT_INTRO =
  "Sign in with Google runs Gemini on your plan's quota through Google's own Antigravity client (free, AI Pro or AI Ultra). An API key or your own OAuth client bills a Cloud project instead."
export const GEMINI_CONNECT_COMPACT_INTRO = "Google sign-in: your plan's quota; a key: a Cloud project."
export const GEMINI_KEY_BILLING_NOTE = 'Cloud project: free Flash ~20/day, Pro 0; pay for more.'
export const GEMINI_KEY_ROW = 'API key — the easiest: create one in AI Studio, paste it here'
export const GEMINI_PLAN_ROW = "Sign in with Google — your plan's quota: AI Pro, AI Ultra or a free account"

function geminiPlanTierWordsWithAge(facts: Pick<GeminiConnectFacts, 'planTier' | 'planTierReadAtMs'>, now: number = Date.now()): string {
  const tier = facts.planTier ?? 'tier unknown'
  return facts.planTierReadAtMs !== undefined ? `${tier}, read ${formatAge(now - facts.planTierReadAtMs)}` : tier
}

export function geminiPlanRowLabel(facts: GeminiConnectFacts, now: number = Date.now()): string {
  if (!facts.planConnected) return GEMINI_PLAN_ROW
  const tier = geminiPlanTierWordsWithAge(facts, now)
  const quota = facts.planActiveQuota !== undefined && geminiConnectRowAction(facts, 'plan') !== 'activate' ? ` · ${facts.planActiveQuota}` : ''
  return geminiConnectRowAction(facts, 'plan') === 'activate'
    ? `Sign in with Google — connected (${tier}), not active · ↵ makes it active`
    : `Sign in with Google — connected (${tier})${quota} · ↵ signs in again`
}

export function geminiConnectRows(facts: GeminiConnectFacts): Array<{ label: string; value: GeminiConnectRowValue }> {
  const keyRow =
    facts.keySource === undefined
      ? GEMINI_KEY_ROW
      : geminiConnectRowAction(facts, 'key') === 'activate'
        ? facts.keySource === 'stored'
          ? 'API key — stored, not active · ↵ makes it active'
          : `API key — ${facts.keySource === 'env-google' ? 'GOOGLE_API_KEY' : 'GEMINI_API_KEY'} in the environment, not active · ↵ makes it active`
        : facts.keySource === 'stored'
          ? 'API key — connected (stored locally) · ↵ pastes a replacement'
          : `API key — connected (${facts.keySource === 'env-google' ? 'GOOGLE_API_KEY' : 'GEMINI_API_KEY'} in the environment) · ↵ pastes a stored one`
  const googleRow = facts.oauthConnected
    ? geminiConnectRowAction(facts, 'google') === 'activate'
      ? 'Google account — connected, not active · ↵ makes it active'
      : 'Google account — connected · ↵ signs in again (step 6)'
    : facts.clientSource === 'env'
      ? 'Google account — the client id comes from MERCURY_GEMINI_OAUTH_CLIENT_ID · ↵ signs in (step 6)'
      : facts.clientSource === 'stored'
        ? 'Google account — the client id is stored · ↵ signs in (step 6)'
        : 'Google account — six steps, each opens its Console page'
  const rows: Array<{ label: string; value: GeminiConnectRowValue }> = [
    { label: geminiPlanRowLabel(facts), value: 'plan' },
    { label: keyRow, value: 'key' },
    { label: googleRow, value: 'google' },
  ]
  if (facts.clientSource === 'stored') rows.push({ label: 'Change the stored client id (step 5 again)', value: 'client' })
  return rows
}

export function geminiGuideOpeningStep(facts: GeminiConnectFacts): GeminiGuideStepNumber {
  return facts.clientSource === undefined ? 1 : 6
}

export function geminiGuideReturnStep(failure: string): GeminiGuideStepNumber | undefined {
  return /\baccess_denied\b/.test(failure) ? 3 : undefined
}

export type GeminiGuideOpenState = 'opening' | 'opened' | 'failed'

type GeminiGuideTone = 'title' | 'done' | 'current' | 'todo' | 'detail' | 'address' | 'status' | 'note' | 'hint'

export interface GeminiGuideLine {
  text: string
  tone: GeminiGuideTone
}

function geminiGuideTitle(step: GeminiGuideStepNumber): string {
  return `Connect a Google account — step ${step} of 6`
}

function geminiGuideStepLines(current: GeminiGuideStepNumber, compact: boolean): GeminiGuideLine[] {
  const lines: GeminiGuideLine[] = []
  for (const step of GEMINI_GOOGLE_ACCOUNT_STEPS) {
    if (compact && step.number !== current) continue
    const tone: GeminiGuideTone = step.number < current ? 'done' : step.number === current ? 'current' : 'todo'
    const mark = tone === 'done' ? '✓' : tone === 'current' ? '›' : ' '
    lines.push({ text: `${mark} ${step.number}. ${step.title}`, tone })
  }
  return lines
}

export function geminiGuideOpenWords(opened: GeminiGuideOpenState): string {
  return opened === 'opened'
    ? 'opened in your browser'
    : opened === 'opening'
      ? 'opening your browser…'
      : 'no browser opened here — open the address above yourself'
}

export function geminiGuidePaneLines(view: {
  step: GeminiGuideStepNumber
  opened?: GeminiGuideOpenState
  note?: string
  compact: boolean
}): GeminiGuideLine[] {
  const step = geminiGuideStep(view.step)
  const lines: GeminiGuideLine[] = [{ text: geminiGuideTitle(view.step), tone: 'title' }]
  lines.push(...geminiGuideStepLines(view.step, view.compact))
  lines.push({ text: step.detail, tone: 'detail' })
  if (step.page) lines.push({ text: step.page.address, tone: 'address' })
  if (step.overviewPage) lines.push({ text: `the overview page: ${step.overviewPage.address}`, tone: 'address' })
  if (step.page && view.opened) lines.push({ text: geminiGuideOpenWords(view.opened), tone: view.opened === 'failed' ? 'note' : 'status' })
  if (view.note) lines.push({ text: view.note, tone: 'note' })
  return lines
}

export function geminiGuideHint(step: GeminiGuideStepNumber, field?: 'id' | 'secret'): string {
  if (step === 5) return field === 'secret' ? '↵ stores (secret optional) · esc back to the id' : '↵ continues to the secret · esc back'
  if (step === 6) return 'c copies the URL · ESC cancels.'
  return '↵ done, next step · o opens the page again · esc back'
}

const GEMINI_KEY_LEG_TITLE = 'Connect Google Gemini — API key'
const GEMINI_KEY_STORAGE_SENTENCE =
  'Stored auth-scoped (mode 600), never logged; GOOGLE_API_KEY / GEMINI_API_KEY env vars always win over the store (GOOGLE_API_KEY outranks — the documented precedence).'

export function geminiKeyLegLines(opened: GeminiGuideOpenState | undefined): GeminiGuideLine[] {
  const lines: GeminiGuideLine[] = [{ text: GEMINI_KEY_LEG_TITLE, tone: 'title' }]
  lines.push({
    text:
      opened === 'opened'
        ? 'AI Studio opened: create a key there.'
        : opened === 'opening'
          ? 'Opening AI Studio: create a key there.'
          : 'Open AI Studio below; create a key.',
    tone: 'detail',
  })
  lines.push({ text: GEMINI_API_KEY_PAGE.address, tone: 'address' })
  lines.push({ text: GEMINI_KEY_STORAGE_SENTENCE, tone: 'detail' })
  lines.push({ text: GEMINI_KEY_BILLING_NOTE, tone: 'detail' })
  return lines
}

export const GEMINI_PLAN_LEG_TITLE = 'Sign in with Google'
export const GEMINI_PLAN_LEG_DETAIL =
  "Google's sign-in page opens in your browser: pick the account that holds your plan and allow the access. Mercury presents Google's own Antigravity client — no Cloud project, no client of your own — and Gemini then runs on that plan's quota."

export function geminiPlanLegLines(opened: GeminiGuideOpenState | undefined): GeminiGuideLine[] {
  const lines: GeminiGuideLine[] = [{ text: GEMINI_PLAN_LEG_TITLE, tone: 'title' }, { text: GEMINI_PLAN_LEG_DETAIL, tone: 'detail' }]
  if (opened) lines.push({ text: geminiGuideOpenWords(opened), tone: opened === 'failed' ? 'note' : 'status' })
  return lines
}

export function liveGeminiConnectFacts(): GeminiConnectFacts {
  const key = resolveGeminiApiKey()
  const client = geminiOauthClientConfig()
  const plan = geminiPlanFacts()
  const active = resolveGeminiAccount()?.kind
  const facts = focusedSessionModelFacts()
  const planActiveQuota = plan !== undefined && active === 'plan'
    ? geminiPlanActiveQuotaWords(geminiPlanUsageFigures(plan), { ...(facts?.effective !== undefined ? { model: facts.effective } : {}), ...(typeof facts?.effort === 'string' ? { effort: facts.effort } : {}), usedModels: geminiLaneModelsByLastUse() })
    : undefined
  return {
    ...(planActiveQuota !== undefined ? { planActiveQuota } : {}),
    ...(key ? { keySource: key.source } : {}),
    ...(client ? { clientSource: client.source } : {}),
    oauthConnected: geminiOauthConnected(),
    planConnected: plan !== undefined,
    ...(plan ? { planTier: geminiPlanTierWords(plan.tier) } : {}),
    ...(plan?.tierReadAtMs !== undefined ? { planTierReadAtMs: plan.tierReadAtMs } : {}),
    ...(active !== undefined ? { active } : {}),
  }
}
