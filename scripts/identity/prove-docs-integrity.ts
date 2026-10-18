import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const revIdx = process.argv.indexOf('--rev')
const REV = revIdx >= 0 ? process.argv[revIdx + 1] ?? null : null
const baseIdx = process.argv.indexOf('--base')
const BASE_ASKED = baseIdx >= 0 ? process.argv[baseIdx + 1] ?? null : null
const BASE_REV = resolveBaseRev(BASE_ASKED)
function resolveBaseRev(rev: string | null): string | null {
  if (rev === null) return null
  try {
    execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', '-q', `${rev}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return rev
  } catch {
    console.log(`docs-integrity: the base ${rev} is not a commit of this tree (a published form rewrites the history), so the base-revision tail scan is skipped here`)
    return null
  }
}

interface IntegrityHit {
  file: string
  line: number
  kind:
    | 'glued-heading'
    | 'repeated-line-or-clause'
    | 'cut-or-spliced-sentence'
    | 'mixed-quote-marks'
    | 'unbalanced-code-span'
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

function readBaseSurface(root: string, rel: string, rev: string | null): string | undefined {
  if (rev === null) return undefined
  try {
    return execFileSync('git', ['-C', root, 'show', `${rev}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

function tailWords(line: string, count: number): string {
  const words = line
    .replace(/[,:;—]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length < count) return ''
  return words.slice(-count).join(' ')
}

function headWords(line: string, count: number): string {
  const words = line.trim().split(/\s+/).filter(Boolean)
  if (words.length < count) return ''
  return words.slice(0, count).join(' ')
}

function scanBaseRevisionTails(file: string, baseText: string, text: string): IntegrityHit[] {
  const hits: IntegrityHit[] = []
  const baseLines = baseText.split('\n')
  const lines = text.split('\n')
  let fenced = false

  const baseByTail = new Map<string, number[]>()
  let baseFenced = false
  for (let b = 0; b < baseLines.length; b++) {
    const raw = baseLines[b]!
    if (/^\s*(```|~~~)/.test(raw)) {
      baseFenced = !baseFenced
      continue
    }
    if (baseFenced) continue
    const tw = tailWords(raw, 2)
    if (!tw) continue
    const list = baseByTail.get(tw) ?? []
    list.push(b)
    baseByTail.set(tw, list)
  }

  for (let i = 0; i < lines.length - 1; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (trimmed === '' || /^(#{1,6}\s|\||<!--)/.test(trimmed)) continue
    if (/[.!?:;—]$/.test(trimmed)) continue

    const tw = tailWords(trimmed, 2)
    const candidates = tw ? baseByTail.get(tw) : undefined
    if (!candidates) continue

    const nextTrimmed = lines[i + 1]!.trim()
    if (nextTrimmed === '') continue

    const cleanClause = (s: string): string =>
      s
        .replace(/\s*[—,(;].*$/, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .join(' ')
    const firstWordClean = (s: string): string =>
      (s.trim().split(/\s+/)[0] ?? '').replace(/[,:;().—]/g, '')
    const firstNext = cleanClause(nextTrimmed)
    const fwNext = firstWordClean(nextTrimmed)
    if (
      candidates.some(b => {
        const bn = baseLines[b + 1]?.trim() ?? ''
        return (
          bn === nextTrimmed ||
          (firstNext !== '' && cleanClause(bn) === firstNext) ||
          (/^[A-Z]/.test(fwNext) && firstWordClean(bn) === fwNext)
        )
      })
    ) {
      continue
    }

    for (const b of candidates) {
      if (b + 1 >= baseLines.length) continue
      const baseNext = baseLines[b + 1]!.trim()
      if (baseNext === '') continue

      if (/^`?\{[a-zA-Z0-9_, ]+\}`?/.test(lines[i]!.trim().slice(lines[i]!.indexOf(tw) + tw.length).trim()) === false) {
        const baseRest = baseLines[b]!.trim().slice(baseLines[b]!.trim().replace(/\s+—\s+/g, ', ').indexOf(tw) + tw.length).trim()
        if (/^`?\{[a-zA-Z0-9_, ]+/.test(baseRest) && !/^`?\{/.test(nextTrimmed)) {
          hits.push({
            file,
            line: i + 1,
            kind: 'cut-or-spliced-sentence',
            excerpt: `dropped braced tuple after "${tw}": missing "${baseRest.slice(0, 50)}"`,
          })
          break
        }
      }

      for (const skip of [2, 3, 4]) {
        if (b + skip < baseLines.length) {
          const skippedTarget = baseLines[b + skip]!.trim()
          const targetHw = headWords(skippedTarget, 3)
          const nextHw3 = headWords(nextTrimmed, 3)
          if (
            skippedTarget.length >= 6 &&
            (nextTrimmed === skippedTarget || (targetHw.length >= 10 && nextHw3 === targetHw))
          ) {
            hits.push({
              file,
              line: i + 1,
              kind: 'cut-or-spliced-sentence',
              excerpt: `dropped ${skip - 1} base line(s) mid-sentence after "${tw}": missing "${baseNext.slice(0, 60)}"`,
            })
            break
          }
        }
      }

      if (
        /\b(and|or|to|of|in|on|for|with|from|by|at|as|into|under|over|before|after|while|when|where|that|which|whose|is|are|was|were|has|have|had|the|a|an)$/.test(
          trimmed,
        ) &&
        (/^([A-Z][a-z]+|`[a-zA-Z0-9_]+`\s+[a-z]+s\b)/.test(nextTrimmed) ||
          /^[a-z]+ing\s+so\./.test(nextTrimmed)) &&
        !nextTrimmed.startsWith(baseNext.slice(0, Math.min(12, baseNext.length)))
      ) {
        const joinedPara = `${trimmed} ${nextTrimmed}`
        const baseTailSentence = baseNext.split(/[.!?]/)[0]!.trim()
        const wordCount = baseTailSentence.split(/\s+/).filter(Boolean).length
        const tailCheck = tailWords(baseTailSentence, Math.min(3, Math.max(1, wordCount)))
        if (tailCheck && !joinedPara.includes(tailCheck)) {
          hits.push({
            file,
            line: i + 1,
            kind: 'cut-or-spliced-sentence',
            excerpt: `cut sentence tail after "${tw}" (base continued with "${baseNext.slice(0, 50)}")`,
          })
          break
        }
      }
    }
  }

  return hits
}

function scanMarkdownIntegrity(file: string, text: string, baseText?: string): IntegrityHit[] {
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
          excerpt: `${prev.slice(-40)} ↵ ${trimmed.slice(0, 60)}`,
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

    const withoutDouble = joined.replace(/``[\s\S]*?``/g, match => {
      const inner = match.slice(2, -2).trim()
      if ((inner.startsWith('"') && !inner.endsWith('"')) || (inner.startsWith('“') && !inner.endsWith('”')) || /^”/.test(inner)) {
        hits.push({
          file,
          line: paraStart,
          kind: 'mixed-quote-marks',
          excerpt: `mismatched outer quotes in double-backtick span: ${match.slice(0, 80)}`,
        })
      }
      return 'code'
    })

    const singleSpans = [...withoutDouble.matchAll(/`([^`]*)`/g)]
    for (const m of singleSpans) {
      const inner = m[1]!
      if (
        /^"[A-Za-z]/.test(inner) &&
        !/^"[A-Za-z0-9_]+":/.test(inner) &&
        !inner.endsWith('"') &&
        !inner.endsWith('”')
      ) {
        hits.push({
          file,
          line: paraStart,
          kind: 'unbalanced-code-span',
          excerpt: `code span opens with '"' but does not close with '"' (inner backtick split): \`${inner.slice(0, 70)}\``,
        })
      }
      if (
        (inner.startsWith('"') && /[“”]$/.test(inner)) ||
        (/^[“”]/.test(inner) && inner.endsWith('"')) ||
        /^”/.test(inner)
      ) {
        hits.push({
          file,
          line: paraStart,
          kind: 'mixed-quote-marks',
          excerpt: `mixed or reversed outer quote marks in code span: \`${inner.slice(0, 70)}\``,
        })
      }
    }

    const leftoverBackticks = withoutDouble.replace(/`[^`]*`/g, '')
    if (leftoverBackticks.includes('`')) {
      hits.push({
        file,
        line: paraStart,
        kind: 'unbalanced-code-span',
        excerpt: `odd/unbalanced backtick in paragraph: ${paraLines[0]!.trim().slice(0, 80)}`,
      })
    }

    if (/"[^"\n“”]*[“”]|”[^"\n“”]*"/.test(leftoverBackticks)) {
      hits.push({
        file,
        line: paraStart,
        kind: 'mixed-quote-marks',
        excerpt: `mixed straight and curly quote marks in prose: ${paraLines[0]!.trim().slice(0, 80)}`,
      })
    }

    const stripped = withoutDouble.replace(/`[^`]*`/g, 'code')
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
    let foundClauseRepeat = false
    for (let w = 0; w + 16 <= words.length && !foundClauseRepeat; w++) {
      const runWords = words.slice(w, w + 8)
      if (runWords.some(tok => /[.!?]$/.test(tok))) continue
      const runA = runWords.join(' ')
      if (runA.length < 28) continue
      const maxOffset = Math.min(words.length - 8, w + 40)
      for (let w2 = w + 8; w2 <= maxOffset; w2++) {
        if (words.slice(w, w2).some(tok => /[.!?]$/.test(tok))) break
        const runB = words.slice(w2, w2 + 8).join(' ')
        if (runA === runB) {
          hits.push({
            file,
            line: paraStart,
            kind: 'repeated-line-or-clause',
            excerpt: `repeated 8-word clause: "${runA}"`,
          })
          foundClauseRepeat = true
          break
        }
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

  if (baseText !== undefined) {
    hits.push(...scanBaseRevisionTails(file, baseText, text))
  }

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
  const dupTenWords = scanMarkdownIntegrity(
    'fixture.md',
    '# Title\n\nA crewmate continues from where its transcript ends on disk and a crewmate continues from where its transcript ends on disk.\n',
  )
  if (!dupTenWords.some(h => h.kind === 'repeated-line-or-clause')) {
    console.error('self-test FAILED: 10-word repeated clause was not caught')
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
  const mixedQuotes = scanMarkdownIntegrity('fixture.md', '# Title\n\nThe hint row says `"held until compaction lands”`.\n')
  if (!mixedQuotes.some(h => h.kind === 'mixed-quote-marks')) {
    console.error('self-test FAILED: mixed quote marks were not caught')
    process.exit(1)
  }
  const splitSpan = scanMarkdownIntegrity(
    'fixture.md',
    '# Title\n\n`mercury update` asks `"This Mercury was installed by Homebrew. Run `brew upgrade` now? [y/N]"`.\n',
  )
  if (!splitSpan.some(h => h.kind === 'unbalanced-code-span')) {
    console.error('self-test FAILED: split quoted code span was not caught')
    process.exit(1)
  }
  const oddBacktick = scanMarkdownIntegrity('fixture.md', '# Title\n\nA paragraph with an `unclosed code span.\n')
  if (!oddBacktick.some(h => h.kind === 'unbalanced-code-span')) {
    console.error('self-test FAILED: odd backtick count was not caught')
    process.exit(1)
  }

  const sectionACutFixtures: Array<[string, string, string]> = [
    [
      'row-1',
      '`worktree` in chat to run `EnterWorktree`) to give a session its own branch and\ncheckout under `.mercury/worktrees/`. When a session spawns parallel crewmates\n',
      '`worktree` in chat to run `EnterWorktree`) to give a session its own branch and\nParallel crewmates can also run in isolated worktrees.\n',
    ],
    [
      'row-2',
      'when reported, `reasoning_output_tokens`, summed over the main thread and\nthe crewmates. `models` gives the per-model figures;\n',
      'when reported, `reasoning_output_tokens`, summed over the main thread and\n`models` breaks token usage down by model.\n',
    ],
    [
      'row-3',
      'run exits 0, other outcomes exit 1, and a usage error exits 2. SIGINT and\nSIGTERM exit 130 and 143 after the interrupted turn\'s outcome is flushed.\n',
      'run exits 0, other outcomes exit 1, and a usage error exits 2. SIGINT and\nWhen the refusal was an ask nobody could answer, the run is blocked.\n',
    ],
    [
      'row-8',
      'you make one, applies to that one session. A resumed session\nkeeps the model and effort it was on unless the command line says\notherwise: `--continue --model <id> --effort <level>` brings the session\nback on the launch\'s model and effort, its record is re-stamped, and the\n',
      'you make one, applies to that one session. A resumed session\nback on the launch\'s model and effort, its record is re-stamped, and the\n',
    ],
    [
      'row-9',
      'count of the lines shown against the lines it has written. On a short window\nthe command yields rows to the output, so at least one line of it always\nshows. In `/help`, pressing `PageDown` or `PageUp` from the tab header enters\nthe command list and pages immediately.\n',
      'count of the lines shown against the lines it has written. On a short window\nthe command list and pages immediately.\n',
    ],
    [
      'row-10',
      'names which limit and what size. Each provider\'s rule is its own: the Claude\nAPI caps an image at 10 MB of base64 and 8000 px a side, and at 2000 px a\nside once a request carries more than 20 images, while the OpenAI\n',
      'names which limit and what size. Each provider\'s rule is its own: the Claude\nside once a request carries more than 20 images, while the OpenAI\n',
    ],
    [
      'row-11',
      'with that status. A turn that fails inside the runner before it has\nstarted settles with an error row\nsaying so. A turn that fails inside the runner\'s own machinery before it has\n',
      'with that status. A turn that fails inside the runner before it has\nsaying so. A turn that fails inside the runner\'s own machinery before it has\n',
    ],
    [
      'row-14',
      'apply, and a refusal is not a card. The model\'s own questions to you\n(AskUserQuestion, the Apollo review) are not permission cards and still\nappear.\n',
      'apply, and a refusal is not a card. The model\'s own questions to you\nappear.\n',
    ],
    [
      'row-15',
      'outside `/var/tmp` and `/var/folders`). On Windows, the same rule refuses drive\nroots (`C:\\`), your own home, other users\' homes and the `Users` root\n(`C:\\Users`, `C:\\Users\\<anyone>`), system folders (`C:\\Windows`, `C:\\Program\n',
      'outside `/var/tmp` and `/var/folders`). On Windows, the same rule refuses drive\n(`C:\\Users`, `C:\\Users\\<anyone>`), system folders (`C:\\Windows`, `C:\\Program\n',
    ],
    [
      'row-16',
      'stands down within a session. `MERCURY_WARDS=warn` lets a refuse-list hit\nproceed and leaves one warning row on the transcript naming the ward, the\ntool call and the match (shown in the session, recorded on a headless\n',
      'stands down within a session. `MERCURY_WARDS=warn` lets a refuse-list hit\ntool call and the match (shown in the session, recorded on a headless\n',
    ],
    [
      'row-17',
      'background handed back) and boots plain. A handover arms the one-shot marker\n`MERCURY_SPLASH_HANDOFF`; the runtime then reads the enter-screen choice\n(`splash-action.json` under the config home, matched to the launch\'s own id)\n',
      'background handed back) and boots plain. A handover arms the one-shot marker\n(`splash-action.json` under the config home, matched to the launch\'s own id)\n',
    ],
    [
      'row-18',
      '`MERCURY_SHELL_ENGINE_SESSIONS` env pin over it, and the `/config` row\n**Shell engine sessions** beside **Shell engine**. The main conversation\nnever waits for a session; a crewmate that needs one while the crewmates\'\n',
      '`MERCURY_SHELL_ENGINE_SESSIONS` env pin over it, and the `/config` row\nnever waits for a session; a crewmate that needs one while the crewmates\'\n',
    ],
    [
      'row-19',
      'executable and account against what was reviewed, refuses a process that is\nnot the current user\'s or whose terminal is live or unknown, re-reads all of\nthat once more immediately before acting, and then ends that one process,\n',
      'executable and account against what was reviewed, refuses a process that is\nthat once more immediately before acting, and then ends that one process,\n',
    ],
    [
      'row-20',
      '(`reply with the single word ready`) runs on the native `/api/chat` road\nand the dialog shows the reply\'s first line with its timings: the load, and\nthe ingest at the measured pace. The last row reads `ready ·\n',
      '(`reply with the single word ready`) runs on the native `/api/chat` road\nthe ingest at the measured pace. The last row reads `ready ·\n',
    ],
    [
      'row-22',
      'documented order). In-Blender scene/object/render truth, file opens, still\nrenders, reports, and `python_run` live here. There is no test-run road:\nBlender has no test framework, and a rendered image is not a test run.\n',
      'documented order). In-Blender scene/object/render truth, file opens, still\nBlender has no test framework, and a rendered image is not a test run.\n',
    ],
    [
      'row-27',
      '- `readiness[]` — the capability-readiness rows: each\n  `{id, kind, label, state, detail, source, lastCheckedAt, latencyMs}`, with\n  kind one of `tool`, `mcp`, `lane`, `engine`, `extension`, `skill`, and state\n',
      '- `readiness[]`: the capability-readiness rows, each\n  kind one of `tool`, `mcp`, `lane`, `engine`, `extension`, `skill`, and state\n',
    ],
  ]

  for (const [id, baseFixture, brokenFixture] of sectionACutFixtures) {
    const found = scanMarkdownIntegrity('fixture.md', brokenFixture, baseFixture)
    if (!found.some(h => h.kind === 'cut-or-spliced-sentence')) {
      console.error(`self-test FAILED: section A cut fixture ${id} was not caught`)
      process.exit(1)
    }
  }

  const clean = scanMarkdownIntegrity(
    'clean.md',
    '# Title\n\nFirst paragraph is whole.\n\n## Section\n\nSecond paragraph is whole (with balanced parens and `` "quoted `code` span" ``).\n',
    '# Title\n\nFirst paragraph is whole.\n\n## Section\n\nSecond paragraph is whole (with balanced parens).\n',
  )
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
  const baseText = readBaseSurface(ROOT, rel, BASE_REV)
  allHits.push(...scanMarkdownIntegrity(rel, text, baseText))
}
for (const h of allHits) {
  console.error(`  [FAIL] ${h.file}:${h.line} (${h.kind}) — ${h.excerpt}`)
}
console.log(
  `docs-integrity${REV ? ` (rev=${REV})` : ''}${BASE_REV ? ` (base=${BASE_REV})` : ''}: ${files.length} surfaces scanned, ${allHits.length} hit(s)`,
)
if (allHits.length > 0) {
  console.error('❌ docs-integrity: broken sentences, repeated lines/clauses, mixed quotes, unbalanced code spans, or glued headings found')
  process.exit(1)
}
console.log('✅ docs-integrity: clean')
