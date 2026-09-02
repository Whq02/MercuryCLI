#!/usr/bin/env bun
// ============================================================================
// scripts/ui/face-logins-stills.ts — the FACE-LOGINS STILL FRAMES: the boot
//  face's logins roster at the 64×12 product floor, the classic tier (80×24)
//  and the wide tier (120×40), in a MIXED world (subscription signed in ·
//  an engine token with identity · a window-reached lane · absent rows), an
//  EXPIRED-subscription frame and the signed-out world — composed by the
//  SAME pure owners the screen composes with (BootLoginsScreen's exported
//  model builder over composeBootMenu), nocolor so the stills read as text.
//  `--write` regenerates scripts/ui/fixtures/face-logins/*.txt;
//  prove-face-logins.ts byte-compares the live composition against them.
//
//  The fixture facts are SPEC-AUTHORED CAPTURED SHAPES of the owners'
//  answers (FamilySlotGroup · ProviderUsability), marked as such — never a
//  live read, never a real identity, never a key.
// ============================================================================
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSplashCore } from '../../assets/splash/splash-core.mjs'
import {
  loginsMenuModelOf,
  loginsSortedArms,
  type LoginsFlowPaneV1,
  type LoginsScreenFactsV1,
} from '../../src/components/BootLoginsScreen.js'
import type { AnthropicLoginSnapshot } from '../../src/components/mercury-ui/screens/anthropicLoginModel.js'
import type { AccountSlot, FamilySlotGroup } from '../../src/services/providers/accountSlots.js'
import type { ProviderId, ProviderUsability } from '../../src/services/providers/providerUsability.js'
import type { ProviderFamilyPresence } from '../../src/services/providers/providerUsage.js'

export const STILLS_DIR = join(import.meta.dir, 'fixtures', 'face-logins')

const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })

/** The face-door stills' environment spellings — one fixed panel. */
export const STILL_ENVIRONMENT = {
  model: 'Opus 5',
  critter: 'Octopus',
  critterHue: '#B07BE0',
  dirBase: 'orchard-src',
  dirTail: '',
}

const presence = (
  id: string,
  over: Partial<ProviderFamilyPresence & { expired?: boolean }> = {},
): ProviderFamilyPresence => ({ id, available: true, credentialed: false, ...over }) as ProviderFamilyPresence

const slot = (over: Partial<AccountSlot> & { family: string; id: string; kind: AccountSlot['kind'] }): AccountSlot => ({
  name: over.id,
  kindLabel: over.kind,
  identity: '',
  active: false,
  envPinned: false,
  signedIn: false,
  removal: { route: 'owner', note: 'fixture' },
  ...over,
})

const usable = (provider: ProviderId, over: Partial<ProviderUsability> = {}): ProviderUsability => ({
  provider,
  credential: 'none',
  limit: 'unknown',
  usable: false,
  blockers: ['no credential for this family'],
  ...over,
})

/** The MIXED world: the subscription signed in and active; the Anthropic
 *  key arm empty; ChatGPT connected; Hugging Face tokened with identity;
 *  Kimi signed in but its observed window REACHED (loud); the rest absent
 *  (one with a typed blocker sentence long enough to wrap). */
export function mixedFacts(): LoginsScreenFactsV1 {
  const groups: FamilySlotGroup[] = [
    {
      family: presence('anthropic', { credentialed: true, credentialLabel: 'Claude subscription (pro)' }),
      slots: [
        slot({ family: 'anthropic', id: 'anthropic:scope-personal', kind: 'oauth', name: 'personal', kindLabel: 'claude.ai sign-in', identity: 'op@example.com', active: true, signedIn: true }),
        slot({ family: 'anthropic', id: 'anthropic:api-key', kind: 'api-key', kindLabel: 'API key', identity: '' }),
      ],
    },
    {
      family: presence('openai', { credentialed: true, credentialLabel: 'ChatGPT subscription' }),
      slots: [slot({ family: 'openai', id: 'openai:chatgpt', kind: 'subscription', kindLabel: 'ChatGPT sign-in', identity: 'ChatGPT Plus', signedIn: true })],
    },
    { family: presence('openrouter'), slots: [] },
    { family: presence('gemini'), slots: [] },
    {
      family: presence('huggingface', { credentialed: true, credentialLabel: 'Hub token' }),
      slots: [slot({ family: 'huggingface', id: 'huggingface:token', kind: 'api-key', kindLabel: 'Hub token', identity: 'keyed-op …k9f2', signedIn: true })],
    },
    {
      family: presence('moonshot', { credentialed: true, credentialLabel: 'Kimi sign-in' }),
      slots: [slot({ family: 'moonshot', id: 'moonshot:oauth', kind: 'oauth', kindLabel: 'Kimi sign-in', identity: 'kimi.ai (global)', signedIn: true })],
    },
    { family: presence('zai'), slots: [] },
    { family: presence('deepseek'), slots: [] },
  ]
  const usability: Record<ProviderId, ProviderUsability> = {
    anthropic: usable('anthropic', { credential: 'oauth', limit: 'allowed', usable: true, blockers: [] }),
    openai: usable('openai', { credential: 'oauth', limit: 'unknown', usable: true, blockers: [] }),
    openrouter: usable('openrouter'),
    gemini: usable('gemini', { blockers: ['no Gemini credential — sign in with a Google OAuth client or paste an API key'] }),
    huggingface: usable('huggingface', { credential: 'api-key', limit: 'unknown', usable: true, blockers: [] }),
    moonshot: usable('moonshot', { credential: 'oauth', limit: 'rejected', usable: true, blockers: [] }),
    deepseek: usable('deepseek'),
    zai: usable('zai'),
    'openai-compat': usable('openai-compat'),
    local: usable('local'),
  }
  return { groups, usability }
}

/** The EXPIRED world: the stored subscription observed dead — existence
 *  true, ready NOT pretended (the presence owner's present-but-dead law). */
export function expiredFacts(): LoginsScreenFactsV1 {
  const base = mixedFacts()
  const anthropic = base.groups.find(g => g.family.id === 'anthropic')!
  anthropic.family = presence('anthropic', { credentialed: true, credentialLabel: 'Claude subscription (pro)', expired: true })
  base.usability.anthropic = usable('anthropic', {
    credential: 'oauth',
    limit: 'allowed',
    usable: false,
    blockers: ['the claude.ai sign-in has expired — /logins re-authenticates it'],
  })
  return base
}

/** The signed-out world: every family absent, every lane blocked. */
export function signedOutFacts(): LoginsScreenFactsV1 {
  const mixed = mixedFacts()
  return {
    groups: mixed.groups.map(g => ({ family: presence(g.family.id as string), slots: [] })),
    usability: Object.fromEntries(
      Object.entries(mixed.usability).map(([id]) => [id, usable(id as ProviderId)]),
    ) as Record<ProviderId, ProviderUsability>,
  }
}

/** The roster frame: the screen's own model builder over the fixed facts.
 *  `flow` composes an open flow pane exactly as the screen does (A4). */
export function composeLogins(
  cols: number,
  rows: number,
  opts: { facts?: LoginsScreenFactsV1; sel?: number; flow?: LoginsFlowPaneV1 } = {},
): string[] {
  const facts = opts.facts ?? mixedFacts()
  const arms = loginsSortedArms(facts)
  const sel = Math.min(opts.sel ?? 0, arms.length - 1)
  const m = loginsMenuModelOf(facts, {
    selIdx: sel,
    environment: STILL_ENVIRONMENT,
    ...(opts.flow !== undefined ? { flow: opts.flow } : {}),
  })
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

/** A4's flow-pane snapshots (spec-authored shapes; never a live flow). */
export const FLOW_WAITING_SNAP: AnthropicLoginSnapshot = {
  flow: { name: 'waiting', url: 'https://console.example.test/authorize?code=elided', loginWithClaudeAi: true, forcedMethod: null },
  pastePromptUp: true,
  copied: false,
  shadowWarning: null,
  accountLabel: null,
}
export const FLOW_SUCCESS_SNAP: AnthropicLoginSnapshot = {
  flow: { name: 'success' },
  pastePromptUp: false,
  copied: false,
  shadowWarning: 'ANTHROPIC_AUTH_TOKEN is set and will shadow this sign-in for this session.',
  accountLabel: 'op@example.com',
}

export const STILLS: ReadonlyArray<{ id: string; compose: () => string[] }> = [
  // The three tiers of the ONE composition over the mixed world — the
  // floor frame carries the composer's own warn line and keeps operating
  // (WARN-NEVER-WALL).
  { id: 'logins-120x40', compose: () => composeLogins(120, 40, { sel: 0 }) },
  { id: 'logins-80x24', compose: () => composeLogins(80, 24, { sel: 0 }) },
  { id: 'logins-64x12', compose: () => composeLogins(64, 12, { sel: 0 }) },
  // The window-reached row selected: the loud chip and the blockers pane.
  { id: 'logins-120x40-window', compose: () => composeLogins(120, 40, { sel: 3 }) },
  // The present-but-dead subscription (chip '· expired', the re-login road
  // in the pane) and the signed-out world (every row 'not signed in').
  { id: 'logins-120x40-expired', compose: () => composeLogins(120, 40, { facts: expiredFacts(), sel: 0 }) },
  { id: 'logins-120x40-signedout', compose: () => composeLogins(120, 40, { facts: signedOutFacts(), sel: 0 }) },
  // A4's flow panes: the browser wait with the paste fallback (the draft
  // MASKED — six dots, never bytes) and the settled success with the
  // shadow honesty; the roster stays composed beneath both.
  { id: 'logins-120x40-flow-waiting', compose: () => composeLogins(120, 40, { sel: 0, flow: { kind: 'anthropic', snap: FLOW_WAITING_SNAP, draftLen: 6 } }) },
  { id: 'logins-120x40-flow-success', compose: () => composeLogins(120, 40, { sel: 0, flow: { kind: 'anthropic', snap: FLOW_SUCCESS_SNAP, draftLen: 0 } }) },
  // A5's sub-views (re-cut at OS-AUTH-1: the console door is purely
  // Anthropic, so the pick still now shows the OpenAI family's two-arm
  // choice — the row owner's pair): the pick, a key prompt wearing a guard
  // note over the masked draft, and a settled receipt speaking the
  // driver's sentence verbatim.
  { id: 'logins-120x40-pick-openai', compose: () => composeLogins(120, 40, { sel: 4, flow: { kind: 'pick', pick: 'openai', pickSel: 0 } }) },
  {
    id: 'logins-120x40-key-note',
    compose: () =>
      composeLogins(120, 40, {
        sel: 4,
        flow: {
          kind: 'key',
          leg: 'zai-coding',
          note: 'That is an Anthropic API key (sk-ant-…) — this step stores a GLM Coding Plan key.',
          draftLen: 9,
          storing: false,
        },
      }),
  },
  // A6a's device wait: the Kimi RFC 8628 pane mid-wait — the one-time
  // code, the verification URL hard-wrapped, a transport fault NAMED, the
  // RELATIVE expiry (TZ-free by construction).
  {
    id: 'logins-120x40-device-wait',
    compose: () =>
      composeLogins(120, 40, {
        sel: 3,
        flow: {
          kind: 'device',
          device: {
            family: 'moonshot',
            regionWords: 'Global — kimi.ai',
            phase: 'waiting',
            userCode: 'ABCD-1234',
            verificationUri: 'https://auth.kimi.ai/activate?user_code=ABCD-1234',
            expiresAtMs: Date.parse('2026-08-29T12:05:00Z'),
            polls: 3,
            note: 'the Kimi host did not answer (socket hangup) — still trying until the code expires',
            copied: false,
          },
          nowMs: Date.parse('2026-08-29T12:00:00Z'),
        },
      }),
  },
  // A6b's handles wait (the OpenAI browser leg: loopback sentence, url,
  // masked paste, the d-switch offer) and the Gemini client prompt's
  // secret step (id plain and confirmed, the secret masked and optional).
  {
    id: 'logins-120x40-handles-wait',
    compose: () =>
      composeLogins(120, 40, {
        sel: 1,
        flow: {
          kind: 'handles',
          handles: { leg: 'openai-browser', phase: 'waiting', authorizeUrl: 'https://auth.openai.example/authorize?request=elided', copied: false },
          draftLen: 0,
        },
      }),
  },
  {
    id: 'logins-120x40-client-secret',
    compose: () =>
      composeLogins(120, 40, {
        sel: 6,
        flow: {
          kind: 'client',
          client: { field: 'secret', clientId: 'my-client.apps.example', note: null },
          draftLen: 6,
          draft: '••••••',
        },
      }),
  },
  {
    id: 'logins-120x40-receipt',
    compose: () =>
      composeLogins(120, 40, {
        sel: 4,
        flow: {
          kind: 'receipt',
          receipt:
            'GLM Coding Plan key stored (auth-scoped, mode 600). Requests ride api.z.ai/api/coding/paas/v4 (the Coding Plan base); the GLM rows join /model; the first turn proves the key (no key-check endpoint is wired for Z.AI).',
          ok: true,
        },
      }),
  },
]

// ── THE MERGED SESSIONS·PROJECTS FRAMES (act two, B2): composed from
// BootResumeScreen's own exported composers over the face-door fixture
//    store (the real C2 projection) + spec-authored project facts — a
//    still can never drift from the screen's own pipeline. ────────────────

import {
  resumeCrewDetailLines,
  resumeCrewEntryOf,
  resumeDetailLines,
  resumeEntryOf,
  resumeLegendOf,
  resumeProjectDetailLines,
  resumeProjectEntryOf,
  resumeStatusLine,
  resumeSummaryRows,
  type ResumeEntry,
} from '../../src/components/BootResumeScreen.js'
import { RESUME_FIXTURE_LOGS, resumeModelOf } from './face-door-stills.ts'
import { isProjectSession } from '../../src/utils/sessionFilter.js'
import type { BootProjectFact } from '../../src/utils/bootCardFacts.js'

const MIN = 60_000

/** Spec-authored project facts (the face's scanBootCardFacts SHAPE). */
export const MERGED_FIXTURE_PROJECTS: ReadonlyArray<BootProjectFact & { running?: number }> = [
  {
    dir: '/repo/orchard-src',
    base: 'orchard-src',
    ageMs: 2 * MIN,
    sessionId: 'a1',
    transcriptPath: '/store/a1.jsonl',
    firstChatAt: 1,
    firstSessionId: 'a1',
    running: 2,
  },
  {
    dir: '/repo/moodle',
    base: 'moodle',
    ageMs: 26 * 60 * MIN,
    sessionId: 'b1',
    transcriptPath: '/store/b1.jsonl',
    firstChatAt: 1,
    firstSessionId: 'b1',
  },
]

export function composeMerged(
  cols: number,
  rows: number,
  opts: { sel?: number; filterDir?: string } = {},
): string[] {
  const model = resumeModelOf('all')
  const flat = opts.filterDir !== undefined ? model.flat.filter(f => isProjectSession(f.row.log, opts.filterDir!)) : model.flat
  const crew = model.crew
  const projects = MERGED_FIXTURE_PROJECTS
  const entries: ResumeEntry[] = [
    ...flat.map(resumeEntryOf),
    ...crew.map(resumeCrewEntryOf),
    ...projects.map(resumeProjectEntryOf),
  ]
  const selectable = flat.length + crew.length + projects.length
  const sel = Math.min(opts.sel ?? 0, selectable - 1)
  const filterBase = opts.filterDir !== undefined ? projects.find(p => p.dir === opts.filterDir)?.base : undefined
  const m = {
    entries,
    selIdx: sel,
    title: 'sessions · projects',
    summaryTitle: 'SESSIONS · PROJECTS',
    summaryRows: resumeSummaryRows({ scope: 'all', count: flat.length, crewCount: crew.length, elsewhereCount: 0, pendingMore: 0, projectsCount: projects.length }),
    environment: STILL_ENVIRONMENT,
    statusRight: resumeStatusLine({ loading: false, count: flat.length, crewCount: crew.length, scope: 'all', pendingMore: 0, ...(filterBase !== undefined ? { filterBase } : {}) }),
    legend: resumeLegendOf('all', selectable > 0, true),
    detailOverride:
      sel < flat.length
        ? resumeDetailLines(flat[sel]!)
        : sel < flat.length + crew.length
          ? resumeCrewDetailLines(crew[sel - flat.length]!)
          : resumeProjectDetailLines(projects[sel - flat.length - crew.length]!),
  }
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

void RESUME_FIXTURE_LOGS

export const MERGED_STILLS: ReadonlyArray<{ id: string; compose: () => string[] }> = [
  // The merged composition: sessions over crew over PROJECTS, one
  // highlight; the ⇥ jump in the legend; the repos count in the panel.
  { id: 'merged-120x40', compose: () => composeMerged(120, 40, { sel: 1 }) },
  { id: 'merged-64x12', compose: () => composeMerged(64, 12, { sel: 1 }) },
  // The filter engaged: the cursor on the moodle repo — the sessions above
  // show that repo alone and the status bar names the filter.
  { id: 'merged-120x40-filtered', compose: () => composeMerged(120, 40, { sel: 99, filterDir: '/repo/moodle' }) },
]

export function stillPath(id: string): string {
  return join(STILLS_DIR, `${id}.txt`)
}

export function readStill(id: string): string | null {
  try {
    return readFileSync(stillPath(id), 'utf8')
  } catch {
    return null
  }
}

export function renderStill(lines: string[]): string {
  return lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n'
}

if (import.meta.main && process.argv.includes('--write')) {
  mkdirSync(STILLS_DIR, { recursive: true })
  for (const still of [...STILLS, ...MERGED_STILLS]) {
    writeFileSync(stillPath(still.id), renderStill(still.compose()))
    console.log(`wrote ${stillPath(still.id)}`)
  }
}
