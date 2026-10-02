#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const SELF = 'scripts/identity/prove-no-other-guide-reads.ts'
const J = (...parts: string[]): string => parts.join('')

const WIDE = /^(?:src|docs|scripts|bench|integrations)\/|^README\.md$|^\.github\//
const SRC = /^src\//
const CODE = /^(?:src|scripts|docs)\//

type Allowance = [path: string, why: string, pending?: 'pending']
type Row = { id: string; needle: RegExp; scope: RegExp; what: string; allow: Allowance[] }

const ROWS: Row[] = [
  {
    id: 'other-guide-file',
    needle: new RegExp(J('CL', 'AUDE\\.(?:local\\.)?md')),
    scope: WIDE,
    what: "another tool's instruction file is an ordinary file: nothing probes, lists, composes or names it",
    allow: [
      ['scripts/consistency-census/basename-census.json', 'the generated census records the needles it hunts'],
      ['scripts/consistency-census/prove-census-comment-invariance.ts', 'a planted comment fixture proves comments never count'],
      ['scripts/dev-context/prove-root-guide.ts', "proves no second guide file sits beside this repository's AGENTS.md"],
    ],
  },
  {
    id: 'other-guide-env',
    needle: new RegExp(J('env(?:\\.|\\[[\'"`])CL', 'AUDE_|flagEnv\\([\'"`]CL', 'AUDE_')),
    scope: SRC,
    what: "no environment name of another tool is read",
    allow: [],
  },
  {
    id: 'shell-knob-names',
    needle: new RegExp(J('BASH_(?:DEFAULT|MAX)_TIMEOUT_MS|BASH_MAX_OUTPUT', '_LENGTH')),
    scope: CODE,
    what: "the shell's timeout and output knobs carry Mercury's names only",
    allow: [],
  },
  {
    id: 'policy-places',
    needle: new RegExp(J('com\\.anthropic\\.cl', 'audecode|Policies\\\\\\\\Cl', 'audeCode')),
    scope: CODE,
    what: "managed policy is read from Mercury's own domain and registry keys only",
    allow: [],
  },
  {
    id: 'other-mcp-file',
    needle: new RegExp(J('(?<![\\w$])\\.mcp', '\\.json')),
    scope: WIDE,
    what: 'the project MCP file is .mercury/mcp.json; a root-level file under the other name is not read, written or named',
    allow: [
      ['src/utils/permissions/filesystem.ts', "a protection naming another tool's executable config (never a read)"],
      ['scripts/core-runtime/prove-boot-mcp-independence.ts', 'names its --mcp fixture files <stub>.mcp.json — files handed on the command line, any name'],
      ['src/daemon/sessionKit.ts', "a comment in the protocol lane's daemon door file (queue row posted)", 'pending'],
    ],
  },
  {
    id: 'mcpjson-name',
    needle: new RegExp(J('Mcp', 'json')),
    scope: CODE,
    what: 'no internal name spells the other MCP file',
    allow: [
      ['scripts/identity/prove-vocabulary.ts', 'the retired settings keys it seals'],
      ['scripts/identity/prove-retired-keys-unknown.ts', 'the retired settings keys it proves unknown'],
    ],
  },
  {
    id: 'guide-probe-names',
    needle: new RegExp(J('auto-to-', 'native|otherHarness', 'Instructions')),
    scope: CODE,
    what: 'the profile resolves as itself and the project facts name only the guides Mercury loads',
    allow: [['scripts/project-intel/prove-project-snapshot.ts', 'names the field it proves absent']],
  },
]

const textual = (f: string): boolean =>
  /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|jsonl|md|txt|tsv|csv|sh|bash|py|yml|yaml|toml|sed|html|css|svg|xml|plist|ps1|cfg|ini)$/.test(f) || f.endsWith('members.txt')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' no other guide reads: the instruction, MCP, policy and shell-knob inputs are Mercury\'s own')
console.log('============================================================')

for (const row of ROWS) {
  const planted = `const x = ${JSON.stringify(sample(row.id))}`
  check(`${row.id}: a planted line trips`, row.needle.test(planted), planted)
}
check('other-guide-file: the native guide passes', !ROWS[0]!.needle.test("join(dir, 'MERCURY.md')"))
check('other-mcp-file: the project MCP file passes', !ROWS[4]!.needle.test("join(home, 'mcp.json') + '.mercury/mcp.json'"))
check('other-guide-env: a Mercury env read passes', !ROWS[1]!.needle.test("process.env.MERCURY_HOME ?? flagEnv('MERCURY_ONBOARDING')"))

const mootAllowances = (allow: Allowance[], used: Set<string>): Allowance[] => allow.filter(([p]) => !used.has(p))
{
  const planted = mootAllowances([...ROWS[0]!.allow, ['src/no-such-file.ts', 'poison: an allowance no line needs']], new Set(ROWS[0]!.allow.map(([p]) => p)))
  check('allowance self-test: an allowance no line needs is reported', planted.length === 1 && planted[0]![0] === 'src/no-such-file.ts', planted.map(([p]) => p).join(' · '))
}

function sample(id: string): string {
  switch (id) {
    case 'other-guide-file': return J('CL', 'AUDE.md')
    case 'other-guide-env': return J('process.env.CL', 'AUDE_CONFIG_DIR')
    case 'shell-knob-names': return J('BASH_MAX_OUTPUT', '_LENGTH')
    case 'policy-places': return J('com.anthropic.cl', 'audecode')
    case 'other-mcp-file': return J("join(cwd, '.mcp", ".json')")
    case 'mcpjson-name': return J('handleMcp', 'jsonServerApprovals')
    default: return J('auto-to-', 'native')
  }
}

const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
type Hit = { file: string; line: number; text: string }
const hits = new Map<string, Hit[]>()
const allowed = new Map<string, Set<string>>()
let scanned = 0
for (const rel of files) {
  if (rel === SELF || !textual(rel)) continue
  const rows = ROWS.filter(r => r.scope.test(rel))
  if (rows.length === 0) continue
  scanned++
  const text = readFileSync(join(ROOT, rel), 'utf8')
  const lines = text.split('\n')
  for (const row of rows) {
    if (!row.needle.test(text)) continue
    const allowance = row.allow.find(([p]) => rel === p || (p.endsWith('/') && rel.startsWith(p)))
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!row.needle.test(line)) continue
      if (allowance) {
        if (!allowed.has(row.id)) allowed.set(row.id, new Set())
        allowed.get(row.id)!.add(rel)
        continue
      }
      if (!hits.has(row.id)) hits.set(row.id, [])
      hits.get(row.id)!.push({ file: rel, line: i + 1, text: line.trim().slice(0, 140) })
    }
  }
}

console.log(`  scanned ${scanned} tracked files`)
for (const row of ROWS) {
  const rowHits = hits.get(row.id) ?? []
  check(
    `${row.id}: ${row.what}`,
    rowHits.length === 0,
    `${rowHits.length} found:` + rowHits.slice(0, 40).map(h => `\n      ${h.file}:${h.line} ${h.text}`).join('') + (rowHits.length > 40 ? `\n      … and ${rowHits.length - 40} more` : ''),
  )
  for (const [p, , pending] of mootAllowances(row.allow, allowed.get(row.id) ?? new Set())) {
    if (pending) console.log(`  [NOTE] ${row.id}: the allowance for ${p} is no longer needed — drop the row when that lane lands`)
    else check(`${row.id}: the allowance for ${p} is still needed`, false, 'no tracked line needs it — drop the row')
  }
}

if (REPORT) {
  for (const row of ROWS) for (const [p, why] of row.allow) console.log(`  ${row.id} · ${p} — ${why}`)
}

console.log(failures === 0 ? '\nno other guide reads: green' : `\nno other guide reads: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
