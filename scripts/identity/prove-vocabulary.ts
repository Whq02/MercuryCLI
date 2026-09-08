#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

const OTHER_ENTER_GLYPH = String.fromCharCode(0x23ce)
const otherEnterEscapeRe = new RegExp('\\\\u\\{?' + '23' + 'ce', 'i')

const WORDS: Array<[string, RegExp]> = [
  ['the thing is an extension', new RegExp(
    '(?<!Bun\\.)(?<!\\{ )(?<!eslint-)(?<!lint/)(?<!DISABLE_)(?<!JetBrains[- ])(?<!IDE )(?<!editor )(?<!Editor)\\b' + J('plug', 'ins?') + '\\b(?!\\(\\{)(?!\\.cfg)(?!\\.gd)(?!: \\[)',
    'i',
  )],
  ['it comes from a source', new RegExp(J('market', 'place'), 'i')],
]

const CONCOURSE_HOME = new RegExp('^src/(components|services)/concourse/')
const crumbUpperRe = new RegExp('[Mm]ain[- ]' + J('RE', 'PL'))
const crumbSpacedRe = new RegExp(J('main', '[ ]', 'repl'), 'i')
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line)

const ALLOW: Array<[string, string, string]> = [
  ['scripts/identity/prove-vocabulary.ts', '*', 'this check composes the needles it holds'],
  ['scripts/interview/baselines/', 'enter-glyph', 'frozen journey capture records keep their recorded bytes by design'],
  ['scripts/visual-contract/baselines/', 'enter-glyph', 'frozen capture records of earlier screens — diff anchors, deliberately never regenerated'],
  ['assets/vulcan/', 'words', "Godot's editor addon API (EditorPlugin, plugin.cfg, plugin.gd) — the engine's own vocabulary"],
  ['src/services/vulcan/', 'words', "Godot's editor addon API — the engine's own vocabulary"],
  ['src/utils/vulcan/', 'words', "Godot's editor addon API — the engine's own vocabulary (generated op table)"],
  ['scripts/vulcan/', 'words', "Godot's editor addon API — the engine's own vocabulary"],
  ['src/services/lsp/godotLane.ts', 'words', "Godot's editor addon API"],
  ['src/utils/jetbrains.ts', 'words', "the JetBrains IDE integration — that product's own word for its editor add-ons"],
  ['src/utils/ide.ts', 'words', "the JetBrains IDE integration — that product's own word for its editor add-ons"],
  ['src/utils/status.tsx', 'words', "the JetBrains IDE integration — that product's own word"],
  ['src/components/IdeOnboardingDialog.tsx', 'words', "the JetBrains IDE integration — that product's own word"],
  ['src/hooks/notifs/useIDEStatusIndicator.tsx', 'words', "the JetBrains IDE integration — that product's own word"],
  ['src/commands/ide/', 'words', "the JetBrains IDE integration — that product's own word"],
  ['scripts/lsp/prove-ide-detect.ts', 'words', "the JetBrains IDE integration — that product's own word"],
  ['scripts/substrate/prove-identity-constants.ts', 'words', "the JetBrains IDE integration — that product's own word"],
  ['src/services/ide/pythonTests.ts', 'words', "pytest's own vocabulary for its add-ons"],
  ['BUILD-NOTES.md', 'words', "Bun's build API vocabulary (the build's module-resolution hook)"],
  ['MERCURY-COMMUNITY-PRODUCTION-TERMS.md', 'words', "the licence's companion terms: generic legal enumerations of third-party things, in the licence's own wording"],
  ['scripts/gate/gate-ledger.jsonl', 'words', 'an append-only record of past gate runs'],
  ['scripts/project-intel/fixtures/', 'words', 'fixture repositories exercise ordinary English'],
  ['scripts/search/fixtures/', 'words', "captured third-party search-result pages — the outside world's own text, replayed verbatim"],
  ['scripts/search/prove-websearch-doors.ts', 'words', 'names the needles it refuses in its negative user-agent checks'],
  ['scripts/search/lib/bundle-for-node.ts', 'words', "Bun's build API vocabulary (the bundling hook)"],
]
function allowed(path: string, rule: string): boolean {
  for (const [prefix, rules] of ALLOW) {
    if (path === prefix || path.startsWith(prefix)) {
      if (rules === '*' || rules.split(',').includes(rule)) return true
    }
  }
  return false
}

const BINARY_EXT = /\.(png|jpe?g|gif|ico|icns|pdf|wasm|woff2?|ttf|otf|node|zip|gz|tgz|jar|mp[34]|exe|dylib|so|bin|zst|tar|wav)$/i

type Violation = { path: string; line: number; rule: string; text: string }

function scan(files: Array<{ path: string; content: string }>): Violation[] {
  const out: Violation[] = []
  for (const f of files) {
    const lines = f.content.split('\n')
    const srcCode = f.path.startsWith('src/') && /\.(ts|tsx)$/.test(f.path)
    const concourse = CONCOURSE_HOME.test(f.path)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if ((line.includes(OTHER_ENTER_GLYPH) || otherEnterEscapeRe.test(line)) && !allowed(f.path, 'enter-glyph')) {
        out.push({ path: f.path, line: i + 1, rule: 'enter-glyph', text: line.trim().slice(0, 140) })
      }
      if (!allowed(f.path, 'words')) {
        for (const [label, re] of WORDS) {
          if (re.test(line)) {
            out.push({ path: f.path, line: i + 1, rule: `words:${label}`, text: line.trim().slice(0, 140) })
            break
          }
        }
      }
      if (srcCode && (concourse || !isCommentLine(line)) && (crumbUpperRe.test(line) || crumbSpacedRe.test(line))) {
        out.push({ path: f.path, line: i + 1, rule: 'focused-chat', text: line.trim().slice(0, 140) })
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
console.log(' vocabulary — the tree speaks the product\'s own words')
console.log('============================================================')

{
  const enterBad = scan([{ path: 'fixture/enter.ts', content: ["const legend = '" + OTHER_ENTER_GLYPH + " confirm'", "controls: 'one call per \\" + 'u' + '23' + "ce'"].join('\n') }])
  check('§1 self-test: the other Enter glyph trips (literal + escape spelling)', enterBad.filter(v => v.rule === 'enter-glyph').length === 2, enterBad.map(v => v.rule).join(','))
  const enterGood = scan([{ path: 'fixture/enter-kit.ts', content: "const legend = '↵ confirm · esc cancel'" }])
  check('§1 self-test: the kit glyph stays silent', enterGood.length === 0, enterGood.map(v => v.rule).join(','))
  const frozen = scan([{ path: 'scripts/interview/baselines/x.txt', content: OTHER_ENTER_GLYPH }])
  check('§1 self-test: a frozen capture record is exempt', frozen.length === 0, frozen.map(v => v.rule).join(','))

  const wordsBad = scan([{ path: 'fixture/words.md', content: 'Install the ' + J('plug', 'in') + ' from the ' + J('market', 'place') + '.' }])
  check('§2 self-test: the two outside words trip', wordsBad.length === 1 && wordsBad[0]!.rule.startsWith('words:'), wordsBad.map(v => v.rule).join(','))
  const carved = scan([{ path: 'fixture/carved.ts', content: [
    "import { " + J('plug', 'in') + " } from 'bun'",
    '// biome-ignore lint/' + J('plug', 'in') + ': x',
    'const PYTEST_DISABLE_' + J('PLUG', 'IN') + '_AUTOLOAD = 1',
    'the JetBrains ' + J('plug', 'in') + ' directory',
    'plugins: [mercury' + J('Plug', 'in') + ']',
  ].join('\n') }])
  check('§2 self-test: the third-party senses stay silent', carved.length === 0, carved.map(v => v.text).join(' | '))
  const product = scan([{ path: 'fixture/product.md', content: 'An extension comes from a source; add one with /extensions.' }])
  check('§2 self-test: the product words pass', product.length === 0, product.map(v => v.rule).join(','))

  const crumb = 'esc ' + J('main', ' ', 'RE', 'PL')
  const crumbHits = scan([{ path: 'src/components/x.tsx', content: "const label = '" + crumb + "'" }])
  check('§3 self-test: the crumb phrase trips as screen text', crumbHits.length === 1 && crumbHits[0]!.rule === 'focused-chat', JSON.stringify(crumbHits))
  const crumbComment = scan([{ path: 'src/components/x.tsx', content: '// the ' + crumb + ' route' }])
  check('§3 self-test: a comment outside the concourse stays silent', crumbComment.length === 0, JSON.stringify(crumbComment))
  const crumbConcourse = scan([{ path: 'src/components/concourse/x.tsx', content: '// the ' + crumb + ' route' }])
  check('§3 self-test: the concourse holds the rule on every line', crumbConcourse.length === 1, JSON.stringify(crumbConcourse))
  const routeId = scan([{ path: 'src/components/x.tsx', content: "const id = '" + J('main-re', 'pl') + "'" }])
  check('§3 self-test: the route id stays legal', routeId.length === 0, JSON.stringify(routeId))
}

const tracked = execSync('git ls-files -z', { cwd: ROOT })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter(p => !BINARY_EXT.test(p))
const files = tracked.map(path => {
  try {
    return { path, content: readFileSync(join(ROOT, path), 'utf8') }
  } catch {
    return { path, content: '' }
  }
})
const violations = scan(files)
if (REPORT) {
  for (const v of violations) console.log(`${v.path}:${v.line}  [${v.rule}]  ${v.text}`)
  console.log(`\n${violations.length} hit(s)`)
  process.exit(0)
}
check(`tracked tree speaks the product vocabulary (${tracked.length} files)`, violations.length === 0,
  violations.slice(0, 12).map(v => `${v.path}:${v.line} [${v.rule}]`).join(' · '))

{
  const mootRows = (rows: ReadonlyArray<[string, string, string]>): string[] =>
    rows.filter(([prefix]) => !tracked.some(p => p === prefix || p.startsWith(prefix))).map(([prefix]) => prefix)
  const moot = mootRows(ALLOW)
  check('every exemption names a path the tracked tree still holds', moot.length === 0, moot.join(' · '))
  const planted = mootRows([...ALLOW, ['src/no-such-home/', 'words', 'poison: a row for a path that is gone']])
  check('exemption self-test: a planted row for an absent path is reported', planted.length === 1 && planted[0] === 'src/no-such-home/', planted.join(' · '))
}

const distPath = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(distPath)) {
  console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` for the dist rule')
} else {
  const dist = readFileSync(distPath, 'utf8')
  check('dist: zero occurrences of the other Enter glyph (the bundle speaks the kit vocabulary)', !dist.includes(OTHER_ENTER_GLYPH))
  check('dist needle control: a planted glyph trips', ('legend ' + OTHER_ENTER_GLYPH).includes(OTHER_ENTER_GLYPH))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ vocabulary: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ vocabulary: clean')
