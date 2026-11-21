#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DOC_TOOLS, GENERATORS, STEPS, docToolsOf, docsOf, estateOf, factsOf, type DocEstate, type DocFacts, type DocHit } from '../lib/docTextReads.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-doc-text-reads.ts'
const TABLE = 'scripts/gate/doc-text-reads.tsv'
const INSTEAD = 'write a throwaway fixture under mkdtempSync or assert against product code instead of pinning repository document prose'

type Kind = 'contract' | 'owner' | 'scan' | 'helper'
type Reason = { kind: Kind; why: string }
type Row = { pins: number; searches: number; digest: string; kind: Kind; why: string }
type Table = Map<string, Row>
type Over = { script: string; why: string; lines: DocHit[] }
type Verdict = { over: Over[]; pins: number; searches: number; allowed: number; slack: number }

const KEPT: ReadonlyArray<readonly [script: string, kind: Kind, why: string]> = [
  ['scripts/api/prove-prefix-record-life.ts', 'owner', 'guards privacy promise in docs/SESSIONS.md'],
  ['scripts/bash/prove-windows-road-order.ts', 'contract', 'compares windowsShellRoad waysOut strings against docs/INSTALL.md'],
  ['scripts/build/prove-windows-desktop-guide.ts', 'contract', 'checks package.json setup vendor steps against docs/INSTALL-WINDOWS-FROM-SOURCE.md'],
  ['scripts/command-catalogue/prove-readme-roster.ts', 'contract', 'runs built product and compares its roster against README.md'],
  ['scripts/dev-context/prove-root-guide.ts', 'contract', 'holds AGENTS.md 80-line ceiling and package.json engines.node range'],
  ['scripts/distribution/prove-distribution-links.ts', 'owner', 'resolves local links across active docs and guards README THIRD_PARTY_NOTICES.md pointer'],
  ['scripts/distribution/prove-distribution-notices.ts', 'contract', 'verifies THIRD_PARTY_NOTICES.md against package.json, bun.lock and vendor locks'],
  ['scripts/distribution/prove-headless-image.ts', 'contract', 'checks Dockerfile WORKDIR, CMD, USER and credential env vars against docs/AUTOMATION.md'],
  ['scripts/distribution/prove-json-query-pack.ts', 'contract', 'verifies vendor json-query lock components appear in THIRD_PARTY_NOTICES.md'],
  ['scripts/distribution/prove-no-os-sandbox.ts', 'owner', 'ensures retired sandbox notice paragraphs are absent from THIRD_PARTY_NOTICES.md'],
  ['scripts/distribution/prove-notice-stamp.ts', 'owner', 'guards Apache NOTICE preservation statements in THIRD_PARTY_NOTICES.md'],
  ['scripts/distribution/prove-release-documents.ts', 'owner', 'guards Apache 2.0 licence statements across README.md, sdk/README.md and sdk-py/README.md'],
  ['scripts/docs/prove-automation-examples.ts', 'contract', 'extracts and executes runnable TypeScript and Python blocks from docs/AUTOMATION.md'],
  ['scripts/docs/prove-llmhost-doc.ts', 'contract', 'verifies live host road menus, vendors, recipes and bank keys against docs/LLM-HOST.md'],
  ['scripts/editor-bridge/prove-vscode-bridge.ts', 'owner', 'compares packaged VS Code extension licence bytes against LICENSE.md'],
  ['scripts/extensions/prove-contract-in-sync.ts', 'contract', 'verifies docs/templates/extension-source-README.md matches bundled skill template byte for byte'],
  ['scripts/extensions/prove-extensions-cli.ts', 'contract', 'verifies Craft pinned releases in docs/EXTENSIONS.md match code'],
  ['scripts/hooks/prove-hook-event-table.ts', 'contract', 'parses docs/HOOKS.md event table against hookEventTable in code'],
  ['scripts/identity/prove-ask-clock-words-gone.ts', 'scan', 'scans tracked src, scripts and docs for retired ask-clock spellings'],
  ['scripts/identity/prove-crew-docs-words.ts', 'scan', 'scans active docs for retired crew spellings'],
  ['scripts/identity/prove-docs-altitude.ts', 'scan', 'scans root and docs pages for forbidden internal process words'],
  ['scripts/identity/prove-docs-integrity.ts', 'scan', 'validates markdown syntax, anchors and local links across README.md and docs'],
  ['scripts/identity/prove-docs-names.ts', 'contract', 'parses backticked commands, flags and paths in docs against the live product'],
  ['scripts/identity/prove-embed-pack-everywhere-words.ts', 'scan', 'scans README.md and docs for retired macOS-only embed pack claims'],
  ['scripts/identity/prove-file-tool-absent.ts', 'scan', 'scans docs for retired file-tool names'],
  ['scripts/identity/prove-flow-judge-words-gone.ts', 'scan', 'scans tracked src, scripts and docs for retired flow-judge spellings'],
  ['scripts/identity/prove-hook-spellings-retired.ts', 'scan', 'scans tracked src, scripts and docs for retired hook spellings'],
  ['scripts/identity/prove-readme-headless-words.ts', 'contract', 'checks row vocabulary, RPC schema and runnable initialize line in docs/AUTOMATION.md'],
  ['scripts/identity/prove-second-sign-in-words-gone.ts', 'scan', 'scans README.md and docs for retired sign-in spellings'],
  ['scripts/identity/prove-tester-door.ts', 'owner', 'guards install-counter privacy promise in README.md'],
  ['scripts/identity/prove-unknown-command-answer.ts', 'scan', 'scans README.md for retired slash commands'],
  ['scripts/identity/prove-verb-help-words.ts', 'scan', 'scans docs for retired verb flags and platform claims'],
  ['scripts/media/prove-host-docs.ts', 'owner', 'checks pinned media runtime revision and privacy terms in docs/MEDIA.md and docs/LLM-HOST.md'],
  ['scripts/media/prove-media-vendor-manifest.ts', 'contract', 'parses docs/MEDIA.md manifest table against code mediaRows'],
  ['scripts/node-runtime/prove-copy-truth.ts', 'contract', 'checks NODE_SUPPORT.range in docs/INSTALL.md and BUILD-NOTES.md'],
  ['scripts/permissions/floorsKit.ts', 'helper', 'shared docs/TRUST.md reader for owner-protected safety-floor proofs'],
  ['scripts/permissions/prove-child-environment.ts', 'owner', 'guards child-environment credential and secret promises in docs/HOOKS.md'],
  ['scripts/permissions/prove-flow-keeps-configuration-ask.ts', 'owner', 'guards configuration-ask credential promise in docs/TRUST.md'],
  ['scripts/permissions/prove-monitor-hostless-run.ts', 'owner', 'guards hostless-run secret promise in docs/TRUST.md'],
  ['scripts/permissions/prove-safety-floors.ts', 'owner', 'guards safety-floor secret promises in docs/TRUST.md'],
  ['scripts/providers/prove-nous-contract.ts', 'contract', 'checks NOUS_PORTAL_CLIENT_ID constant in docs/ENGINES.md'],
  ['scripts/remote-files/prove-remote-page.ts', 'contract', 'parses ssh:// example paths and settings JSON block from docs/REMOTE-FILES.md'],
  ['scripts/sdk/prove-release-surface.ts', 'contract', 'compares package.json versions against sdk/README.md and sdk-py/README.md'],
  ['scripts/sdk/prove-sdk-readme.ts', 'contract', 'verifies SDK method coverage and executes code blocks from sdk/README.md and sdk-py/README.md'],
  ['scripts/self-hosting/prove-formats-page-names-what-is-read.ts', 'contract', 'parses docs/COMPATIBILITY.md table against instruction format adapters'],
  ['scripts/skills/prove-idle-doc-pages.ts', 'contract', 'hashes bundled mercury-docs skill pages against README.md and docs on disk'],
  ['scripts/skills/prove-image-generation-skill.ts', 'contract', 'verifies bundled mercury-docs ships docs/MEDIA.md byte for byte'],
  ['scripts/skills/prove-mercury-docs-skill.ts', 'contract', 'verifies bundled mercury-docs page set and links match README.md and docs on disk'],
  ['scripts/splash/prove-face-fit-floor.ts', 'contract', 'checks live boot card row names appear in README.md, AGENTS.md and Windows guide'],
  ['scripts/tools/prove-parity2-render-economy.ts', 'owner', 'guards machine-privacy promise in docs/TERMINAL-RUNTIME.md'],
  ['scripts/tools/prove-read-json-docs.ts', 'contract', 'checks vendor json-query engine version in docs/DOCUMENTS.md'],
  ['scripts/ui/prove-beta40-help.ts', 'contract', 'parses README.md command rows against registered commands'],
  ['scripts/ui/prove-gemini-guided-signin.ts', 'contract', 'checks live Gemini sign-in step titles appear in docs/ENGINES.md'],
  ['scripts/ui/prove-model-picker-reader-census.ts', 'scan', 'scans tracked scripts, src and docs for retired model-picker words'],
  ['scripts/updater/prove-node-pack.ts', 'owner', 'guards Node.js runtime notice entry in THIRD_PARTY_NOTICES.md'],
  ['scripts/updater/prove-python-pack.ts', 'owner', 'guards Python runtime notice entry in THIRD_PARTY_NOTICES.md'],
  ['scripts/updater/prove-version-contract.ts', 'contract', 'checks root package version appears in THIRD_PARTY_NOTICES.md'],
  ['scripts/wards/prove-floors-spellings.ts', 'owner', 'guards credential and runtime floor promises in docs/TRUST.md'],
]
const REASONS = new Map<string, Reason>(KEPT.map(([script, kind, why]) => [script, { kind, why }]))

const digestOf = (files: Iterable<string>): string =>
  createHash('sha256')
    .update([...files].sort().join('\n'))
    .digest('hex')
    .slice(0, 12)

function rowOf(f: DocFacts, reason: Reason): Row {
  const opened = [...f.pins.keys()].sort()
  return { pins: opened.length, searches: f.searches.length, digest: digestOf(opened), kind: reason.kind, why: reason.why }
}

function rowsOf(facts: Map<string, DocFacts>, reasons: ReadonlyMap<string, Reason>): { rows: Table; unreasoned: string[] } {
  const rows: Table = new Map()
  const unreasoned: string[] = []
  for (const [script, f] of facts) {
    if (f.pins.size === 0) continue
    const reason = reasons.get(script)
    if (!reason) {
      unreasoned.push(script)
      rows.set(script, rowOf(f, { kind: 'contract', why: 'unclassified' }))
    } else {
      rows.set(script, rowOf(f, reason))
    }
  }
  return { rows, unreasoned: unreasoned.sort() }
}

const render = (rows: Table): string =>
  [...rows]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([script, row]) => `${script}\t${row.pins}\t${row.searches}\t${row.digest}\t${row.kind}\t${row.why}\n`)
    .join('')

function tableOf(text: string): Table | null {
  const table: Table = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^(scripts\/[^\t]+)\t([1-9][0-9]*)\t([0-9]+)\t([0-9a-f]{12})\t(contract|owner|scan|helper)\t([^\t]+)$/.exec(line)
    if (!m || table.has(m[1]!)) return null
    table.set(m[1]!, { pins: Number(m[2]), searches: Number(m[3]), digest: m[4]!, kind: m[5]! as Kind, why: m[6]! })
  }
  return table
}

const pinLines = (f: DocFacts): DocHit[] => [...f.pins].map(([file, line]) => ({ file, line }))

function judge(facts: Map<string, DocFacts>, table: Table): Verdict {
  const over: Over[] = []
  let pins = 0
  let searches = 0
  for (const [script, f] of facts) {
    if (f.pins.size === 0) continue
    const now = rowOf(f, { kind: 'contract', why: '' })
    pins += now.pins
    searches += now.searches
    const row = table.get(script)
    if (!row) over.push({ script, why: 'has no row', lines: pinLines(f) })
    else if (now.pins > row.pins) over.push({ script, why: `its row allows ${row.pins} doc${row.pins === 1 ? '' : 's'}`, lines: pinLines(f) })
    else if (now.searches > row.searches) over.push({ script, why: `its row allows ${row.searches} search${row.searches === 1 ? '' : 'es'}`, lines: f.searches })
    else if (now.pins === row.pins && now.digest !== row.digest) over.push({ script, why: 'its row holds the same number of other docs, so one was swapped for another', lines: pinLines(f) })
  }
  let allowed = 0
  let slack = 0
  for (const [script, row] of table) {
    allowed += row.pins
    const f = facts.get(script)
    if (!f || f.pins.size < row.pins || f.searches.length < row.searches) slack++
  }
  return { over, pins, searches, allowed, slack }
}

function refused(facts: Map<string, DocFacts>, table: Table, movedFrom: Map<string, string>): Over[] {
  const out: Over[] = []
  for (const [script, f] of facts) {
    if (f.pins.size === 0) continue
    const now = rowOf(f, { kind: 'contract', why: '' })
    const from = table.has(script) ? script : movedFrom.get(script)
    const row = from === undefined ? undefined : table.get(from)
    if (!row) out.push({ script, why: 'is new: a row is added only when it moves with its file, by git mv and then --write', lines: pinLines(f) })
    else if (now.pins > row.pins) out.push({ script, why: `opens more docs than the ${row.pins} of ${from === script ? 'its row' : `the row of ${from}`}`, lines: pinLines(f) })
    else if (now.searches > row.searches) out.push({ script, why: `searches more often than the ${row.searches} of ${from === script ? 'its row' : `the row of ${from}`}`, lines: f.searches })
  }
  return out
}

function movedIn(root: string): Map<string, string> {
  const moved = new Map<string, string>()
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const since = git('log', '-1', '--format=%H', '--', TABLE).trim() || 'HEAD'
    for (const line of git('diff', '--cached', '-M', '--name-status', since, '--', 'scripts').split('\n')) {
      const [status, from, to] = line.split('\t')
      if (status?.startsWith('R') && from && to) moved.set(to, from)
    }
  } catch {
    return moved
  }
  return moved
}

function risen(base: Table, tip: Table, movedFrom: Map<string, string>): { lines: string[]; higher: number } {
  const lines: string[] = []
  let higher = 0
  for (const [script, row] of [...tip].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const from = base.has(script) ? script : movedFrom.get(script)
    const was = from === undefined ? undefined : base.get(from)
    const moved = from !== undefined && from !== script ? ` (moved from ${from})` : ''
    const after = `${row.pins} docs, ${row.searches} searches`
    if (!was) lines.push(`NEW   ${after}\t${script}`)
    else if (row.pins > was.pins || row.searches > was.searches) lines.push(`ROSE  ${was.pins} docs, ${was.searches} searches -> ${after}\t${script}${moved}`)
    else if (row.pins === was.pins && row.digest !== was.digest) lines.push(`SWAP  ${row.pins} docs, other docs than before\t${script}${moved}`)
    if (!was || row.pins > was.pins || row.searches > was.searches) higher++
  }
  return { lines, higher }
}

const told = (over: Over[], facts: Map<string, DocFacts>): string =>
  over
    .slice(0, 25)
    .map(o => {
      const f = facts.get(o.script)
      const head = `\n      ${o.script} opens ${f?.pins.size ?? 0} repo doc${f?.pins.size === 1 ? '' : 's'} as text and searches ${f?.searches.length ?? 0} time${f?.searches.length === 1 ? '' : 's'} in what it read: ${o.why}:`
      return head + o.lines.slice(0, 80).map(h => `\n        ${o.script}:${h.line} ${h.file}`).join('') + (o.lines.length > 80 ? `\n        … and ${o.lines.length - 80} more lines` : '')
    })
    .join('') + (over.length > 25 ? `\n      … and ${over.length - 25} more scripts` : '')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

function floor(estate: DocEstate, read: number): string {
  if (!estate.listed) return 'git lists nothing here: run the proof inside the checkout, with no GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE in its environment'
  if (!estate.scripts.includes(SELF)) return `git lists ${estate.scripts.length} files under scripts and not ${SELF}: the proof reads the files git lists, so a tree git lists nothing of proves nothing`
  return read === 0 ? 'no script was read' : ''
}

function plantedEstate(): void {
  const README = 'README.md'
  const GUIDE = 'docs/GUIDE.md'
  const OTHER = 'docs/OTHER.md'
  const AGENTS = 'AGENTS.md'
  const LICENCE = 'LICENSE.md'
  const SDK = 'sdk/README.md'
  const DOCS_GLOB = 'docs/**'
  const planted: Array<{ file: string; lines: string[]; pins: string[]; searches: number }> = [
    {
      file: 'scripts/lib/docDoor.ts',
      lines: ["import { readFileSync } from 'node:fs'", "import { join, resolve } from 'node:path'", "const ROOT = resolve(import.meta.dir, '..', '..')", "export const docText = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')", "export const guideText = (): string => readFileSync(join(ROOT, 'docs', 'GUIDE.md'), 'utf8')"],
      pins: [GUIDE],
      searches: 0,
    },
    {
      file: 'scripts/a/prove-doc-pins.ts',
      lines: [
        "import { execFileSync, execSync } from 'node:child_process'",
        "import { readFileSync } from 'node:fs'",
        "import { join, resolve } from 'node:path'",
        "import { fileURLToPath } from 'node:url'",
        "import { docText, guideText } from '../lib/docDoor.ts'",
        "import raw from '../../docs/OTHER.md' with { type: 'text' }",
        "const ROOT = resolve(import.meta.dir, '..', '..')",
        "const a = readFileSync(join(ROOT, 'README.md'), 'utf8')",
        "const b = readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), 'utf8')",
        "const c = readFileSync('LICENSE.md', 'utf8')",
        "const d = readFileSync(join(process.cwd(), 'sdk/README.md'), 'utf8')",
        'const e = guideText()',
        "const f = docText('README.md')",
        "const g = execFileSync('git', ['show', 'HEAD:README.md'], { cwd: ROOT, encoding: 'utf8' })",
        "const h = execSync('grep -c Mercury docs/GUIDE.md')",
        "console.log(a.includes('x'), b.startsWith('#'), c.indexOf('y'), d.endsWith('z'), e.match(/w/), f.split('\\n').length, raw.includes('q'), g, h)",
      ],
      pins: [AGENTS, LICENCE, README, GUIDE, OTHER, SDK],
      searches: 7,
    },
    {
      file: 'scripts/a/prove-dynamic-docs.ts',
      lines: [
        "import { execFileSync } from 'node:child_process'",
        "import { readdirSync, readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "const ROOT = join(import.meta.dir, '..', '..')",
        "for (const name of readdirSync(join(ROOT, 'docs'))) console.log(readFileSync(join(ROOT, 'docs', name), 'utf8').includes('k'))",
        "for (const rel of execFileSync('git', ['-C', ROOT, 'ls-files', '--', 'docs'], { encoding: 'utf8' }).split('\\n')) console.log(readFileSync(join(ROOT, rel), 'utf8').includes('m'))",
      ],
      pins: [DOCS_GLOB],
      searches: 2,
    },
    {
      file: 'scripts/a/prove-throwaway.ts',
      lines: [
        "import { execFileSync } from 'node:child_process'",
        "import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'",
        "import { tmpdir } from 'node:os'",
        "import { join, resolve } from 'node:path'",
        "const REPO = resolve(import.meta.dir, '..', '..')",
        "const tmp = mkdtempSync(join(tmpdir(), 'doc-fixture-'))",
        "mkdirSync(join(tmp, 'docs'), { recursive: true })",
        "writeFileSync(join(tmp, 'README.md'), '# scratch\\n')",
        "writeFileSync(join(tmp, 'docs', 'GUIDE.md'), '# guide\\n')",
        "const s1 = readFileSync(join(tmp, 'README.md'), 'utf8')",
        "const s2 = readFileSync(join(tmp, 'docs', 'GUIDE.md'), 'utf8')",
        "const ROOT = mkdtempSync(join(tmpdir(), 'fake-root-'))",
        "const s3 = readFileSync(join(ROOT, 'README.md'), 'utf8')",
        "const stat = execFileSync('git', ['diff', '--numstat', '--', 'README.md'], { cwd: tmp, encoding: 'utf8' })",
        "const shown = execFileSync('git', ['-C', tmp, 'show', 'HEAD:README.md'], { encoding: 'utf8' })",
        "const catted = execFileSync('cat', [join(tmp, 'README.md')], { encoding: 'utf8' })",
        "const present = existsSync(join(REPO, 'README.md'))",
        "const matched = /^show (README\\.md)$/.exec('show README.md')",
        "console.log(s1.includes('scratch'), s2.includes('guide'), s3.includes('x'), stat, shown, catted, present, matched, 'see docs/GUIDE.md')",
      ],
      pins: [],
      searches: 0,
    },
    {
      file: 'scripts/a/prove-excess-reader.ts',
      lines: [
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "const ROOT = join(import.meta.dir, '..', '..')",
        "const text = readFileSync(join(ROOT, 'README.md'), 'utf8')",
        "console.log(text.includes('exact prose pin'))",
      ],
      pins: [README],
      searches: 1,
    },
    {
      file: 'scripts/a/run-all.sh',
      lines: ['#!/usr/bin/env bash', '# gate-watch: README.md docs/GUIDE.md', 'set -u', 'grep -c Mercury docs/GUIDE.md'],
      pins: [GUIDE],
      searches: 1,
    },
    { file: 'scripts/a/reader.py', lines: ['# README.md in a comment', "text = open('docs/OTHER.md').read()"], pins: [OTHER], searches: 1 },
    { file: 'scripts/a/notes.md', lines: ['README.md and docs/GUIDE.md'], pins: [], searches: 0 },
  ]
  const root = mkdtempSync(join(tmpdir(), 'doc-text-reads-'))
  for (const { file, lines } of planted) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), lines.join('\n') + '\n')
  }
  const { facts, read, aside } = factsOf(root, { scripts: planted.map(p => p.file), docs: docsOf([README, GUIDE, OTHER, AGENTS, LICENCE, SDK]), listed: true })
  rmSync(root, { recursive: true, force: true })
  const seen = (file: string): string => {
    const f = facts.get(file)
    return f === undefined ? 'not read' : `[${[...f.pins.keys()].sort().join(' ')}] searches ${f.searches.length}`
  }
  const want = (file: string): string => {
    const p = planted.find(x => x.file === file)!
    return `[${[...p.pins].sort().join(' ')}] searches ${p.searches}`
  }
  const holds = (file: string): boolean => seen(file) === want(file)
  const differs = (file: string): string => `seen ${seen(file)} · want ${want(file)}`
  check('repo document reads are detected across join(ROOT), new URL(import.meta.url), cwd, bare relative paths, text imports, helpers and repo git/grep commands', holds('scripts/a/prove-doc-pins.ts') && holds('scripts/lib/docDoor.ts'), `${differs('scripts/a/prove-doc-pins.ts')} · ${differs('scripts/lib/docDoor.ts')}`)
  check('dynamic reads under repo docs/ (readdirSync and git ls-files -- docs) are detected as docs/**', holds('scripts/a/prove-dynamic-docs.ts'), differs('scripts/a/prove-dynamic-docs.ts'))
  check('throwaway scratch fixtures (mkdtempSync, fake ROOT, scratch git cwd/-C, scratch cat, existsSync, strings and comments) produce zero doc pins and zero searches', holds('scripts/a/prove-throwaway.ts'), differs('scripts/a/prove-throwaway.ts'))
  check('shell and Python readers skip comments (# gate-watch:) and catch real doc reads; markdown data files are set aside', holds('scripts/a/run-all.sh') && holds('scripts/a/reader.py') && read === planted.length - 1 && aside === 1 && !facts.has('scripts/a/notes.md'), `${differs('scripts/a/run-all.sh')} · ${differs('scripts/a/reader.py')} · read ${read} · aside ${aside}`)
  const plantedReasons = new Map<string, Reason>([
    ['scripts/lib/docDoor.ts', { kind: 'helper', why: 'shared door' }],
    ['scripts/a/prove-doc-pins.ts', { kind: 'contract', why: 'contract check' }],
    ['scripts/a/prove-dynamic-docs.ts', { kind: 'scan', why: 'retired-word scan' }],
    ['scripts/a/run-all.sh', { kind: 'scan', why: 'shell check' }],
    ['scripts/a/reader.py', { kind: 'scan', why: 'python check' }],
  ])
  const baselineFacts = new Map([...facts].filter(([s]) => s !== 'scripts/a/prove-excess-reader.ts'))
  const { rows } = rowsOf(baselineFacts, plantedReasons)
  const rendered = render(rows)
  const table = tableOf(rendered)
  check('the table renders 6 columns (script, docs, searches, digest, kind, reason) and round-trips cleanly', table !== null && render(table) === rendered && table.size === 5, rendered)
  check('malformed or duplicate table rows do not parse', tableOf('scripts/a/reader.py\t1\t1\t0123456789ab\n') === null && tableOf('scripts/a/reader.py\t1\t1\t0123456789ab\tbad\treason\n') === null && tableOf('scripts/a/reader.py\t1\t1\t0123456789ab\tscan\ta\nscripts/a/reader.py\t1\t1\t0123456789ab\tscan\tb\n') === null)
  if (table === null) return
  const clean = judge(baselineFacts, table)
  check('throwaway fixture passes with no row in the table', clean.over.length === 0 && !table.has('scripts/a/prove-throwaway.ts') && clean.slack === 0, JSON.stringify(clean))
  const excess = judge(facts, table)
  check('an artificial excess repo-doc reader with no row fails the table naming file, line and doc', excess.over.length === 1 && told(excess.over, facts).includes('scripts/a/prove-excess-reader.ts:4 README.md'), told(excess.over, facts))
  const with_ = (script: string, patch: Partial<Row>): Table => new Map([...table].map(([s, r]) => [s, s === script ? { ...r, ...patch } : r]))
  const without = (script: string): Table => new Map([...table].filter(([s]) => s !== script))
  check('more docs, more searches, or a swapped doc digest all fail', judge(baselineFacts, with_('scripts/a/prove-doc-pins.ts', { pins: 5 })).over.length === 1 && judge(baselineFacts, with_('scripts/a/prove-doc-pins.ts', { searches: 6 })).over.length === 1 && judge(baselineFacts, with_('scripts/a/reader.py', { digest: digestOf([GUIDE]) })).over[0]?.why.includes('swapped') === true)
  check('slack rows pass and are counted', judge(baselineFacts, with_('scripts/a/reader.py', { pins: 2, searches: 2 })).slack === 1)
  const moved = new Map([['scripts/a/reader.py', 'scripts/a/old-reader.py']])
  const renamed = (row: Row): Table => new Map([...without('scripts/a/reader.py'), ['scripts/a/old-reader.py', row]])
  check('write rule refuses new or higher rows and allows falling rows and non-rising git mv renames', refused(baselineFacts, table, new Map()).length === 0 && refused(baselineFacts, with_('scripts/a/reader.py', { pins: 3, searches: 3 }), new Map()).length === 0 && refused(facts, table, new Map()).map(o => o.script).join() === 'scripts/a/prove-excess-reader.ts' && refused(baselineFacts, with_('scripts/a/prove-doc-pins.ts', { searches: 6 }), new Map()).map(o => o.script).join() === 'scripts/a/prove-doc-pins.ts' && refused(baselineFacts, renamed({ pins: 1, searches: 1, digest: digestOf([OTHER]), kind: 'scan', why: 'python check' }), moved).length === 0 && refused(baselineFacts, renamed({ pins: 1, searches: 0, digest: digestOf([OTHER]), kind: 'scan', why: 'python check' }), moved).map(o => o.script).join() === 'scripts/a/reader.py')
  const cmp = risen(new Map([...renamed({ pins: 1, searches: 1, digest: digestOf([OTHER]), kind: 'scan', why: 'python check' })].filter(([s]) => s !== 'scripts/a/run-all.sh').map(([s, r]): [string, Row] => [s, s === 'scripts/a/prove-doc-pins.ts' ? { ...r, searches: 6 } : s === 'scripts/a/prove-dynamic-docs.ts' ? { ...r, digest: digestOf([GUIDE]) } : r])), table, moved)
  check('risen comparison flags NEW, ROSE and SWAP while passing moved rows', cmp.higher === 2 && cmp.lines.length === 3 && cmp.lines.some(l => l.startsWith('NEW ')) && cmp.lines.some(l => l.startsWith('ROSE ')) && cmp.lines.some(l => l.startsWith('SWAP ')), cmp.lines.join(' · '))
  check('unlisted estate fails the floor', floor({ scripts: [], docs: docsOf([]), listed: true }, 0) !== '' && floor({ scripts: [SELF], docs: docsOf([]), listed: false }, 1) !== '' && floor({ scripts: [SELF], docs: docsOf([README]), listed: true }, 1) === '')
}

function plantedTools(): void {
  const named = docToolsOf(
    ['scripts/gen/make.ts', 'scripts/gen/prove-made.ts', 'scripts/release/pack.mjs', 'scripts/release/prove-pack.ts', 'scripts/release/run-all.sh', ...DOC_TOOLS],
    'a.md\tbun scripts/gen/make.ts\tbun scripts/gen/prove-made.ts\tsrc/**\n',
  )
  check(
    `doc tools exclude generators from ${GENERATORS}, scripts/release/* and ${DOC_TOOLS.join(', ')} while never excluding prove-* or run-all.sh`,
    ['scripts/gen/make.ts', 'scripts/release/pack.mjs', ...DOC_TOOLS].every(s => named.has(s)) && !named.has('scripts/gen/prove-made.ts') && !named.has('scripts/release/prove-pack.ts') && !named.has('scripts/release/run-all.sh'),
    [...named].join(' '),
  )
}

function report(facts: Map<string, DocFacts>): void {
  const byDoc = new Map<string, number>()
  for (const f of facts.values()) for (const doc of f.pins.keys()) byDoc.set(doc, (byDoc.get(doc) ?? 0) + 1)
  const top = (m: Map<string, number>): string =>
    [...m]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 40)
      .map(([name, n]) => `\n  ${String(n).padStart(5)}  ${name}`)
      .join('')
  console.log(`\n  repo docs opened as text (${byDoc.size} distinct docs/globs):${top(byDoc)}`)
  console.log(`\n  scripts opening the most repo docs:${top(new Map([...facts].filter(([, f]) => f.pins.size > 0).map(([script, f]) => [script, f.pins.size])))}`)
  console.log(`\n  scripts with the most searches in repo docs:${top(new Map([...facts].filter(([, f]) => f.searches.length > 0).map(([script, f]) => [script, f.searches.length])))}`)
}

function readersOf(facts: Map<string, DocFacts>, files: string[]): void {
  const byName = (a: [string, DocFacts], b: [string, DocFacts]): number => (a[0] < b[0] ? -1 : 1)
  for (const file of files) {
    const opens = [...facts].filter(([, f]) => f.pins.has(file)).sort(byName)
    const names = [...facts].filter(([, f]) => f.namesOnly.has(file)).sort(byName)
    console.log(`\n  ${file}: ${opens.length} scripts open it as text · ${names.length} only name it`)
    for (const [script, f] of opens) console.log(`    opens  ${script}:${f.pins.get(file)} · ${f.searches.filter(hit => hit.file === file).length} searches`)
    for (const [script, f] of names) console.log(`    names  ${script}:${f.namesOnly.get(file)}`)
  }
}

if (process.argv.includes('--risen')) {
  const [base, tip] = process.argv.slice(process.argv.indexOf('--risen') + 1)
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (!base || !tip) {
    console.log(`usage: bun ${SELF} --risen <base commit> <tip commit>`)
    process.exit(2)
  }
  let was = ''
  try {
    was = git('show', `${base}:${TABLE}`)
  } catch {
    was = ''
  }
  const now = git('show', `${tip}:${TABLE}`)
  const moved = new Map<string, string>()
  for (const line of git('diff', '-M', '--name-status', base, tip, '--', 'scripts').split('\n')) {
    const [status, from, to] = line.split('\t')
    if (status?.startsWith('R') && from && to) moved.set(to, from)
  }
  const older = tableOf(was) ?? new Map<string, Row>()
  const newer = tableOf(now) ?? new Map<string, Row>()
  const read = risen(older, newer, moved)
  for (const line of read.lines) console.log(line)
  console.log(`${read.higher} rows new or higher · ${read.lines.length - read.higher} rows that hold other docs · ${older.size} rows at ${base}, ${newer.size} at ${tip}`)
  process.exit(read.higher === 0 ? 0 : 1)
}

section('§0 the reader on a planted estate: repo doc reads vs throwaway fixtures, and how the table is kept')
plantedEstate()
plantedTools()

section(`§1 the estate: repository documents each script opens as text and its searches, against ${TABLE}`)
const estate = estateOf(ROOT)
const { facts, read, aside } = factsOf(ROOT, estate)
const { rows, unreasoned } = rowsOf(facts, REASONS)
const staleReasons = [...REASONS.keys()].filter(s => !rows.has(s)).sort()
const sum = (of: (f: DocFacts) => number): number => [...facts.values()].reduce((n, f) => n + of(f), 0)
const count = (of: (f: DocFacts) => boolean): number => [...facts.values()].filter(of).length
const totals = { pins: sum(f => f.pins.size), searches: sum(f => (f.pins.size > 0 ? f.searches.length : 0)), namesOnly: sum(f => f.namesOnly.size) }
const text = existsSync(join(ROOT, TABLE)) ? readFileSync(join(ROOT, TABLE), 'utf8') : null
const table = text === null ? null : tableOf(text)
const byKind = new Map<Kind, number>()
for (const r of rows.values()) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1)
const kindSummary = (['contract', 'owner', 'scan', 'helper'] as const).map(k => `${k} ${byKind.get(k) ?? 0}`).join(' · ')
const REACH = `the fence reads scripts/ and counts tracked repository docs (root *.md, docs/**/*.md, sdk/README.md, sdk-py/README.md, integrations/*/README.md); throwaway temp fixtures under mkdtempSync/scratch dirs are excluded. Out of reach: whole-repo git ls-files scanners without an explicit docs pathspec, recursive directory walkers that push into outer arrays across helpers (${count(f => f.folder)} scripts name docs/), scripts hitting the ${STEPS} step cap (${count(f => f.spent)}), non-code data/doc files (${aside}), and tools (${estate.tools?.size ?? 0}: generators in ${GENERATORS}, scripts/release/*, ${DOC_TOOLS.join(', ')}, never prove-* or run-all.sh)`
const REPAIR = `${INSTEAD}; a row is written only when it falls, leaves, holds other docs or moves with its file (git mv, then bun ${SELF} --write)`
console.log(`  ${estate.scripts.length} files under scripts · ${read} read · ${estate.docs.files.size} repo docs · ${rows.size} scripts open a repo doc (${kindSummary}) · ${totals.pins} doc reads · ${totals.searches} searches · ${totals.namesOnly} names only`)
const low = floor(estate, read)
check('git lists the proof among the files under scripts, and scripts were read', low === '', low)
check('every script in KEPT still opens a repo doc (no stale reason rows)', staleReasons.length === 0, staleReasons.join(', '))
if (process.argv.includes('--write')) {
  const no = table === null ? [] : refused(facts, table, movedIn(ROOT))
  if (failures > 0) console.log('  nothing written: the reader failed on its own estate or the estate is not listed')
  else if (unreasoned.length > 0) check(`every doc-reading script carries a classified reason (${unreasoned.length} missing)`, false, unreasoned.join(', '))
  else if (text !== null && table === null) check(`${TABLE} reads cleanly`, false, `nothing written: a table of another shape stands there (git rm ${TABLE}, then --write)`)
  else if (no.length > 0) check(`no row is new or higher (${no.length} are)`, false, `nothing written — ${REPAIR}:${told(no, facts)}`)
  else {
    writeFileSync(join(ROOT, TABLE), render(rows))
    console.log(`  wrote ${TABLE}: ${rows.size} rows (${kindSummary}) · ${totals.pins} doc reads · ${totals.searches} searches${table === null ? ' (the first table)' : ` (it held ${table.size} rows)`}`)
  }
} else if (table === null) {
  check(`${TABLE} reads as rows of script, docs, searches, digest, kind and reason`, false, text === null ? `no table: bun ${SELF} --write writes the first one` : 'a row does not match the 6-column table format or a script stands twice')
} else {
  const found = judge(facts, table)
  check(`no script opens more repo docs as text than its row allows, searches more often in what it read, or opens other docs; a script with no row opens none (${table.size} rows · ${REACH})`, found.over.length === 0, `${found.over.length} found — ${REPAIR}:${told(found.over, facts)}`)
  if (found.slack > 0) console.log(`  rows above their script's count: ${found.slack} (the fold lowers them with bun ${SELF} --write)`)
}
if (process.argv.includes('--report')) report(facts)
if (process.argv.includes('--readers')) readersOf(facts, process.argv.slice(process.argv.indexOf('--readers') + 1).filter(arg => !arg.startsWith('--')))
console.log(`\nprove-doc-text-reads: ${failures === 0 ? 'green' : `${failures} failed`} · docs ${totals.pins} · searches ${totals.searches} · names only ${totals.namesOnly} · scripts with a row ${rows.size}`)
process.exit(failures === 0 ? 0 : 1)
