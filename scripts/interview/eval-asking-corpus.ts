#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/eval-asking-corpus.ts — the scenario corpus,
//  evaluated against the ASSEMBLED prompt with LIVE model calls.
//
//  BILLED work (kickoff ruling 2 pre-authorizes it; the cost lands in the
//  verdict artifact and the journal). Deliberately named eval-*
//  so the pooled suite NEVER runs it — the pool validates the committed
//  verdict artifact instead (prove-corpus-verdict.ts).
//
//  Method: each scenario seeds a scratch project and runs the CANDIDATE
//  dist/mercury.mjs HEADLESS (-p, plan mode, stream-json) with the
//  operator's real config home — the auth, the model, and the assembled
//  system/tool prompts are exactly the product's own. The eval then reads
//  the stream for AskUserQuestion tool_use calls and judges:
//    · a decision the repo evidence already resolves must NOT be asked;
//    · a trivial/internal choice must NOT be asked;
//    · a genuinely open decision MAY be asked (recorded, not required);
//    · a dependent question must not ride the same round as its parent.
//
//  Run:  ~/.bun/bin/bun run scripts/interview/eval-asking-corpus.ts
//  Writes: scripts/interview/corpus-verdict.json (committed artifact).
// ============================================================================

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

interface Scenario {
  name: string
  kind: 'resolved' | 'trivial' | 'open' | 'dependent'
  files: Record<string, string>
  task: string
  /** Case-insensitive topic markers that must NOT appear in any asked question. */
  forbidden: string[]
  /** For 'dependent': [parentMarkers, childMarkers] must not share one call. */
  dependentPair?: [string[], string[]]
  note: string
}

const PKG = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'corpus-fixture', version: '1.0.0', ...extra }, null, 2)

const SCENARIOS: Scenario[] = [
  {
    name: 'resolved-test-framework',
    kind: 'resolved',
    files: {
      'package.json': PKG({ type: 'module', devDependencies: { vitest: '^2.0.0' }, scripts: { test: 'vitest run' } }),
      'src/parser.ts': 'export function parse(s: string): string[] {\n  return s.split(",")\n}\n',
      'src/parser.test.ts': "import { it, expect } from 'vitest'\nimport { parse } from './parser.js'\nit('splits', () => expect(parse('a,b')).toEqual(['a','b']))\n",
    },
    task: 'Add unit tests covering the edge cases of the parser module.',
    forbidden: ['test framework', 'testing framework', 'vitest', 'jest', 'mocha', 'test runner'],
    note: 'The repo already tests with vitest — the framework is decided.',
  },
  {
    name: 'resolved-module-system',
    kind: 'resolved',
    files: {
      'package.json': PKG({ type: 'module' }),
      'src/index.ts': "export { parse } from './parser.js'\n",
      'src/parser.ts': 'export const parse = (s: string): string[] => s.split(",")\n',
    },
    task: 'Add a small config loader utility to this project.',
    forbidden: ['esm', 'commonjs', 'module system', 'import style', 'require or import'],
    note: 'type:module and ESM sources decide the module system.',
  },
  {
    name: 'resolved-formatter',
    kind: 'resolved',
    files: {
      'package.json': PKG(),
      'biome.json': JSON.stringify({ formatter: { enabled: true, indentStyle: 'space' } }, null, 2),
      'src/util.ts': 'export const x=1;export function messy( a:number ){return a+ 1}\n',
    },
    task: 'Clean up the formatting of src/util.ts.',
    forbidden: ['formatter', 'prettier', 'biome or', 'which linter', 'formatting tool'],
    note: 'biome.json is committed — the formatter is decided.',
  },
  {
    name: 'resolved-ui-kit-convention',
    kind: 'resolved',
    files: {
      'package.json': PKG(),
      'MERCURY.md': '# Project rules\n\nAll UI components use the in-repo kit at src/kit — never a third-party UI library.\n',
      'src/kit/Button.ts': "export function Button(label: string): string {\n  return `[ ${label} ]`\n}\n",
    },
    task: 'Add a secondary (ghost) button variant to the UI.',
    forbidden: ['ui library', 'component library', 'third-party', 'which framework'],
    note: 'The project instructions decide the UI kit.',
  },
  {
    name: 'trivial-helper-placement',
    kind: 'trivial',
    files: {
      'package.json': PKG({ type: 'module' }),
      'src/helpers/dates.ts': 'export const iso = (d: Date): string => d.toISOString()\n',
    },
    task: 'Add a helper that slugifies titles; put it wherever helpers live.',
    forbidden: ['file name', 'filename', 'what should it be called', 'name the', 'which directory', 'where should'],
    note: 'Names and placement are implementation details the task already settles.',
  },
  {
    name: 'resolved-strictness',
    kind: 'resolved',
    files: {
      'package.json': PKG(),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'esnext' } }, null, 2),
      'src/config.ts': 'export const load = (raw: string) => JSON.parse(raw)\n',
    },
    task: 'Add proper types for the config module.',
    forbidden: ['strict mode', 'allow any', 'how strict'],
    note: 'tsconfig strict:true decides the typing bar.',
  },
  {
    name: 'open-cache-engine',
    kind: 'open',
    files: {
      'package.json': PKG({ type: 'module' }),
      'src/api.ts': "export async function fetchReport(id: string): Promise<unknown> {\n  return fetch(`https://api.example.com/r/${id}`).then(r => r.json())\n}\n",
    },
    task: 'Add a cache layer for the API responses.',
    forbidden: [],
    note: 'Genuinely open: storage/TTL trade-offs have no repo evidence. Asking is legitimate (recorded).',
  },
  {
    name: 'open-http-surface',
    kind: 'open',
    files: {
      'package.json': PKG({ type: 'module' }),
      'src/report.ts': 'export function generateReport(): string {\n  return "report"\n}\n',
    },
    task: 'Expose the report generator over HTTP.',
    forbidden: [],
    note: 'No HTTP framework exists — the surface choice is genuinely open.',
  },
  {
    name: 'resolved-node-version',
    kind: 'resolved',
    files: {
      'package.json': PKG({ engines: { node: '>=24.11.0' } }),
      '.node-version': '24.11.0\n',
      'src/index.ts': 'export const ok = true\n',
    },
    task: 'Add a simple GitHub Actions workflow that runs the type check.',
    forbidden: ['which node version', 'node version should'],
    note: 'The version pin is committed twice over.',
  },
  {
    name: 'dependent-store-then-schema',
    kind: 'dependent',
    files: {
      'package.json': PKG({ type: 'module' }),
      'src/prefs.ts': 'export interface Prefs { theme: string }\n',
    },
    task: 'Add persistence for user preferences. Decide with me between file-based storage and sqlite, and after that choose a schema layout for whichever store we pick.',
    forbidden: [],
    dependentPair: [
      ['file-based', 'sqlite', 'which store', 'storage'],
      ['schema layout', 'schema design', 'table layout', 'column'],
    ],
    note: 'The schema depends on the store — it must not ride the same round.',
  },
]

interface ScenarioResult {
  name: string
  kind: string
  askedQuestions: string[]
  violations: string[]
  costUsd: number | null
  model: string | null
  turns: number
}

const results: ScenarioResult[] = []
let totalCost = 0

for (const sc of SCENARIOS) {
  process.stdout.write(`── ${sc.name} … `)
  const cwd = mkdtempSync(join(tmpdir(), 'corpus-'))
  try {
    for (const [rel, content] of Object.entries(sc.files)) {
      mkdirSync(join(cwd, dirname(rel)), { recursive: true })
      writeFileSync(join(cwd, rel), content)
    }
    const r = spawnSync(
      process.env.NODE_BIN ?? 'node',
      [DIST, '-p', sc.task, '--permission-mode', 'strategy', '--output-format', 'stream-json', '--verbose', '--max-turns', '3'],
      {
        cwd,
        encoding: 'utf8',
        timeout: 420_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, MERCURY_TERMINAL_TITLE: '0' },
      },
    )
    const asked: string[] = []
    const roundQuestionSets: string[][] = []
    let costUsd: number | null = null
    let model: string | null = null
    let turns = 0
    for (const line of (r.stdout ?? '').split('\n')) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (obj.type === 'assistant') {
        turns++
        const msg = obj.message as { model?: string; content?: { type: string; name?: string; input?: { questions?: { question: string }[] } }[] } | undefined
        if (msg?.model) model = msg.model
        for (const block of msg?.content ?? []) {
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
            const qs = (block.input?.questions ?? []).map(q => q.question)
            asked.push(...qs)
            roundQuestionSets.push(qs)
          }
        }
      }
      if (obj.type === 'result') {
        const cost = (obj as { total_cost_usd?: number }).total_cost_usd
        if (typeof cost === 'number') costUsd = cost
      }
    }
    const violations: string[] = []
    for (const q of asked) {
      const lower = q.toLowerCase()
      for (const marker of sc.forbidden) {
        if (lower.includes(marker)) violations.push(`asked a resolved/trivial topic: "${q}" (marker: ${marker})`)
      }
    }
    if (sc.dependentPair) {
      const [parent, child] = sc.dependentPair
      for (const round of roundQuestionSets) {
        const text = round.join(' ').toLowerCase()
        const hasParent = parent.some(m => text.includes(m))
        const hasChild = child.some(m => text.includes(m))
        if (hasParent && hasChild) {
          violations.push(`a dependent question rode the same round as its parent: ${JSON.stringify(round)}`)
        }
      }
    }
    if (costUsd) totalCost += costUsd
    results.push({ name: sc.name, kind: sc.kind, askedQuestions: asked, violations, costUsd, model, turns })
    console.log(
      `${violations.length === 0 ? '✅' : '❌'} asked=${asked.length} violations=${violations.length} cost=${costUsd ?? '?'}`,
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

const verdict = {
  schema: 1,
  ranAt: new Date().toISOString(),
  method:
    'candidate dist/mercury.mjs headless (-p, plan mode, stream-json, max 3 turns) with the operator config home — the assembled prompt and model are the product’s own; AskUserQuestion tool_use calls judged per scenario',
  scenarios: results,
  totals: {
    scenarios: results.length,
    violations: results.reduce((n, r) => n + r.violations.length, 0),
    openScenariosThatAsked: results.filter(r => r.kind === 'open' && r.askedQuestions.length > 0).length,
    approxCostUsd: Number(totalCost.toFixed(4)),
  },
}
writeFileSync(join(HERE, 'corpus-verdict.json'), JSON.stringify(verdict, null, 1) + '\n')
console.log(
  `\n${verdict.totals.violations === 0 ? '✅' : '❌'} corpus: ${verdict.totals.scenarios} scenarios · ${verdict.totals.violations} violation(s) · ~$${verdict.totals.approxCostUsd}`,
)
process.exit(verdict.totals.violations === 0 ? 0 : 1)
