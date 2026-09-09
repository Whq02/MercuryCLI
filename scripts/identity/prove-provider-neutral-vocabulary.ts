#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')

const J = (...parts: string[]): string => parts.join('')
const VENDOR = J('(Cla', 'ude|Anth', 'ropic)')
const FAMILY = J('(Cla', 'ude|Anth', 'ropic|Open', 'AI)')
const VENDOR_WORD = new RegExp(J('\\b', VENDOR, '\\b'))

const TERNARY = new RegExp(J("\\?\\s*'", FAMILY, "'\\s*:\\s*'", FAMILY, "'"))

const SHAPES: Array<[string, RegExp]> = [
  ['a family named as a category', new RegExp(J('your', ' gate', 'way'), 'i')],
  ['a two-lane header for a ten-lane estate', new RegExp(J('native', ' GPT', ' \\+ ', 'GLM'))],
  ['a vendor door with the vendor unnamed', new RegExp(J('Usage', '-based billing', ' \\(', 'Console'))],
  ['a boot notice leading with the absent first-party credential', new RegExp(J("['\"`]No ", VENDOR, ' credential:'))],
  ['the generic remedy naming one vendor', new RegExp(J('/logins', ' adds ', 'Cla', 'ude\\b'))],
]

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
const isImportLine = (line: string): boolean => /^\s*(import|export)\b.*\bfrom\b/.test(line)
const literalBearing = (line: string): boolean => /['"`]/.test(line) && !isImportLine(line)

type Violation = { path: string; line: number; law: string; text: string }

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
console.log(' provider-neutral vocabulary — no family is the unmarked case')
console.log('============================================================')

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
  check('self-test: every unmarked-vendor sentence shape trips', SHAPES.every(([label]) => vBad.some(v => v.law === `shape: ${label}`)), vBad.map(v => v.law).join(','))
  const vRosterBad = scan([{ path: 'fixture/roster.ts', content: rosterBad }], roster)
  check('self-test: an unreasoned vendor name on a roster surface trips', vRosterBad.length === 1 && vRosterBad[0]!.law.startsWith('roster'), JSON.stringify(vRosterBad))
  const vRosterGood = scan([{ path: 'fixture/roster.ts', content: rosterGood }], roster)
  check('self-test: attribution · account labels · comments · identifiers · the crew fence pass', vRosterGood.length === 0, vRosterGood.map(v => v.text).join(' | '))
  const vOffRoster = scan([{ path: 'fixture/elsewhere.ts', content: rosterBad }], roster)
  check('self-test: the roster law binds only the swept surfaces', vOffRoster.length === 0, JSON.stringify(vOffRoster))
}

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
  `src carries no two-family ternary, no unmarked-vendor sentence shape, and no unreasoned vendor name on a swept surface (${tracked.length} files · ${ROSTER.length} roster surfaces)`,
  violations.length === 0,
  violations.slice(0, 12).map(v => `${v.path}:${v.line} [${v.law}] ${v.text}`).join(' · '),
)

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ provider-neutral vocabulary: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ provider-neutral vocabulary: clean')
