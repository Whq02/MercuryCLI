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
  ['run-short', /(?<![\w-])-p(?![\w-])/],
  ['run-print', /--print(?![\w-])/],
  ['run-format', /--output-format(?![\w-])/],
  ['run-input', /--input-format(?![\w-])/],
  ['run-partial', /--include-partial-messages(?![\w-])/],
  ['run-sovereign', /--dangerously-bypass-permissions(?![\w-])/],
  ['run-allow-sovereign', /--allow-dangerously-bypass-permissions(?![\w-])/],
  ['run-mode', /--permission-mode(?![\w-])/],
]

const RUN_SCOPE = /^(?:src\/|docs\/|README\.md$|bench\/|\.github\/)/
const SETTINGS_SCOPE = /^(?:src\/|docs\/|README\.md$|scripts\/settings\/)/
const RETIRED_SETTINGS_ROOTS = [
  'apiKeyHelper', 'proxyAuthHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'fileSuggestion', 'respectGitignore', 'cleanupPeriodDays',
  'instructionExcludes', 'includeGitInstructions', 'instructionProfile', 'plansDirectory', 'showClearContextOnStrategyAccept', 'autoMemoryEnabled',
  'autoMemoryDirectory', 'memoryUpkeepEnabled', 'loopGuardStopEnabled', 'includeMercuryCoAuthor', 'allowManagedPermissionRulesOnly',
  'skipSovereignConsentPrompt', 'availableModels', 'modelOverrides', 'effortLevel', 'supercodeEffort', 'sessionDefaultsKey', 'alwaysThinkingEnabled',
  'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'allowedMcpServers', 'deniedMcpServers', 'allowManagedMcpServersOnly',
  'disableAllHooks', 'allowManagedHooksOnly', 'allowedHttpHookUrls', 'httpHookAllowedEnvVars', 'strictExtensionOnlyCustomization', 'spinnerTipsEnabled',
  'spinnerTipsOverride', 'spinnerVerbs', 'progressReporting', 'filesBox', 'modelPickerCentred', 'syntaxHighlightingDisabled', 'prefersReducedMotion',
  'backgroundKey', 'sessionsBar', 'firstRunCards', 'compactWayBack', 'promptSuggestionEnabled', 'defaultShell', 'shellEngine', 'shellEngineSessions',
  'openrouterRouting', 'channelsEnabled', 'localServer',
]
const RETIRED_SETTINGS_GENERIC_ROOTS = ['env', 'attribution', 'permissions', 'sandbox', 'model', 'agent', 'hooks', 'language', 'worktree']
const RETIRED_SETTINGS_FIELDS = [
  'disableBypassPermissionsMode', 'disableAutoMode', 'skipDangerousModePermissionPrompt', 'autoDreamEnabled', 'showClearContextOnPlanAccept',
  J('claudeMd', 'Excludes'), J('Tea', 'mmateIdle'), 'defaultMode',
]
const RETIRED_SETTINGS_MODULES = [
  'migrateSettingsSpellings', 'migrateEnableAllProjectMcpServersToSettings', 'migrateBypassPermissionsAcceptedToSettings', 'migrateAutoupdateEnvName',
  'migrateConfigSpellings',
]
const RETIRED_POLICY_PLACES = [J('com.anthropic.', 'claudecode'), J('Policies\\\\', 'ClaudeCode')]
const SETTINGS_LEAF_KEPT = new Set(['model', 'agent', 'hooks', 'sandbox', 'worktree', 'language', 'env', 'attribution', 'permissions'])
const SETTINGS_LEAF_NAMES = new Set(['backgroundKey', 'sessionsBar', 'firstRunCards'])
const asRoot = (key: string): RegExp => new RegExp(
  '(?:[sS]ettings\\w*(?:\\([^)]*\\))?\\??\\.' + key + '(?![\\w$])|(?:writeFileSync\\([^;]*JSON\\.stringify\\(|updateSettingsForSource\\([^,]+,\\s*|safeParse\\(|parse\\()\\s*\\{\\s*' + key + '\\s*:|SettingsJson\\[["\']' + key + '["\']\\])',
)
const asDistinctRoot = (key: string): RegExp => new RegExp('(?:\\)\\??\\.' + key + '(?![\\w$])|`' + key + '`)')
const asJsonKey = (key: string): RegExp => new RegExp('"' + key + '"\\s*:')
const inDocs = (key: string): RegExp => new RegExp('(?<![\\w$./\'"-])' + key + '(?![\\w$/-])')
const dottedOrNamed = (key: string): RegExp => new RegExp('`' + key + '(?:\\.[A-Za-z]+)+`|`' + key + '`\\s+(?:setting|key|block|list)')
const plainName = (key: string): RegExp => new RegExp('(?<![\\w$./\'"-])' + key + '(?![\\w$/-])')
const moduleName = (name: string): RegExp => new RegExp('(?<![\\w$-])' + name + '(?![\\w$-])')
const RELEASE_SETTINGS_LINES: Readonly<Record<string, string>> = {
  'docs/releases/1.0.0-beta.21.md': '  one stretch is asked once to continue past it; with loopGuardStopEnabled',
  'src/constants/changelog.ts': '- Added a loop guard: a tool call repeated with identical arguments and an identical result is reminded at the third, fifth and eighth repeat, a cycle of up to five calls repeated five times is named, and a reply that chants one stretch is asked once to continue past it; with loopGuardStopEnabled true in settings the second detection of the same cycle ends the turn as loop_stopped (by default nothing is ended)',
}
function settingsViolation(path: string, line: string): string | null {
  if (!SETTINGS_SCOPE.test(path) || allowed(path, 'settings')) return null
  if (RELEASE_SETTINGS_LINES[path] === line) return null
  const prose = /\.md$/.test(path) || path === 'src/constants/changelog.ts'
  for (const place of RETIRED_POLICY_PLACES) if (line.includes(place)) return `settings:${place}`
  for (const name of RETIRED_SETTINGS_MODULES) if (moduleName(name).test(line)) return `settings:${name}`
  for (const key of [...RETIRED_SETTINGS_ROOTS, ...RETIRED_SETTINGS_GENERIC_ROOTS, ...RETIRED_SETTINGS_FIELDS]) {
    if (asRoot(key).test(line) || dottedOrNamed(key).test(line)) return `settings:${key}`
    if (SETTINGS_LEAF_KEPT.has(key)) continue
    if (asDistinctRoot(key).test(line) || (!SETTINGS_LEAF_NAMES.has(key) && asJsonKey(key).test(line))) return `settings:${key}`
    if (prose && inDocs(key).test(line)) return `settings:${key}`
  }
  return null
}
const CONCOURSE_HOME = new RegExp('^src/(components|services)/concourse/')
const crumbUpperRe = new RegExp('[Mm]ain[- ]' + J('RE', 'PL'))
const crumbSpacedRe = new RegExp(J('main', '[ ]', 'repl'), 'i')
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line)

const ALLOW: Array<[string, string, string]> = [
  ['scripts/identity/prove-vocabulary.ts', '*', 'this check composes the needles it holds'],
  ['src/services/ide/pythonTests.ts', 'run-short', 'pytest selects its own modules'],
  ['src/tools/BashTool/readOnlyValidation.ts', 'run-short', 'shell utility argument grammars'],
  ['src/tools/PowerShellTool/readOnlyValidation.ts', 'run-short', 'shell utility argument grammars'],
  ['src/utils/shell/readOnlyCommandValidation.ts', 'run-short', 'git and language-tool argument grammars'],
  ['src/utils/bash/ast.ts', 'run-short', 'the shell wait builtin argument grammar'],
  ['src/utils/bash/specs/pyright.ts', 'run-short', 'pyright project selection'],
  ['src/tools/AgentTool/reviewerPolicy.ts', 'run-short', 'mktemp scratch selection'],
  ['src/utils/processGroup.ts', 'run-short', 'POSIX process inspection'],
  ['src/daemon/processSweepPosix.ts', 'run-short', 'POSIX process inspection'],
  ['src/daemon/ownerWatch.ts', 'run-short', 'POSIX process inspection'],
  ['scripts/interview/baselines/', 'enter-glyph', 'frozen journey capture records keep their recorded bytes by design'],
  ['scripts/visual-contract/baselines/', 'enter-glyph', 'frozen capture records of earlier screens — diff anchors, deliberately never regenerated'],
  ['assets/vulcan/', 'words', "Godot's editor addon API (EditorPlugin, plugin.cfg, plugin.gd) — the engine's own vocabulary"],
  ['src/services/vulcan/', 'words', "Godot's editor addon API — the engine's own vocabulary"],
  ['src/utils/vulcan/', 'words', "Godot's editor addon API — the engine's own vocabulary (generated op table)"],
  ['scripts/vulcan/', 'words', "Godot's editor addon API — the engine's own vocabulary"],
  ['src/services/lsp/godotLane.ts', 'words', "Godot's editor addon API"],
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

const XAI_CLIENT_REFERENCES = new Set([
  'mercury-skills/provider-apis/references/live-sources.md',
  'src/skills/bundled/provider-apis/references/live-sources.md',
  'scripts/providers/fixtures/xai-subscription-contract.json',
])
const RELEASE_RUN_LINES: Readonly<Record<string, string>> = {
  'src/constants/changelog.ts': '- Fixed mercury -p /usage (and the other screen-only commands) printing nothing instead of saying they need the interactive session',
  'docs/releases/1.0.0-beta.26.md': '- Fixed mercury -p /usage (and the other screen-only commands) printing',
}

function ownWords(path: string, line: string): string {
  if (!XAI_CLIENT_REFERENCES.has(path)) return line
  return line.replaceAll('packages/opencode/src/plugin/xai.ts', '')
    .replaceAll('packages/core/src/plugin/provider/xai.ts', '')
    .replaceAll('OpenCode auth plugin', '')
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
      for (const [label, re] of WORDS) {
        const runRule = label.startsWith('run-')
        if (runRule ? !RUN_SCOPE.test(f.path) || allowed(f.path, 'run') || allowed(f.path, label) : allowed(f.path, 'words')) continue
        if (runRule && RELEASE_RUN_LINES[f.path] === line) continue
        let checked = ownWords(f.path, line)
        if (label === 'run-short') {
          checked = checked.replace(/\b(?:spawnSync|spawn|execFileSync|run)\(['"](?:ps|node|unzip|lsof|tmux)['"],\s*\[[^\n]*?['"]-p['"]/g, value => value.replace(/['"]-p['"]/, ''))
          checked = checked.replace(/\b(?:mkdir|ps|shopt|mktemp)\s+[^;&|\n]*?(?<![\w-])-p(?![\w-])/g, value => value.slice(0, -2))
        }
        if (re.test(checked)) {
          out.push({ path: f.path, line: i + 1, rule: `words:${label}`, text: line.trim().slice(0, 140) })
          break
        }
      }
      if (srcCode && (concourse || !isCommentLine(line)) && (crumbUpperRe.test(line) || crumbSpacedRe.test(line))) {
        out.push({ path: f.path, line: i + 1, rule: 'focused-chat', text: line.trim().slice(0, 140) })
      }
      const settingsRule = settingsViolation(f.path, line)
      if (settingsRule !== null) out.push({ path: f.path, line: i + 1, rule: settingsRule, text: line.trim().slice(0, 140) })
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
  const foreignReferences = 'packages/opencode/src/plugin/xai.ts packages/core/src/plugin/provider/xai.ts OpenCode auth plugin'
  check('external-client references keep their own paths and vocabulary only in the recorded sources',
    [...XAI_CLIENT_REFERENCES].every(path => scan([{ path, content: foreignReferences }]).length === 0) &&
      scan([{ path: 'docs/other.md', content: foreignReferences }]).length === 1)
  check('the external reference carveout never excuses Mercury words beside it',
    [...XAI_CLIENT_REFERENCES].every(path => scan([{ path, content: `${foreignReferences}; Mercury plugin` }]).length === 1))
  const product = scan([{ path: 'fixture/product.md', content: 'An extension comes from a source; add one with /extensions.' }])
  check('§2 self-test: the product words pass', product.length === 0, product.map(v => v.rule).join(','))

  const runInputs = ['mercury -p "hello"', '--print', '--output-format', '--input-format', '--include-partial-messages', '--dangerously-bypass-permissions', '--allow-dangerously-bypass-permissions', '--permission-mode']
  const runHomes = ['src/run-fixture.ts', 'docs/run-fixture.md', 'README.md', 'bench/run-fixture.py', '.github/run-fixture.yml']
  check('the run words are enforced on every owned surface', runHomes.every(path => runInputs.every(content => scan([{ path, content }]).some(hit => hit.rule.startsWith('words:run-')))))
  check('the script estate is outside the run-word scope', runInputs.every(content => scan([{ path: 'scripts/run-fixture.ts', content }]).length === 0))
  check('run words and other programs remain distinct', scan([{ path: 'src/run-fixture.ts', content: 'mercury run --format rows --input rows --partial --sovereign --allow-sovereign --mode flow' }, { path: 'bench/run-fixture.ts', content: "spawnSync('ps', ['-p', pid])" }, { path: '.github/run-fixture.yml', content: 'mkdir -p output' }]).length === 0)
  check('the argv reader has no run-word exemption', scan([{ path: 'src/cli/runArgs.ts', content: '--print' }]).length === 1)
  check('the two published release lines keep their recorded bytes', Object.entries(RELEASE_RUN_LINES).every(([path, content]) => scan([{ path, content }]).length === 0))
  check('release records and foreign commands do not exempt new run spellings', scan([{ path: 'docs/releases/fixture.md', content: 'mercury -p' }, { path: 'src/constants/changelog.ts', content: 'mercury -p' }, { path: '.github/fixture.yml', content: 'mkdir -p out && mercury -p hello' }]).length === 3)

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

{
  const settingsHits = (path: string, content: string): string[] => scan([{ path, content }]).filter(v => v.rule.startsWith('settings:')).map(v => v.rule)
  const everyRoot = [...RETIRED_SETTINGS_ROOTS, ...RETIRED_SETTINGS_GENERIC_ROOTS]
  check('§4 self-test: every former root trips as a settings write in a proof', everyRoot.every(key => settingsHits('scripts/settings/prove-x.ts', `writeFileSync(join(home, 'settings.json'), JSON.stringify({ ${key}: value }))`).length === 1))
  check('§4 self-test: every former root trips as an updateSettingsForSource write', everyRoot.every(key => settingsHits('src/x.ts', `updateSettingsForSource('userSettings', { ${key}: value })`).length === 1))
  check('§4 self-test: every former root trips as a read off the settings', everyRoot.every(key => settingsHits('src/x.ts', `const v = getInitialSettings().${key} ?? settings.${key}`).length === 1))
  check('§4 self-test: every former root trips as a SettingsJson index', everyRoot.every(key => settingsHits('scripts/settings/prove-x.ts', `type T = SettingsJson['${key}']`).length === 1))
  check('§4 self-test: every former root trips as a dotted path in the docs', everyRoot.every(key => settingsHits('docs/x.md', 'set `' + key + '.leaf` in settings.json').length === 1))
  check('§4 self-test: a distinct former root trips as a backticked name and as a settings word in the docs', RETIRED_SETTINGS_ROOTS.every(key => settingsHits('README.md', 'toggle `' + key + '` in /config').length === 1 && settingsHits('docs/x.md', `the ${key} setting (toggled in /config)`).length === 1))
  check('§4 self-test: a distinct former root trips as a JSON key unless it lives on as a leaf name under a group', RETIRED_SETTINGS_ROOTS.every(key => settingsHits('scripts/settings/fixture.json', `  "${key}": true,`).length === (SETTINGS_LEAF_NAMES.has(key) ? 0 : 1)))
  check('§4 self-test: every former adoption field trips in a settings file', RETIRED_SETTINGS_FIELDS.every(key => settingsHits('scripts/settings/fixture.json', `  "${key}": true,`).length === 1))
  check('§4 self-test: every retired module name trips in src', RETIRED_SETTINGS_MODULES.every(name => settingsHits('src/x.ts', `import { x } from './migrations/${name}.js'`).length === 1))
  check('§4 self-test: the two former policy places trip in src', RETIRED_POLICY_PLACES.every(place => settingsHits('src/utils/settings/mdm/x.ts', `const DOMAIN = '${place}'`).length === 1))
  const quiet: Array<[string, string]> = [
    ['src/x.ts', "const prefersReducedMotion = useAppState(state => state.settings.view?.reducedMotion === true)"],
    ['src/x.ts', "const effortLevel = (opts.effort as EffortLevel | undefined) ?? getInitialSettings().engine?.effort"],
    ['src/x.ts', "facts: { modelId, effortLevel: 'high', instructionProfile: 'native' }"],
    ['src/x.ts', "const shell = manifest.shellEngine as { vendored?: boolean }"],
    ['src/x.ts', "body: JSON.stringify({ model: tag, stream: true })"],
    ['src/x.ts', "const id = `agent:${agentId}`; const row = `model:${modelId}`; env: subprocessEnv()"],
    ['src/x.ts', "import { localServerSettingsOf } from '../../services/localServer/localServerKnobs.js'"],
    ['src/x.ts', "updateSettingsForSource('userSettings', { guardrails: { allow: rules }, events: { hooks }, extensions: { exclusive: true }, local: { server: { keepAlive: '30m' } } })"],
    ['src/x.ts', "const centred = settings.view?.modelPicker?.centred ?? settings.view?.sessionsBar; const m = getInitialSettings().engine?.model"],
    ['scripts/settings/settings-schema.json', '        "sessionsBar": {'],
    ['scripts/settings/settings-schema.json', '        "backgroundKey": {'],
    ['docs/x.md', 'Set `guardrails.allow`, `events.hooks.PreToolUse`, `view.sessionsBar`, `engine.model` and `local.server.keepAlive` in settings.json.'],
    ['docs/x.md', 'The `/model` picker and the `agent` definitions, with `permissions` in the plain sense.'],
    ['src/x.ts', "process.env.MERCURY_SHELL_ENGINE ?? process.env.MERCURY_REDUCED_MOTION"],
  ]
  check('§4 self-test: the current nested forms, the ordinary identifiers and the API bodies stay quiet', quiet.every(([path, content]) => settingsHits(path, content).length === 0), quiet.filter(([path, content]) => settingsHits(path, content).length > 0).map(([, content]) => content).join(' | '))
  check('§4 self-test: the settings rows do not reach the rest of the script estate', settingsHits('scripts/ui/prove-x.ts', "writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true }))").length === 0 && settingsHits('scripts/settings/prove-x.ts', "writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true }))").length === 1)
  check('§4 self-test: the two published release lines keep their recorded bytes, and a changed line trips', Object.entries(RELEASE_SETTINGS_LINES).every(([path, content]) => settingsHits(path, content).length === 0 && settingsHits(path, content + ' more').length === 1))
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
  check('every external-client reference scope names a tracked file', [...XAI_CLIENT_REFERENCES].every(path => tracked.includes(path)))
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
