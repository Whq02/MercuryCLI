#!/usr/bin/env bun
// ============================================================================
//  scripts/identity/prove-provider-neutral-vocabulary.ts — the provider-
//  neutral vocabulary ratchet (the identity ratchet's sibling).
//
//  Mercury assumes no provider family. A vendor's name belongs on that
//  vendor's own rows — its account label, its usage window, its attributed
//  sentence, its sign-in row, the home lane's technical names — and nowhere
//  a NEUTRAL sentence is meant: a refusal, a hint, a header, a category, a
//  remedy. Under the sovereign posture (an OpenRouter free-tier default and
//  possibly no first-party credential at all) every such sentence is a leak.
//  This prover fails when one returns:
//
//   §1 TWO-FAMILY TERNARIES — a hand-picked two-way vendor vocabulary
//      (`? 'X' : 'Y'` over the family names) in src, where the route space
//      has ten members: labels derive from providerDisplayName.
//   §2 THE UNMARKED-VENDOR SHAPES — the retired sentence shapes: a family
//      named as a category ('your gateway'), a
//      two-lane header for a ten-lane estate, a vendor door with the vendor
//      unnamed, a boot notice that LEADS with the absent first-party
//      credential, and "/logins adds <vendor>" as the generic remedy.
//   §3 THE SWEPT-SURFACE ROSTER — the swept neutral surfaces: in
//      those files every non-comment line whose string literal names the
//      first-party vendor must match a reasoned fragment; anything else is
//      a regression.
//
//  Every needle is composed from parts so this file never matches itself,
//  and the scan core is self-tested on generated fixtures before it touches
//  the real tree. Policy rows stay policy: the crew fence's "seats stay
//  Anthropic", the attributed "Anthropic says", the family's own labels are
//  ALLOWED fragments with their reason beside them.
//
//  Run:  ~/.bun/bin/bun run scripts/identity/prove-provider-neutral-vocabulary.ts
//        --report lists every hit without failing (for sweeps).
// ============================================================================
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')

const J = (...parts: string[]): string => parts.join('')
// The first-party vendor's two names and the three wallet-lane family
// names, composed so the needles never match this file.
const VENDOR = J('(Cla', 'ude|Anth', 'ropic)')
const FAMILY = J('(Cla', 'ude|Anth', 'ropic|Open', 'AI)')
const VENDOR_WORD = new RegExp(J('\\b', VENDOR, '\\b'))

// ── §1 two-family ternaries ─────────────────────────────────────────────────
const TERNARY = new RegExp(J("\\?\\s*'", FAMILY, "'\\s*:\\s*'", FAMILY, "'"))

// ── §2 the unmarked-vendor sentence shapes ──────────────────────────────────
const SHAPES: Array<[string, RegExp]> = [
  ['a family named as a category', new RegExp(J('your', ' gate', 'way'), 'i')],
  ['a two-lane header for a ten-lane estate', new RegExp(J('native', ' GPT', ' \\+ ', 'GLM'))],
  ['a vendor door with the vendor unnamed', new RegExp(J('Usage', '-based billing', ' \\(', 'Console'))],
  ['a boot notice leading with the absent first-party credential', new RegExp(J("['\"`]No ", VENDOR, ' credential:'))],
  ['the generic remedy naming one vendor', new RegExp(J('/logins', ' adds ', 'Cla', 'ude\\b'))],
]

// ── §3 the swept-surface roster and its reasoned fragments ─────────────────
const ROSTER = [
  'src/services/wallet/wallet.ts',
  'src/services/providers/providerUsability.ts',
  'src/services/providers/providerUsage.ts',
  'src/services/providers/homeLaneAdmission.ts',
  'src/services/providers/idSpaces.ts',
  'src/services/providers/callModelRouter.ts',
  'src/services/tokenEstimation.ts',
  'src/components/messages/AssistantTextMessage.tsx',
  'src/components/loginFamilyRows.ts',
  'src/commands/router/router.tsx',
  'src/utils/model/defaultProviderRung.ts',
  'src/utils/model/validateModel.ts',
]
const FRAGMENTS: Array<[string, RegExp]> = [
  ["the attributed frame — the provider's own sentence, never a voice of god", new RegExp(J('Anth', 'ropic says'))],
  ["the family's own credential and row labels", new RegExp(J('(Cla', 'ude subscription|Cla', 'ude account \\(|Anth', 'ropic (API key|bearer token|Console|account|credential|sign-in|usage|slot|logged in))'))],
  ['the subscription tier label (the plan word rides the template)', new RegExp(J('Cla', 'ude \\$\\{'))],
  ["the home lane's technical names", new RegExp(J('Anth', 'ropic(-compatible| (lane|route|origin|wire|window|usage window|family|snapshot|frontier|main loop|Messages|transport))'))],
  ['the dormant first-party ACCOUNT surfaces, named as what they are', new RegExp(J('Cla', 'ude-account'))],
  ['the ruled crew fence', new RegExp(J('seats stay ', 'Anth', 'ropic'))],
  ["the family's own /logins word", new RegExp(J('/logins adds ', 'Anth', 'ropic'))],
  ['the marketing-name table rows (a model name, not a sentence)', new RegExp(J("'Cla", 'ude 3'))],
  ["the operator's ruled /router refusal — any provider word points at that family's own /logins door by name, never a silent fall to one lane", new RegExp(J('OpenAI and ', 'Anth', 'ropic keys attach through /logins'))],
]

const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line)
// An import specifier is not screen text (the SDK's default-import
// identifier spells the vendor); the roster law reads sentence-bearing lines.
const isImportLine = (line: string): boolean => /^\s*(import|export)\b.*\bfrom\b/.test(line)
const literalBearing = (line: string): boolean => /['"`]/.test(line) && !isImportLine(line)

type Violation = { path: string; line: number; law: string; text: string }

/** The ONE scan core — fixtures and the real tree both go through here. */
function scan(files: Array<{ path: string; content: string }>, roster: ReadonlySet<string>): Violation[] {
  const out: Violation[] = []
  for (const f of files) {
    const inRoster = roster.has(f.path)
    const lines = f.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (isCommentLine(line)) continue
      if (TERNARY.test(line)) {
        out.push({ path: f.path, line: i + 1, law: 'two-family ternary', text: line.trim().slice(0, 140) })
      }
      for (const [label, re] of SHAPES) {
        if (re.test(line)) {
          out.push({ path: f.path, line: i + 1, law: `shape: ${label}`, text: line.trim().slice(0, 140) })
          break
        }
      }
      if (inRoster && literalBearing(line) && VENDOR_WORD.test(line) && !FRAGMENTS.some(([, re]) => re.test(line))) {
        out.push({ path: f.path, line: i + 1, law: 'roster: an unreasoned vendor name on a swept surface', text: line.trim().slice(0, 140) })
      }
    }
  }
  return out
}

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('============================================================')
console.log(' provider-neutral vocabulary ratchet — no family is the unmarked case')
console.log('============================================================')

// ── §0 self-test on generated fixtures ──────────────────────────────────────
{
  const bad = [
    J("const title = route === 'openai' ? 'Open", "AI' : 'Cla", "ude'"),
    J("return others.some(e => e.provider === 'openai') ? 'Open", "AI' : 'your", " gateway'"),
    J("const lines = ['engines — native", ' GPT + ', "GLM lanes']"),
    J("label: 'Usage", '-based billing (Console', " sign-in or API key)'"),
    J("return `No Anth", 'ropic credential: ${usable}', ' is the working lane`'),
    J("'tools run on the session. /logins", ' adds Cla', "ude any time.'"),
  ].join('\n')
  const rosterBad = J("  blockers.push('connect Cla", "ude before running turns')")
  const rosterGood = [
    J("  return 'Anth", "ropic says this account is close to its limit'"),
    J("  label: 'Cla", "ude subscription account',"),
    J("  // a comment naming Anth", 'ropic is not a sentence on screen'),
    J("  const subscriber = isCla", 'udeAISubscriber()'),
    J("  const lines = ['party seats stay Anth", "ropic (the ruled crew fence)']"),
    J('import Anth', "ropic from '@anth", "ropic-ai/sdk'"),
    J("  label: `Cla", 'ude account (${scope.email})`,'),
  ].join('\n')
  const roster = new Set(['fixture/roster.ts'])
  const vBad = scan([{ path: 'fixture/bad.ts', content: bad }], roster)
  check('self-test: the two-family ternary trips', vBad.some(v => v.law === 'two-family ternary'), vBad.map(v => v.law).join(','))
  check('self-test: every retired sentence shape trips', SHAPES.every(([label]) => vBad.some(v => v.law === `shape: ${label}`)), vBad.map(v => v.law).join(','))
  const vRosterBad = scan([{ path: 'fixture/roster.ts', content: rosterBad }], roster)
  check('self-test: an unreasoned vendor name on a roster surface trips', vRosterBad.length === 1 && vRosterBad[0]!.law.startsWith('roster'), JSON.stringify(vRosterBad))
  const vRosterGood = scan([{ path: 'fixture/roster.ts', content: rosterGood }], roster)
  check('self-test: attribution · account labels · comments · identifiers · the crew fence pass', vRosterGood.length === 0, vRosterGood.map(v => v.text).join(' | '))
  const vOffRoster = scan([{ path: 'fixture/elsewhere.ts', content: rosterBad }], roster)
  check('self-test: the roster law binds only the swept surfaces', vOffRoster.length === 0, JSON.stringify(vOffRoster))
}

// ── §1..§3 the real tree ────────────────────────────────────────────────────
const tracked = execSync('git ls-files -z -- src', { cwd: ROOT })
  .toString('utf8')
  .split('\0')
  .filter(p => /\.(ts|tsx)$/.test(p))
const files = tracked.map(path => {
  try {
    return { path, content: readFileSync(join(ROOT, path), 'utf8') }
  } catch {
    return { path, content: '' }
  }
})
const roster = new Set(ROSTER)
for (const path of ROSTER) {
  check(`roster surface exists: ${path}`, tracked.includes(path))
}
const violations = scan(files, roster)
if (REPORT) {
  for (const v of violations) console.log(`${v.path}:${v.line}  [${v.law}]  ${v.text}`)
  console.log(`\n${violations.length} hit(s)`)
  process.exit(0)
}
check(
  `src carries no two-family ternary, no retired vendor sentence shape, and no unreasoned vendor name on a swept surface (${tracked.length} files · ${ROSTER.length} roster surfaces)`,
  violations.length === 0,
  violations.slice(0, 12).map(v => `${v.path}:${v.line} [${v.law}] ${v.text}`).join(' · '),
)

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ provider-neutral vocabulary ratchet: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ provider-neutral vocabulary ratchet: clean')
