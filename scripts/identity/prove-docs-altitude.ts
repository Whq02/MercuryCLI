#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

const ROOT_SURFACES = ['README.md', 'AGENTS.md', 'BUILD-NOTES.md', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', '.github/PULL_REQUEST_TEMPLATE.md']
function docsPages(): string[] {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '--', 'docs'], { encoding: 'utf8' })
    .split('\n')
    .filter(f => f.endsWith('.md'))
  if (tracked.length > 0) return tracked.sort()
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.md')) out.push(relative(ROOT, p))
    }
  }
  walk(join(ROOT, 'docs'))
  return out.sort()
}

const PROCESS_TERMS: Array<[string, RegExp]> = [
  ['crew-of-authors word', new RegExp('\\b' + J('med', 'ics?') + '\\b', 'i')],
  ['work-stream agent compound', new RegExp(J('lane', '[ -]', 'agent'), 'i')],
  ['decision-record collocation', new RegExp(J('operator', '[ -]', 'rul', '(?:ing|ed)'), 'i')],
  ['decision-record collocation (lead)', new RegExp(J('lead', '[ -]', 'ruling'), 'i')],
  ['dated decision collocation', new RegExp(J('ruled', '[ -]', '20\\d\\d'), 'i')],
  ['tasking-file suffix', new RegExp(J('-', 'BRIEF', '\\.md'))],
  ['tasking-dir path', new RegExp(J('\\bbriefs', '/'))],
  ['handover-file name', new RegExp(J('HANDOFF', '\\.md'))],
  ['closeout-file suffix', new RegExp(J('-', 'RECEIPT', '\\.md'))],
  ['relay-channel path (in)', new RegExp(J('field/', 'inbox'), 'i')],
  ['relay-channel path (out)', new RegExp(J('field/', 'results'), 'i')],
  ['work-stream tag', new RegExp('\\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*' + J(' lane', 's?\\b') + '|' + J('\\blane ', '[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*\\b'))],
  ['dated decision verb', new RegExp('\\b(?:' + [J('ru', 'led'), J('rul', 'ing'), J('sigh', 'ted'), J('supp', 'lied'), J('lan', 'ded'), J('fol', 'ded'), J('tr', 'ued'), J('rati', 'fied'), J('adjudi', 'cated')].join('|') + ')\\b[^\\n]{0,16}\\b20\\d\\d-\\d\\d-\\d\\d\\b')],
  ['field-report row id', new RegExp('\\b(?:' + J('F', 'N') + '|' + J('F', 'C') + ')-\\d{3}\\b|\\b' + J('TAS', 'K') + '-\\d{3}\\b')],
]

const VERIFICATION_CITES: Array<[string, RegExp]> = [
  ['checker filename', new RegExp(J('prove', '-') + '[a-z0-9-]+\\.(?:ts|sh)')],
  ['concrete suite runner path', new RegExp(J('scripts/', '[a-z0-9-]+', '/run-all', '\\.sh'))],
]

const CONFIG_INDEX_SPELLING = J('src/substrate/', 'flagRegistry.ts')
const SRC_CITE = new RegExp('[(`]' + J('src', '/'))

const QUOTED_PRODUCT_LABELS: ReadonlyArray<{ span: string; reason: string }> = [
  {
    span: '`C/C++ IDE lane (clangd)`',
    reason: 'Boot Menu row label in src/substrate/startupMenu.ts:168 quoted verbatim in backticks',
  },
]

const CENSUS_EXEMPT_LINES: ReadonlyArray<{ fragment: string; reason: string }> = [
  {
    fragment: '**Yes ' + J('—', ' begin the build**'),
    reason: 'ApolloReview option label in src/components/permissions/ApolloReviewPermissionRequest/ApolloReviewPermissionRequest.tsx:87',
  },
  {
    fragment: '**Yes ' + J('—', ' but ask me before each edit**'),
    reason: 'ApolloReview option label in src/components/permissions/ApolloReviewPermissionRequest/ApolloReviewPermissionRequest.tsx:88',
  },
  {
    fragment: '**No ' + J('—', ' ask me more questions**'),
    reason: 'ApolloReview option label in src/components/permissions/ApolloReviewPermissionRequest/ApolloReviewPermissionRequest.tsx:89',
  },
  {
    fragment: 'go-delve/' + J('del', 've/cmd/dlv@latest'),
    reason: 'Go Delve module path in docs/DEBUGGER.md:63',
  },
]

const VOICE_CENSUS_NEEDLES: Array<[string, RegExp]> = [
  [
    'voice census pattern',
    new RegExp(
      [
        J(' ', '—', ' '),
        J(', ', 'not '),
        J('seam', 'less'),
        J('rob', 'ust'),
        J('del', 've'),
        J('super', 'charg'),
        J('game.', 'chang'),
        J('un', 'lock'),
        J('blaz', 'ing'),
        J('serves ', 'as'),
        J('stands ', 'as'),
        J('boa', 'sts'),
        J('feat', 'ures'),
        J('off', 'ers'),
        J('not ', 'just'),
        J('rather ', 'than'),
      ].join('|'),
    ),
  ],
]

function stripQuotedProductAndCodeSpans(text: string): string {
  const preserveNewlines = (match: string): string => '\n'.repeat((match.match(/\n/g) ?? []).length)
  const withoutGenerated = text.replace(
    /<!--\s*contract:begin[\s\S]*?<!--\s*contract:end\s*-->/g,
    preserveNewlines,
  )
  const lines = withoutGenerated.split('\n')
  let fenced = false
  const unfenced = lines
    .map(raw => {
      if (/^\s*(```|~~~)/.test(raw)) {
        fenced = !fenced
        return ''
      }
      if (fenced) return ''
      let line = raw
      for (const ex of CENSUS_EXEMPT_LINES) {
        line = line.split(ex.fragment).join(' ')
      }
      return line
    })
    .join('\n')
  const emDashInsideQuotes = (quoted: string): string => quoted.split(J(' ', '—', ' ')).join(' ')
  return unfenced
    .replace(/``[\s\S]*?``/g, preserveNewlines)
    .replace(/`[^`]*`/g, preserveNewlines)
    .split('\n')
    .map(line => line.replace(/"[^"]*"|“[^”]*”/g, emDashInsideQuotes))
    .join('\n')
}

interface Hit {
  file: string
  law: string
  label: string
  line: number
  excerpt: string
}

function scanText(file: string, text: string, law: string, needles: Array<[string, RegExp]>): Hit[] {
  const hits: Hit[] = []
  const lines = text.split('\n')
  for (const [label, re] of needles) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        hits.push({ file, law, label, line: i + 1, excerpt: lines[i]!.trim().slice(0, 120) })
      }
    }
  }
  return hits
}

function scanTree(): Hit[] {
  const hits: Hit[] = []
  const docs = docsPages()
  const MATRIX = join('docs', 'CAPABILITY-GRADUATION-MATRIX.md')
  const s1Surfaces = [...ROOT_SURFACES, ...docs]
  const s2Surfaces = [...ROOT_SURFACES.filter(f => f !== 'THIRD_PARTY_NOTICES.md'), ...docs.filter(f => f !== MATRIX)]
  const s3Surfaces = docs.filter(f => f !== join('docs', 'COMPATIBILITY.md') && f !== MATRIX)
  const read = (rel: string): string | null => {
    try {
      return readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      return null
    }
  }
  for (const rel of s1Surfaces) {
    const text = read(rel)
    if (text === null) continue
    let s1Text = text
    for (const ex of QUOTED_PRODUCT_LABELS) {
      s1Text = s1Text.split(ex.span).join('')
    }
    hits.push(...scanText(rel, s1Text, '§1', PROCESS_TERMS))
  }
  for (const rel of s2Surfaces) {
    const text = read(rel)
    if (text !== null) hits.push(...scanText(rel, text, '§2', VERIFICATION_CITES))
  }
  for (const rel of s3Surfaces) {
    const text = read(rel)
    if (text === null) continue
    const stripped = text.split(CONFIG_INDEX_SPELLING).join('')
    hits.push(...scanText(rel, stripped, '§3', [['inline source citation', SRC_CITE]]))
  }
  const topLevelDocs = ['README.md', ...docs.filter(f => /^docs\/[^/]+\.md$/.test(f))]
  for (const rel of topLevelDocs) {
    const text = read(rel)
    if (text === null) continue
    hits.push(...scanText(rel, stripQuotedProductAndCodeSpans(text), '§4', VOICE_CENSUS_NEEDLES))
  }
  return hits
}

function selfTest(): void {
  const redFixtures: Array<[string, string]> = [
    ['§1', J('the ', 'med', 'ic', ' wave lands')],
    ['§1', J('a ', 'lane', ' ', 'agent', ' runs it')],
    ['§1', J('operator', ' ', 'rul', 'ing', ' 2026-01-01')],
    ['§1', J('see FOO', '-', 'BRIEF', '.md')],
    ['§1', J('under ', 'briefs', '/', 'x.md')],
    ['§1', J('the ', 'FOO', 'BAR', ' lane', ' owns it')],
    ['§1', J('lane ', 'BAZ', '-QUX', ' folded it')],
    ['§1', J('rati', 'fied', ' 2026-08-28')],
    ['§1', J('see ', 'F', 'N', '-015', ' rank 8')],
    ['§2', J('pinned by ', 'prove', '-', 'something.ts')],
    ['§2', J('run ', 'scripts/', 'foo', '/run-all', '.sh')],
    ['§3', J('the owner (`', 'src', '/services/x.ts`)')],
  ]
  for (const [law, fixture] of redFixtures) {
    const needles =
      law === '§1' ? PROCESS_TERMS : law === '§2' ? VERIFICATION_CITES : ([['inline source citation', SRC_CITE]] as Array<[string, RegExp]>)
    const found = scanText('fixture.md', fixture, law, needles)
    if (found.length === 0) {
      console.error(`self-test FAILED: a ${law} fixture was not flagged: ${fixture}`)
      process.exit(1)
    }
  }
  const clean = [
    'bash scripts/<suite>/run-all.sh    # one suite; they sit side by side',
    'the in-code registry (`' + CONFIG_INDEX_SPELLING + '`; rendered on demand)',
    'launch receipts name the road; the fire lands as a receipt row',
    'a crewmate handoff is honesty-gated; the medical metaphor stays outside',
    'the session dispatches on the local lane',
    'the home lane earns every ride; a GPT specialist lane stays lowercase-named',
    'released 2026-08-16 as 9.9.9 (a plain date beside no decision verb)',
    'TASK-driven text carries no row id',
  ].join('\n')
  const censusRed: Array<[string, string, number]> = [
    ['a bare census line', 'The surface ' + J('—', ' ') + J('rather ', 'than') + ' a menu ' + J('off', 'ers') + ' a road.', 1],
    ...CENSUS_EXEMPT_LINES.map((ex): [string, string, number] => [
      `a census word beside the exempt fragment ${ex.fragment}`,
      `- ${ex.fragment}: a ` + J('rob', 'ust') + ' road.',
      1,
    ]),
    ['a census word inside straight quotes', 'The choice is recorded as deviations from "a ' + J('rob', 'ust') + ' road" and resolved.', 1],
    ['a census word inside curly quotes', 'The row reads “a ' + J('seam', 'less') + ' road” when it lands.', 1],
    [
      'a bare census word three lines below a stray straight quote',
      'The home screen row (12" wide) carries the switch.\n' +
        'The choice is recorded as deviations from "everything on" and resolved\n' +
        'into a kit when each new session starts. Flip a switch, start a session,\n' +
        'and it loads that selection ' +
        J('seam', 'lessly') +
        ', "as the menu says".',
      4,
    ],
  ]
  for (const [label, fixture, line] of censusRed) {
    const found = scanText('fixture.md', stripQuotedProductAndCodeSpans(fixture), '§4', VOICE_CENSUS_NEEDLES)
    if (!found.some(h => h.line === line)) {
      console.error(`self-test FAILED: a §4 census fixture was not flagged on line ${line}: ${label}`)
      process.exit(1)
    }
  }
  const censusClean = [
    'The row reads `"held: sign-in expired — /logins"` and `` "Run `brew` — [y/N]" ``.',
    ...CENSUS_EXEMPT_LINES.map(ex => `- ${ex.fragment}: enters the build posture.`),
    'The strip reads "held: sign-in expired ' + J('—', ' /logins') + '" and “done ' + J('—', ' 3 files”') + ' on its row.',
  ]
  const cleanHits = [
    ...scanText('clean.md', clean, '§1', PROCESS_TERMS),
    ...scanText('clean.md', clean, '§2', VERIFICATION_CITES),
    ...scanText('clean.md', clean.split(CONFIG_INDEX_SPELLING).join(''), '§3', [['inline source citation', SRC_CITE]]),
    ...censusClean.flatMap(fixture => scanText('clean.md', stripQuotedProductAndCodeSpans(fixture), '§4', VOICE_CENSUS_NEEDLES)),
  ]
  if (cleanHits.length > 0) {
    console.error('self-test FAILED: clean text was flagged:')
    for (const h of cleanHits) console.error(`  ${h.law} ${h.label}: ${h.excerpt}`)
    process.exit(1)
  }
}

selfTest()
const hits = scanTree()
if (hits.length > 0) {
  const verb = REPORT ? 'hit' : 'FAIL'
  for (const h of hits) console.error(`  [${verb}] ${h.file}:${h.line} ${h.law} ${h.label} — ${h.excerpt}`)
}
console.log(`docs-altitude: ${docsPages().length + ROOT_SURFACES.length} surfaces scanned, ${hits.length} hit(s)`)
if (hits.length > 0 && !REPORT) {
  console.error('❌ docs-altitude: the doc surfaces carry process vocabulary or verification citations')
  process.exit(1)
}
console.log(REPORT ? 'docs-altitude: report mode (no verdict)' : '✅ docs-altitude: clean')
