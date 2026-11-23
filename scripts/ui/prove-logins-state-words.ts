#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-logins-state-words-'))
process.env['MERCURY_CONFIG_DIR'] = scratch
process.env['MERCURY_CREDENTIAL_STORE'] = 'file'
process.env['FORCE_COLOR'] = '0'
process.env['MERCURY_CRITTER_IDLE'] = '0'
process.env['MERCURY_CRITTER_GAZE'] = '0'
process.env['MERCURY_CRITTER_SLEEP'] = '0'
process.env['MERCURY_LIVE_CLOCK'] = '0'
process.env['MERCURY_LIVE_GLYPHS'] = '0'
process.env['MERCURY_LOCAL_PROBE_TARGETS'] = 'none'
for (const name of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|HF_TOKEN|GH_TOKEN)$/.test(name)) {
    delete process.env[name]
  }
}

const React = (await import('react')).default
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const {
  BootLoginsScreen,
  collectLoginsScreenFacts,
  loginsCatalogue,
  loginsMenuModelOf,
  loginsRowStateOf,
} = await import('../../src/screen/boot-face/BootLoginsScreen.js')
const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
const { storeZaiApiKeyLogin } = await import('../../src/models/roads/zai/zaiLogin.js')

let failures = 0
function check(label: string, cond: boolean, detail: string, fix: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail} | fix: ${fix}` : ''}`)
}

const REASON_CODE_RE = /^no-[a-z-]+:/
const ANY_INTERNAL_CODE_RE = /\b(?:no-[a-z-]+|not-configured|discovery-pending|disabled):[a-z0-9-]+/

const ENV = {
  model: 'Opus 5',
  critter: 'Octopus',
  critterHue: '#B07BE0',
  dirBase: 'project',
  dirTail: '',
}

function cutBetweenWords(full: string, rendered: string): boolean {
  if (rendered === full) return true
  if (!rendered.endsWith('…')) return false
  const head = rendered.slice(0, -1)
  if (!full.startsWith(head)) return false
  const next = full[head.length]
  return next === undefined || /[\s—–\/(-]/.test(next)
}

try {
  const arms = loginsCatalogue()
  const liveFacts = collectLoginsScreenFacts()

  const badStateCodes = arms
    .map(arm => ({ id: arm.familyId, chip: loginsRowStateOf(arm, liveFacts).chip }))
    .filter(row => REASON_CODE_RE.test(row.chip) || ANY_INTERNAL_CODE_RE.test(row.chip))
  check(
    'live signed-out states carry product words and never match /^no-[a-z-]+:/',
    badStateCodes.length === 0,
    badStateCodes.map(r => `${r.id}=${r.chip}`).join(', '),
    'map group.family.reason codes to user-facing words in loginsRowStateOf (src/screen/boot-face/logins/facts.ts)',
  )

  const syntheticCodes = [
    ['no-api-key:deepseek', 'no key'],
    ['no-api-key:huggingface', 'no key'],
    ['no-api-key:xai', 'no key'],
    ['no-account:gemini', 'not signed in'],
    ['no-account:openai', 'not signed in'],
    ['no-credential:moonshot', 'not signed in'],
    ['no-auth:anthropic', 'not signed in'],
    ['not-configured:openai-compat', 'not configured'],
    ['no-server:local', 'no server discovered'],
    ['discovery-pending:local', 'not probed yet'],
    ['disabled:deepseek', 'disabled'],
    ['no-executable:openai', 'unavailable'],
  ] as const
  const deepseekArm = arms.find(a => a.familyId === 'deepseek')!
  const codeMismatches: string[] = []
  for (const [code, expected] of syntheticCodes) {
    const facts = {
      ...liveFacts,
      groups: liveFacts.groups.map(g =>
        g.family.id === 'deepseek' ? { family: { ...g.family, available: false, reason: code }, slots: [] } : g,
      ),
    }
    const chip = loginsRowStateOf(deepseekArm, facts).chip
    if (chip !== expected || REASON_CODE_RE.test(chip) || ANY_INTERNAL_CODE_RE.test(chip)) {
      codeMismatches.push(`${code}=>${chip} (expected ${expected})`)
    }
  }
  check(
    'every unavailable reason code translates to product vocabulary',
    codeMismatches.length === 0,
    codeMismatches.join('; '),
    'translate every ENGINE_UNAVAILABLE_CODES prefix in loginsRowStateOf (src/screen/boot-face/logins/facts.ts)',
  )

  const frame120 = stripAnsi(
    await renderToString(
      React.createElement(BootLoginsScreen, { facts: liveFacts, fullScene: { columns: 120, rows: 45 } } as never),
      120,
    ),
  )
  const codeHit = ANY_INTERNAL_CODE_RE.exec(frame120)
  check(
    '120-column rendered BootLoginsScreen paints no internal reason code',
    codeHit === null,
    `found ${codeHit?.[0] ?? ''}`,
    'translate group.family.reason in loginsRowStateOf (src/screen/boot-face/logins/facts.ts)',
  )

  const missingLabels = arms.filter(arm => !frame120.includes(arm.row.label)).map(arm => arm.row.label)
  check(
    '120-column rendered BootLoginsScreen paints every provider label whole',
    missingLabels.length === 0,
    `missing: ${missingLabels.join(' | ')}`,
    'remove the 40-char clamp in loginsEntryOf (src/screen/boot-face/logins/facts.ts) and widen the left panel in composeBootMenuWide (assets/splash/splash-core.mjs)',
  )

  const clippedLabelLines = frame120
    .split('\n')
    .filter(line => line.includes('—') && /…/.test(line))
  check(
    '120-column rendered BootLoginsScreen has no label ending in …',
    clippedLabelLines.length === 0,
    clippedLabelLines.map(l => l.trim()).join(' | '),
    'keep full labels in loginsEntryOf (src/screen/boot-face/logins/facts.ts) and composeBootMenuWide (assets/splash/splash-core.mjs)',
  )

  const over120 = frame120.split('\n').filter(line => line.length > 120)
  check(
    '120-column rendered BootLoginsScreen fits inside 120 columns',
    over120.length === 0,
    `widest=${Math.max(0, ...over120.map(l => l.length))}`,
    'keep LEFT_W + 2 + RIGHT_W <= cols in composeBootMenuWide (assets/splash/splash-core.mjs)',
  )

  await storeZaiApiKeyLogin('zk-test-coding-plan-1234567890', 'coding', process.env, {
    probeKey: async () => ({ state: 'accepted', models: 2 }),
  })
  const zaiFacts = collectLoginsScreenFacts()
  const zaiFrame120 = stripAnsi(
    await renderToString(
      React.createElement(BootLoginsScreen, { facts: zaiFacts, fullScene: { columns: 120, rows: 45 } } as never),
      120,
    ),
  )
  check(
    '120-column rendered BootLoginsScreen shows GLM Coding Plan key state whole without cutting at (auth…',
    zaiFrame120.includes('GLM Coding Plan key (auth-scoped)') &&
      !zaiFrame120.includes('GLM Coding Plan key (auth…') &&
      zaiFrame120.includes('GLM (Z.AI) — API key (general or GLM Coding Plan)'),
    zaiFrame120
      .split('\n')
      .filter(l => l.includes('GLM'))
      .map(l => l.trim())
      .join(' | '),
    'remove the 26-char chip cut in loginsRowStateOf (src/screen/boot-face/logins/facts.ts) and wrap overflowing row states in composeBootMenuWide (assets/splash/splash-core.mjs)',
  )

  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
  const { mixedFacts } = await import('./face-logins-stills.ts')
  const bootMenuRef = {
    entries: [
      {
        label: 'Sovereign mode',
        group: 'trust',
        summary: 'no permission prompts',
        valueLabel: 'off',
        valueIsDefault: true,
        pinnedVal: null,
        detail: null,
      },
    ],
    selIdx: 0,
    summary: { profile: 'default', harness: 'helm' },
    environment: ENV,
    statusRight: 'ready',
    legend: 'esc back',
  }
  const frameBoxOf = (lines: string[]): { col: number; width: number } => {
    const top = lines.find(l => l.includes('╭')) ?? ''
    const col = top.indexOf('╭')
    const end = top.lastIndexOf('╮')
    return { col, width: end >= col && col >= 0 ? end - col + 1 : 0 }
  }
  const loginsModel = loginsMenuModelOf(liveFacts, { selIdx: 0, environment: ENV })
  const frameMismatches: string[] = []
  for (const [cols, rows] of [[120, 40], [160, 50]] as const) {
    const bootBox = frameBoxOf((core.composeBootMenu(cols, rows, bootMenuRef) as { lines: string[] }).lines)
    const loginsBox = frameBoxOf((core.composeBootMenu(cols, rows, loginsModel) as { lines: string[] }).lines)
    if (bootBox.col !== loginsBox.col || bootBox.width !== loginsBox.width) {
      frameMismatches.push(`${cols}x${rows}: logins=(col=${loginsBox.col},w=${loginsBox.width}) boot=(col=${bootBox.col},w=${bootBox.width})`)
    }
  }
  check(
    'Logins frame starts at the same column and width as Boot Menu at 120x40 and 160x50',
    frameMismatches.length === 0,
    frameMismatches.join('; '),
    'keep LEFT_W = Math.min(66, cols - RIGHT_W - 4) in composeBootMenuWide (assets/splash/splash-core.mjs) so Logins keeps the same margins and panel positions as Boot Menu',
  )

  const narrowMixed = (core.composeBootMenu(80, 24, loginsMenuModelOf(mixedFacts(), { selIdx: 0, environment: ENV })) as { lines: string[] }).lines
  const narrowZai = (core.composeBootMenu(80, 24, loginsMenuModelOf(zaiFacts, { selIdx: 0, environment: ENV })) as { lines: string[] }).lines
  const kimiRow80 = narrowMixed.find(l => l.includes('Kimi')) ?? ''
  const glmRow80 = narrowZai.find(l => l.includes('GLM')) ?? ''
  check(
    '80x24 Logins screen keeps long states whole (Kimi window reached and GLM Coding Plan key)',
    kimiRow80.includes('kimi.ai (global) · window reached') &&
      glmRow80.includes('GLM Coding Plan key (auth-scoped)') &&
      narrowMixed.every(l => l.length <= 80) &&
      narrowZai.every(l => l.length <= 80),
    `kimi=${JSON.stringify(kimiRow80.trim())} glm=${JSON.stringify(glmRow80.trim())}`,
    'reserve room for the full state before clamping the label between words in composeBootMenuClassic (assets/splash/splash-core.mjs)',
  )

  for (const cols of [80, 64] as const) {
    const model = loginsMenuModelOf(liveFacts, { selIdx: 0, environment: ENV })
    const composed = (core.composeBootMenu(cols, 40, model) as { lines: string[] }).lines
    const midWordCuts: string[] = []
    for (const line of composed) {
      if (!line.includes('…')) continue
      for (const arm of arms) {
        const prefix = arm.row.label.slice(0, 12)
        const idx = line.indexOf(prefix)
        if (idx < 0) continue
        const labelPart = line.slice(idx).split(/\s{2,}/)[0] ?? ''
        if (!labelPart.includes('…')) continue
        if (!cutBetweenWords(arm.row.label, labelPart)) {
          midWordCuts.push(`${cols}col: ${labelPart}`)
        }
      }
    }
    const overCols = composed.filter(l => l.length > cols)
    check(
      `${cols}-column Logins screen cuts only between words and fits ${cols} columns`,
      midWordCuts.length === 0 && overCols.length === 0,
      `midWord=[${midWordCuts.join(' | ')}] overCols=${overCols.length}`,
      'use word-boundary clamping in composeBootMenuClassic (assets/splash/splash-core.mjs) and stop clamping labels mid-word in loginsEntryOf (src/screen/boot-face/logins/facts.ts)',
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-logins-state-words: ALL LAWS HOLD' : `\nprove-logins-state-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
