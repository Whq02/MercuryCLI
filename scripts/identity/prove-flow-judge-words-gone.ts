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

console.log(`\nflow judge words gone: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
