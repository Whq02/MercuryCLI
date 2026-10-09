#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const REPO = join(import.meta.dir, '..', '..')
const J = (...parts: string[]): string => parts.join('')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const ENV_NAMES = [J('MERCURY_CLASS', 'IFIER_FALLBACK'), J('MERCURY_CLASS', 'IFIER_FAIL_CLOSED')]
const SETTINGS_ROOT = J('auto', 'Mode')
const READERS = [J('getAuto', 'ModeConfig'), J('hasAuto', 'ModeOptIn'), J('to', 'AutoClassifierInput'), J('classify', 'FlowAction'), J('auto-mode-class', 'ifier-prompts')]
const PRODUCT_PHRASES = [
  J('auto-mode class', 'ifier'),
  J('flow class', 'ifier'),
  J('Flow class', 'ifier'),
  J('flow-class', 'ifier'),
  J('classify_', 'result'),
  J("Flow's safety", ' check'),
  J('flow safety', ' check'),
  J('a class', 'ifier answers'),
  J('auto_', 'mode'),
  J('bash_class', 'ifier'),
  J('The semantic Bash-rule class', 'ifier'),
  J('permission_', 'retry'),
]
const STAGE_WORDS = [J("'class", "ifier'"), J("'denial", "Limit'"), J("'allowDenial", "Reset'")]

const productFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return productFiles(path)
    return /\.(tsx?|txt)$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : []
  })
const PUBLISHED_HISTORY = 'src/constants/changelog.ts'
const files = productFiles(join(REPO, 'src'))
const sources = new Map(files.map(path => [relative(REPO, path), readFileSync(path, 'utf8')]).filter(([rel]) => rel !== PUBLISHED_HISTORY))

section('§1 the two env names left the registry and no source file spells them')
{
  const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')
  for (const name of ENV_NAMES) {
    check(`${name}: the registry does not know it`, getFlagSpec(name) === undefined)
    const spelled = [...sources].filter(([, text]) => text.includes(name)).map(([rel]) => rel)
    check(`${name}: no source file spells it`, spelled.length === 0, spelled.join(', '))
  }
}

section('§2 the settings root is read by nothing: no reader function, no prompt asset, no projection hook')
{
  for (const reader of READERS) {
    const spelled = [...sources].filter(([, text]) => text.includes(reader)).map(([rel]) => rel)
    check(`${reader}: no source file names it`, spelled.length === 0, spelled.slice(0, 8).join(', ') + (spelled.length > 8 ? ` … (${spelled.length})` : ''))
  }
  const rootReads = [...sources].filter(([, text]) => new RegExp(`\\.${SETTINGS_ROOT}\\b|${SETTINGS_ROOT}\\s*:\\s*z\\.`).test(text)).map(([rel]) => rel)
  check(`${SETTINGS_ROOT}: no settings reader or schema field carries it`, rootReads.length === 0, rootReads.join(', '))
}

section('§3 no product string names the judge: every string, template part and JSX text in src is read through the parser')
{
  const hits = new Map<string, string[]>()
  for (const [rel, text] of sources) {
    if (!/\.tsx?$/.test(rel)) continue
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      const words = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node) ? node.text : undefined
      if (words !== undefined) {
        for (const phrase of PRODUCT_PHRASES) {
          if (words.includes(phrase)) hits.set(phrase, [...(hits.get(phrase) ?? []), `${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`])
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  for (const phrase of PRODUCT_PHRASES) {
    check(`no product string carries ${JSON.stringify(phrase)}`, !hits.has(phrase), (hits.get(phrase) ?? []).slice(0, 6).join(' · '))
  }
  const assets = [...sources].filter(([rel]) => rel.endsWith('.txt') && rel.includes(J('class', 'ifier'))).map(([rel]) => rel)
  check('no prompt asset of the judge remains under src', assets.length === 0, assets.join(', '))
}

section('§4 the decision band names no judge stage')
{
  const trace = sources.get('src/utils/permissions/decision/trace.ts') ?? ''
  const wrapper = sources.get('src/utils/permissions/decision/wrapper.ts') ?? ''
  for (const word of STAGE_WORDS) {
    check(`the trace carries no ${word} stage`, !trace.includes(word), 'trace.ts')
    check(`the wrapper records no ${word} stage`, !wrapper.includes(word), 'wrapper.ts')
  }
  const judgeFiles = [...sources].filter(([rel]) => /src\/utils\/permissions\/(flowClass|class)ifier|flowBlockReview|classifierApprovals|bashClass/.test(rel)).map(([rel]) => rel)
  check('no module of the judge remains under src', judgeFiles.length === 0, judgeFiles.join(', '))
}

section('§5 the spellings the Flow gate and the needs-you feature shed are on no file under src, scripts or docs')
{
  const RETIRED_SPELLINGS = [
    J('isAutoMode', 'GateEnabled'),
    J('isAutoMode', 'DisabledBySettings'),
    J('stripDangerousPermissionsFor', 'AutoMode'),
    J('getAutoMode', 'UnavailableReason'),
    J('getAutoMode', 'UnavailableNotification'),
    J('AutoMode', 'UnavailableReason'),
    J('transitionPlan', 'AutoMode'),
    J('isAutoMode', 'Available'),
    J('AUTO_MODE_', 'ATTACHMENT_CONFIG'),
    J('canCycle', 'ToAuto'),
    J('autoMode', 'Active'),
    J('autoMode', 'Changed'),
    J('agentState', 'Classifier'),
    J('useAgentState', 'Classifier'),
    J('agentState', 'ClassifierEnabled'),
    J('MERCURY_AGENT_', 'CLASSIFIER'),
    J('MERCURY_AGENT_', 'CLASSIFIER_LLM'),
    J('CLASSIFIER_', 'SYSTEM_PROMPT'),
    J('agent_', 'classifier'),
    J('prove-auto', '-mode'),
    J('prove-agent', '-classifier'),
  ]
  const TEXT = /\.(tsx?|mts|cts|[cm]?jsx?|sh|bash|json|jsonl|md|txt|tsv|csv|ya?ml|toml|html|css|ps1|py)$/
  const SELF = relative(REPO, new URL(import.meta.url).pathname)
  const tree = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', 'src', 'scripts', 'docs'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(rel => rel !== '' && rel !== SELF && TEXT.test(rel))
  const hits = new Map<string, string[]>()
  for (const rel of tree) {
    const text = readFileSync(join(REPO, rel), 'utf8')
    for (const spelling of RETIRED_SPELLINGS) {
      if (rel.includes(spelling) || text.includes(spelling)) hits.set(spelling, [...(hits.get(spelling) ?? []), rel])
    }
  }
  check(`the seal reads the three trees (${tree.length} files)`, tree.length > 1000)
  for (const spelling of RETIRED_SPELLINGS) {
    const where = hits.get(spelling) ?? []
    check(`${spelling}: on no file name and in no file`, where.length === 0, where.slice(0, 6).join(' · ') + (where.length > 6 ? ` … (${where.length})` : ''))
  }
}

section('§6 the dead machinery, the alias maps and the retired words the excision shed are on no file under src, scripts, docs or assets')
{
  const TEXT = /\.(tsx?|mts|cts|[cm]?jsx?|sh|bash|json|jsonl|md|txt|tsv|csv|ya?ml|toml|html|css|ps1|py)$/
  const SELF = relative(REPO, new URL(import.meta.url).pathname)
  const UNKNOWN_COMMAND_LIST = 'scripts/identity/prove-unknown-command-answer.ts'
  const SECURITY_INSTRUCTION = 'src/constants/cyberRiskInstruction.ts'
  const TRANSCRIPT_KIND_MIGRATION = 'src/migrations/migrateTranscriptEntryKinds.ts'
  const FOREIGN_HOME_LAWS = [J('scripts/accounts/prove-accounts-', 'display.ts'), J('scripts/accounts/prove-auth-scope-', 'isolation.ts'), J('scripts/accounts/prove-account-', 'isolation.ts'), J('scripts/build-identity/prove-config-', 'home.ts')]
  const tree = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', 'src', 'scripts', 'docs', 'assets', 'build.ts', '.gitignore'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(rel => rel !== '' && rel !== SELF && (TEXT.test(rel) || rel === '.gitignore'))
  const texts = new Map(tree.map(rel => [rel, readFileSync(join(REPO, rel), 'utf8')]))
  const SPELLINGS: Array<{ word: string; except?: string[] }> = [
    { word: J('MERCURY_', 'COUNSEL') },
    { word: J('dispatch', ' throttle') },
    { word: J('fork-', 'boilerplate') },
    { word: J('FORK_BOILERPLATE', '_TAG') },
    { word: J('FORK_DIRECTIVE', '_PREFIX') },
    { word: J('UserFork', 'BoilerplateMessage') },
    { word: J('fork', 'Subagent') },
    { word: J('useAutoMode', 'UnavailableNotification') },
    { word: J('logUnary', 'Event') },
    { word: J('logUnary', 'PermissionEvent') },
    { word: J('unary', 'Logging') },
    { word: J('getCore', 'UserData') },
    { word: J('getHostPlatform', 'ForAnalytics') },
    { word: J('logAPI', 'Query') },
    { word: J('React-', 'Compiler') },
    { word: J('React ', 'Compiler') },
    { word: J('peer', 'Address') },
    { word: J('ultra', 'memory') },
    { word: J('LEGACY_ATTACHMENT', '_TYPES') },
    { word: J('LEGACY_TOOL_RESULT', '_CLEARED_MESSAGE') },
    { word: J('LEGACY_MC_', 'CLEARED_PLACEHOLDER') },
    { word: J('LEGACY_MC_', 'DIGEST_PREFIX') },
    { word: J('legacySpawn', 'LedgerPath') },
    { word: J('marble_', 'origami') },
    { word: J('marble-', 'origami'), except: [TRANSCRIPT_KIND_MIGRATION] },
    { word: J('LEGACY_ROLE', '_ALIASES') },
    { word: J('resolveWith', 'Aliases') },
    { word: J('claude', 'Shimmer') },
    { word: J('claudeBlue', '_FOR_SYSTEM_SPINNER') },
    { word: J('claudeBlueShimmer', '_FOR_SYSTEM_SPINNER') },
    { word: J('briefLabel', 'Claude') },
    { word: J('LEGACY_CRITTER', '_KEYS') },
    { word: J('assistant', 'BootActive') },
    { word: J('isAssistant', 'ModeActive') },
    { word: J('setAssistant', 'ModeActive') },
    { word: J('assistantAuto', 'Backgrounded') },
    { word: J('armForeground', 'Budget') },
    { word: J('ASSISTANT_BLOCKING', '_BUDGET_MS') },
    { word: J('ANTHROPIC_', 'LOG') },
    { word: J('domain', 'Runner') },
    { word: J('MERCURY_', 'TELEMETRY') },
  ]
  for (const { word, except } of SPELLINGS) {
    const where = tree.filter(rel => !(except ?? []).includes(rel) && (rel.includes(word) || (texts.get(rel) ?? '').includes(word)))
    check(`${word}: on no file name and in no file${except ? ` (${except.length} named holdout${except.length === 1 ? '' : 's'})` : ''}`, where.length === 0, where.slice(0, 6).join(' · ') + (where.length > 6 ? ` … (${where.length})` : ''))
  }
  const COUNSEL = new RegExp(`\\b${J('coun', 'sel')}\\b`, 'i')
  const counselFiles = tree.filter(rel => rel !== UNKNOWN_COMMAND_LIST && rel !== SECURITY_INSTRUCTION && COUNSEL.test(texts.get(rel) ?? ''))
  check(`the ${J('coun', 'sel')} word stands in no file outside the unknown-command list and the security instruction's English`, counselFiles.length === 0, counselFiles.slice(0, 6).join(' · '))
  const MANTIS = new RegExp(`\\b${J('man', 'tis')}\\b`, 'i')
  const mantisFiles = tree.filter(rel => MANTIS.test(texts.get(rel) ?? ''))
  check(`the retired critter spelling ${J('man', 'tis')} stands in no file`, mantisFiles.length === 0, mantisFiles.slice(0, 6).join(' · '))
  const ROLE_KEY = new RegExp(`(['"\`]${J('cla', 'ude')}['"\`]|\\b${J('cla', 'ude')}\\s*:)`)
  const roleFiles = tree.filter(rel => rel.startsWith('src/components/design-system/') && ROLE_KEY.test(texts.get(rel) ?? ''))
  check(`no design-system file carries ${J('cla', 'ude')} as a colour role`, roleFiles.length === 0, roleFiles.join(' · '))
  const HOME_JOIN = new RegExp(`join\\([^)]*(?:\\bhome\\b|homedir\\(\\))[^)]*,\\s*'${J('\\.cla', 'ude')}'|MERCURY_CONFIG_DIR\\s*[:=]\\s*join\\([^)]*'${J('\\.cla', 'ude')}'`)
  const homeFiles = tree.filter(rel => rel.startsWith('scripts/') && !FOREIGN_HOME_LAWS.includes(rel) && HOME_JOIN.test(texts.get(rel) ?? ''))
  check(`no proof builds a home path ending ${J('.cla', 'ude')} (${FOREIGN_HOME_LAWS.length} foreign-home laws excepted)`, homeFiles.length === 0, homeFiles.slice(0, 6).join(' · '))
  const ignore = texts.get('.gitignore') ?? ''
  check(`.gitignore names no ${J('.cla', 'ude')} directory`, !ignore.split('\n').some(line => line.trim() === J('.cla', 'ude/')), ignore.split('\n').filter(line => line.includes(J('.cla', 'ude'))).join(' · '))
}

console.log(`\nflow judge words gone: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
