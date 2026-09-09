#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = 'scripts/identity/prove-tree-hygiene.ts'
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('============================================================')
console.log(' tree hygiene — no machine path, no private repository, no tracked inventory')
console.log('============================================================')

const tracked = execSync('git ls-files -z', { cwd: ROOT }).toString('utf8').split('\0').filter(Boolean)
const TEXT = /\.(ts|tsx|mjs|cjs|js|py|sh|ps1|md|json|yml|yaml|tsv|txt|toml|sed|html|xml)$/
const GENERATED = /^(scripts\/[^/]+\/baselines\/|design-system\/live\/|scripts\/render-continuity\/receipts\/|scripts\/agent-experience\/baselines\/)/
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const read = (p: string): string | null => {
  try {
    return readFileSync(join(ROOT, p), 'utf8')
  } catch {
    return null
  }
}

const home = homedir().replace(/\\/g, '/')
const account = (() => {
  try {
    return userInfo().username
  } catch {
    return basename(home)
  }
})()
const machineNeedles: RegExp[] = []
if (home.length > 1 && home !== '/root') machineNeedles.push(new RegExp(escapeRe(home) + '(?=/|\\\\|$|[\\s"\'`)\\]])'))
if (account.length > 1) machineNeedles.push(new RegExp('(?:/Users/|/home/|[A-Za-z]:\\\\{1,2}Users\\\\{1,2})' + escapeRe(account) + '(?=/|\\\\|$|[\\s"\'`)\\]])'))
const machinePathHits = (paths: ReadonlyArray<string>, contentOf: (p: string) => string | null): string[] => {
  const hits: string[] = []
  for (const p of paths) {
    if (!TEXT.test(p) || GENERATED.test(p) || p === SELF) continue
    const text = contentOf(p)
    if (text === null) continue
    if (machineNeedles.some(re => re.test(text))) hits.push(p)
  }
  return hits
}
{
  const hits = machinePathHits(tracked, read)
  check(`§1 no hand-written tracked file spells this machine's home path or account (${account})`, hits.length === 0, hits.slice(0, 6).join(' · '))
  const planted = machinePathHits(['fixture/notes.md', 'fixture/tool.ts'], p => (p.endsWith('.md') ? `see ${home}/project/x` : `const p = '/Users/${account}/x'`))
  check('§1 self-test: a planted home path and a planted account path both trip', planted.length === 2, planted.join(' · '))
  const clean = machinePathHits(['fixture/clean.md'], () => 'an example lives at /Users/example/project and C:\\Users\\name\\project')
  check('§1 self-test: placeholder homes stay silent', clean.length === 0, clean.join(' · '))
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { repository?: { url?: string } }
const repoUrl = pkg.repository?.url ?? ''
const slugMatch = repoUrl.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
check('§2 package.json repository.url names a GitHub repository', slugMatch !== null, repoUrl)
const owner = slugMatch?.[1] ?? ''
const repo = slugMatch?.[2] ?? ''
const published = new Set([repo.toLowerCase(), `homebrew-${repo.toLowerCase()}`, 'homebrew-mercury', 'mercury'])
const repoRefRe = owner ? new RegExp('(?<![A-Za-z0-9_.-])' + escapeRe(owner) + '/([A-Za-z0-9_.-]+)', 'gi') : null
const privateRepoHits = (paths: ReadonlyArray<string>, contentOf: (p: string) => string | null): string[] => {
  const hits: string[] = []
  if (repoRefRe === null) return hits
  for (const p of paths) {
    if (!TEXT.test(p) || p === SELF) continue
    const text = contentOf(p)
    if (text === null) continue
    for (const m of text.matchAll(repoRefRe)) {
      const name = m[1]!.replace(/\.git$/, '').replace(/[.,;:)\]'"`]+$/, '')
      if (!published.has(name.toLowerCase())) {
        hits.push(`${p} (${owner}/${name})`)
        break
      }
    }
  }
  return hits
}
{
  const hits = privateRepoHits(tracked, read)
  check(`§2 tracked text names no repository of ${owner || '(unknown)'} other than the published ones`, owner !== '' && hits.length === 0, hits.slice(0, 6).join(' · '))
  const planted = privateRepoHits(['fixture/a.ts', 'fixture/b.md'], p => (p.endsWith('.ts') ? `const u = 'https://github.com/${owner}/Staging.git'` : `clone ${owner}/${repo} or brew install ${owner}/mercury/mercury`))
  check('§2 self-test: another repository of the account trips; the published names stay silent', planted.length === 1 && planted[0]!.startsWith('fixture/a.ts'), planted.join(' · '))
}

const UNTRACKED_ONLY = ['docs/FLAG-REGISTRY.md', 'docs/REACHABILITY-MANIFEST.json', 'docs/REACHABILITY-MAP.md']
const inventoryHitsOf = (paths: ReadonlyArray<string>): string[] =>
  paths.filter(p => UNTRACKED_ONLY.includes(p) || p.startsWith('scripts/orphans/.out/') || p.startsWith('scripts/substrate/.out/'))
{
  const hits = inventoryHitsOf(tracked)
  check('§3 generated inventories are not tracked', hits.length === 0, hits.slice(0, 4).join(' · '))
  const planted = inventoryHitsOf(['docs/REACHABILITY-MAP.md', 'scripts/orphans/.out/graph.json', 'docs/HEALTH-CERTIFICATE.md'])
  check('§3 self-test: a planted inventory path and a planted .out path trip, a real page stays silent', planted.length === 2, planted.join(' · '))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ tree hygiene: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ tree hygiene: clean')
