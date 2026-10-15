import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const revIdx = process.argv.indexOf('--rev')
const REV = revIdx >= 0 ? process.argv[revIdx + 1] ?? null : null

export interface IntegrityHit {
  file: string
  line: number
  kind: 'glued-heading' | 'repeated-line-or-clause' | 'cut-or-spliced-sentence'
  excerpt: string
}

function docFiles(root: string): string[] {
  const docs = readdirSync(join(root, 'docs'))
    .filter(n => n.endsWith('.md'))
    .sort()
    .map(n => `docs/${n}`)
  return ['README.md', ...docs]
}

function readSurface(root: string, rel: string, rev: string | null): string {
  if (rev !== null) {
    return execFileSync('git', ['-C', root, 'show', `${rev}:${rel}`], { encoding: 'utf8' })
  }
  return readFileSync(join(root, rel), 'utf8')
}

export function scanMarkdownIntegrity(file: string, text: string): IntegrityHit[] {
  const hits: IntegrityHit[] = []
  const lines = text.split('\n')
  let fenced = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue

    if (/^#{1,6}\s+\S/.test(trimmed) && i > 0) {
      const prev = lines[i - 1]!.trim()
      if (prev !== '' && !/^<!--.*-->$/.test(prev)) {
        hits.push({
          file,
          line: i + 1,
          kind: 'glued-heading',
          excerpt: `${prev.slice(-40)} ⏎ ${trimmed.slice(0, 60)}`,
        })
      }
    }

    if (trimmed !== '' && !/^(\||[-*]\s*$|<!--)/.test(trimmed) && i > 0) {
      const prev = lines[i - 1]!.trim()
      if (prev === trimmed) {
        hits.push({
          file,
          line: i + 1,
          kind: 'repeated-line-or-clause',
          excerpt: `duplicate line: ${trimmed.slice(0, 90)}`,
        })
      } else if (
        i >= 2 &&
        trimmed.length >= 25 &&
        lines[i - 2]!.trim() === trimmed
      ) {
        hits.push({
          file,
          line: i + 1,
          kind: 'repeated-line-or-clause',
          excerpt: `line repeated after 1-line gap: ${trimmed.slice(0, 90)}`,
        })
      } else if (
        (trimmed.length >= 4 &&
          /^[a-zA-Z` ]+[.!?:;)]$/.test(trimmed) &&
          prev.endsWith(` ${trimmed}`)) ||
        (trimmed.length >= 20 && prev.endsWith(` ${trimmed}`))
      ) {
        hits.push({
          file,
          line: i + 1,
          kind: 'repeated-line-or-clause',
          excerpt: `duplicate line tail: "${trimmed}" after "${prev.slice(-50)}"`,
        })
      }
    }

    for (const span of [2, 3]) {
      if (i + 1 >= span * 2) {
        const blockA = lines
          .slice(i + 1 - span * 2, i + 1 - span)
          .map(l => l.trim())
          .join('\n')
        const blockB = lines
          .slice(i + 1 - span, i + 1)
          .map(l => l.trim())
          .join('\n')
        if (blockA.length >= 20 && blockA === blockB) {
          hits.push({
            file,
            line: i + 1,
            kind: 'repeated-line-or-clause',
            excerpt: `repeated ${span}-line block: ${blockB.replace(/\n/g, ' / ').slice(0, 90)}`,
          })
        }
      }
    }

    if (i > 0 && trimmed !== '') {
      const prev = lines[i - 1]!.trim()
      if (
        prev !== '' &&
        !/^(#{1,6}\s|\||```|~~~|<!--)/.test(prev) &&
        !/^(#{1,6}\s|\||[-*]\s|\d+\.\s|```|~~~|<!--)/.test(trimmed)
      ) {
        const prevNoCode = prev.replace(/`[^`]*`/g, 'code')
        if (
          /[.!?][)"'`]*$/.test(prevNoCode) &&
          !/`[a-zA-Z0-9_./-]+`$/.test(prev) &&
          /^[a-z]/.test(trimmed) &&
          !/^(https?:\/\/|s\b)/.test(trimmed)
        ) {
          hits.push({
            file,
            line: i + 1,
            kind: 'cut-or-spliced-sentence',
            excerpt: `lowercase start after sentence end: "${prev.slice(-40)}" -> "${trimmed.slice(0, 50)}"`,
          })
        }
      }
    }
  }

  fenced = false
  let paraStart = -1
  let paraLines: string[] = []
  const flushPara = (): void => {
    if (paraLines.length === 0) return
    const joined = paraLines.join(' ')
    const stripped = joined.replace(/`[^`]*`/g, 'code')
    const opens = (stripped.match(/\(/g) ?? []).length
    const closes = (stripped.match(/\)/g) ?? []).length
    if (opens !== closes) {
      hits.push({
        file,
        line: paraStart,
        kind: 'cut-or-spliced-sentence',
        excerpt: `unbalanced parentheses (${opens} open vs ${closes} close): ${paraLines[0]!.trim().slice(0, 80)}`,
      })
    }
    const words = stripped.toLowerCase().split(/\s+/).filter(Boolean)
    for (let w = 0; w + 16 <= words.length; w++) {
      const runA = words.slice(w, w + 8).join(' ')
      const runB = words.slice(w + 8, w + 16).join(' ')
      if (runA.length >= 28 && runA === runB) {
        hits.push({
          file,
          line: paraStart,
          kind: 'repeated-line-or-clause',
          excerpt: `repeated 8-word clause: "${runA}"`,
        })
        break
      }
    }
    for (const [re, label] of [
      [/\bbranch and\s+Parallel crewmates\b/, 'cut tail after "branch and"'],
      [/\bmain thread and\s+`models` breaks\b/, 'cut tail after "main thread and"'],
      [/\bSIGINT and\s+When the refusal\b/, 'cut sentence after "SIGINT and"'],
      [/\bA resumed session\s+back on the launch's\b/, 'missing verb in "A resumed session back on"'],
      [/\bOn a short window\s+the command list and pages\b/, 'spliced sentences at "On a short window"'],
      [/\bthe Claude\s+side once a request\b/, 'missing image-cap clause after "the Claude"'],
      [/\bA turn that fails inside the runner before it has\s+saying so\./, 'garbled splice "before it has saying so"'],
      [/\bThe model's own questions to you\s+appear\./, 'missing parenthetical in "questions to you appear"'],
      [/\brefuses drive\s+\(`C:\\Users`/, 'missing "roots (`C:\\`)" after "refuses drive"'],
      [/\blets a refuse-list hit\s+tool call and the match\b/, 'missing "proceed and leaves one warning row..."'],
      [/\barms the one-shot marker\s+\(`splash-action\.json`/, 'missing "`MERCURY_SPLASH_HANDOFF`" after "marker"'],
      [/\band the `\/config` row\s+never waits for a session\b/, 'missing "**Shell engine sessions**" after "`/config` row"'],
      [/\brefuses a process that is\s+that once more\b/, 'missing clause between "that is" and "that once more"'],
      [/\bruns on the native `\/api\/chat` road\s+the ingest at the measured pace\b/, 'missing clause before "the ingest at the measured pace"'],
      [/\bfile opens, still\s+Blender has no test framework\b/, 'missing "renders, reports, and `python_run` live here"'],
      [/\bcapability-readiness rows, each\s+kind one of `tool`/, 'missing `{id, kind, ...}` tuple after "rows, each"'],
    ] as const) {
      if (re.test(joined)) {
        hits.push({
          file,
          line: paraStart,
          kind: 'cut-or-spliced-sentence',
          excerpt: `${label}: ${joined.slice(0, 90)}`,
        })
      }
    }
    paraLines = []
    paraStart = -1
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    if (/^\s*(```|~~~)/.test(raw)) {
      flushPara()
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (trimmed === '' || /^(#{1,6}\s|\||<!--)/.test(trimmed)) {
      flushPara()
      continue
    }
    if (/^([-*]|\d+\.)\s/.test(trimmed)) {
      flushPara()
      paraStart = i + 1
      paraLines = [trimmed]
      continue
    }
    if (paraLines.length === 0) paraStart = i + 1
    paraLines.push(trimmed)
  }
  flushPara()

  return hits
}

function selfTest(): void {
  const glued = scanMarkdownIntegrity('fixture.md', 'A paragraph line.\n## A glued heading\n')
  if (!glued.some(h => h.kind === 'glued-heading')) {
    console.error('self-test FAILED: glued heading was not caught')
    process.exit(1)
  }
  const dupLine = scanMarkdownIntegrity('fixture.md', '# Title\n\nSame line twice.\nSame line twice.\n')
  if (!dupLine.some(h => h.kind === 'repeated-line-or-clause')) {
    console.error('self-test FAILED: duplicate line was not caught')
    process.exit(1)
  }
  const dupTail = scanMarkdownIntegrity('fixture.md', '# Title\n\nMercury never updates Aseprite for you.\nfor you.\n')
  if (!dupTail.some(h => h.kind === 'repeated-line-or-clause')) {
    console.error('self-test FAILED: duplicate line tail was not caught')
    process.exit(1)
  }
  const cutParen = scanMarkdownIntegrity('fixture.md', '# Title\n\nPages (`Retain`, `Recall`,\nRecall fuses the model.\n')
  if (!cutParen.some(h => h.kind === 'cut-or-spliced-sentence')) {
    console.error('self-test FAILED: unbalanced parenthesis cut was not caught')
    process.exit(1)
  }
  const lowercaseAfterStop = scanMarkdownIntegrity('fixture.md', '# Title\n\nThe turn finishes.\nanswer leaves it completed.\n')
  if (!lowercaseAfterStop.some(h => h.kind === 'cut-or-spliced-sentence')) {
    console.error('self-test FAILED: lowercase start after sentence end was not caught')
    process.exit(1)
  }
  const clean = scanMarkdownIntegrity('clean.md', '# Title\n\nFirst paragraph is whole.\n\n## Section\n\nSecond paragraph is whole (with balanced parens).\n')
  if (clean.length > 0) {
    console.error('self-test FAILED: clean text was flagged:', clean)
    process.exit(1)
  }
}

selfTest()
const files = docFiles(ROOT)
const allHits: IntegrityHit[] = []
for (const rel of files) {
  const text = readSurface(ROOT, rel, REV)
  allHits.push(...scanMarkdownIntegrity(rel, text))
}
for (const h of allHits) {
  console.error(`  [FAIL] ${h.file}:${h.line} (${h.kind}) — ${h.excerpt}`)
}
console.log(`docs-integrity${REV ? ` (${REV})` : ''}: ${files.length} surfaces scanned, ${allHits.length} hit(s)`)
if (allHits.length > 0) {
  console.error('❌ docs-integrity: broken sentences, repeated lines/clauses, or glued headings found')
  process.exit(1)
}
console.log('✅ docs-integrity: clean')
