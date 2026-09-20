#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
const ROOT = join(REPO, 'scripts')

type Family = { name: string; seed: RegExp; seam: string; road: string }

const FAMILIES: Family[] = [
  { name: 'anthropic', seed: /claudeAiOauth|saveOAuthTokensIfNeeded\(/, seam: 'MERCURY_CUSTOM_OAUTH_URL', road: 'the token refresh and the profile read' },
  { name: 'openai', seed: /\.openai-auth\.json/, seam: 'MERCURY_OPENAI_AUTH_BASE', road: 'the token refresh at the issuer' },
  { name: 'gemini', seed: /\.gemini-auth\.json/, seam: 'MERCURY_GEMINI_OAUTH_TOKEN_BASE', road: 'the token refresh' },
  { name: 'huggingface', seed: /\.huggingface-auth\.json/, seam: 'MERCURY_HUGGINGFACE_HUB_BASE', road: 'the token refresh and the identity read' },
  { name: 'moonshot', seed: /\.moonshot-auth\.json/, seam: 'MERCURY_MOONSHOT_OAUTH_BASE', road: 'the token refresh' },
  { name: 'openrouter', seed: /\.openrouter-auth\.json/, seam: 'MERCURY_OPENROUTER_API_BASE', road: 'the key probe and the model list' },
]

const BOOTS = /mercury\.mjs|dupline-world|scriptedTurn|captureDriver|authRetryFixture|journeyFixtures|bootRunner\(|vshot\.py|render-tui/
const SOURCE_REFRESH = /checkAndRefreshOAuthTokenIfNeeded\(|refreshOAuthToken\(|getAnthropicClient\(|populateOAuthAccountInfoIfNeeded\(|handleOAuth401Error\(/
const AXIOS_MOCK = /axios\.defaults\.adapter\s*=/
const EGRESS_REDIRECT = /authRetryNetworkFixture/
const SCENARIOS = join(ROOT, 'ui', 'renderScenarios.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const files: string[] = []
function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules') continue
      walk(path)
      continue
    }
    if (path.endsWith('.ts') || path.endsWith('.py')) files.push(path)
  }
}
walk(ROOT)

function helpersOf(file: string, text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/from '(\.[^']+\.ts)'/g)) {
    const target = resolve(dirname(file), m[1]!)
    if (existsSync(target)) out.push(target)
  }
  return out
}

function names(file: string, text: string, seam: string): boolean {
  if (text.includes(seam)) return true
  return helpersOf(file, text).some(helper => readFileSync(helper, 'utf8').includes(seam))
}

function withHelpers(file: string, text: string): string {
  return [text, ...helpersOf(file, text).filter(helper => helper !== SCENARIOS).map(helper => readFileSync(helper, 'utf8'))].join('\n')
}

function code(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""')
}

const rel = (file: string): string => relative(REPO, file)

console.log('§1 every proof that stores a family sign-in in a scratch home and boots the built product names that family\'s sign-in seam')
const offenders: string[] = []
for (const file of files) {
  if (file === SCENARIOS) continue
  const text = readFileSync(file, 'utf8')
  if (!BOOTS.test(text)) continue
  const seeded = withHelpers(file, text)
  if (EGRESS_REDIRECT.test(seeded)) continue
  for (const family of FAMILIES) {
    if (!family.seed.test(seeded)) continue
    if (names(file, text, family.seam)) continue
    offenders.push(`${rel(file)} stores a ${family.name} sign-in and boots the product without ${family.seam} (${family.road} reaches the live host from a run outside the hosted shard)`)
  }
}
check('no boot proof leaves a stored sign-in\'s live road open', offenders.length === 0, `${offenders.length} open road(s)`)
for (const line of offenders) console.log(`    ${line}`)

console.log('§2 every render scenario that stores a family sign-in names that family\'s sign-in seam inside its own block')
const scenarioText = readFileSync(SCENARIOS, 'utf8')
const lines = scenarioText.split('\n')
const starts: Array<{ line: number; name: string }> = []
for (let i = 0; i < lines.length; i++) {
  const m = /^  if \(name === '([^']+)'/.exec(lines[i]!)
  if (m) starts.push({ line: i, name: m[1]! })
}
const openBlocks: string[] = []
for (let k = 0; k < starts.length; k++) {
  const end = k + 1 < starts.length ? starts[k + 1]!.line : lines.length
  const block = lines.slice(starts[k]!.line, end).join('\n')
  for (const family of FAMILIES) {
    if (!family.seed.test(block)) continue
    if (block.includes(family.seam)) continue
    openBlocks.push(`scenario ${starts[k]!.name} (line ${starts[k]!.line + 1}) stores a ${family.name} sign-in without ${family.seam}`)
  }
}
check('no render scenario leaves a stored sign-in\'s live road open', openBlocks.length === 0, `${openBlocks.length} open block(s)`)
for (const line of openBlocks) console.log(`    ${line}`)

console.log('§3 every source-level proof that walks the Anthropic refresh road with a stored sign-in names the sign-in seam')
const sourceOffenders: string[] = []
for (const file of files) {
  if (file === SCENARIOS) continue
  const text = readFileSync(file, 'utf8')
  if (BOOTS.test(text)) continue
  const body = code(text)
  if (!SOURCE_REFRESH.test(body)) continue
  if (!/claudeAiOauth|saveOAuthTokensIfNeeded\(/.test(withHelpers(file, text))) continue
  if (AXIOS_MOCK.test(body)) continue
  if (names(file, text, 'MERCURY_CUSTOM_OAUTH_URL')) continue
  sourceOffenders.push(`${rel(file)} calls the refresh road with a stored sign-in and no MERCURY_CUSTOM_OAUTH_URL`)
}
check('no source-level refresh proof leaves the token endpoint live', sourceOffenders.length === 0, `${sourceOffenders.length} open road(s)`)
for (const line of sourceOffenders) console.log(`    ${line}`)

console.log('§4 the walk saw the estate')
check('the walk read more than one thousand proof files', files.length > 1000, `${files.length} files`)
check('the census knows the hosted shard\'s own pin line', readFileSync(join(ROOT, 'gate', 'ci-shard.sh'), 'utf8').includes('export MERCURY_CUSTOM_OAUTH_URL="$HERMETIC_DEAD_BASE"'))

console.log(failures === 0 ? '\nsign-in roads pinned: GREEN' : `\nsign-in roads pinned: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
