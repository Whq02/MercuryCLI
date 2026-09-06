
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

export const COMPASS_SID = '00000000-c0c0-4000-8000-000000001000'

export const TAIL_SENTINEL = 'FIXTURE-TAIL-⟦1K⟧'

export const STREAM_FIN = '⟦CFIN⟧'

export const CHAPTERS_DEFAULT = 53

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

const WORDS =
  `compass grammar focus geometry viewport anchor resize reflow cache warming
   generation selection navigation binding hint editor composer transcript
   overlay dialog board picker settle honest floor keypress paint frame`
    .split(/\s+/)
    .filter(Boolean)

function prose(rnd: () => number, targetChars: number): string {
  let text = ''
  let sinceNewline = 0
  while (text.length < targetChars) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)]!
    text += w
    sinceNewline += w.length + 1
    if (rnd() < 0.06 && sinceNewline > 90) {
      text += '.\n\n'
      sinceNewline = 0
    } else if (rnd() < 0.14) {
      text += '. '
    } else {
      text += ' '
    }
  }
  return text.trim()
}


const BASE_TS = Date.UTC(2026, 5, 20, 8, 0, 0)
const STEP_MS = 1200

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

export interface FixtureStats {
  lines: number
  bytes: number
  chapters: number
  byKind: Record<string, number>
}

export function buildCompass1k(cwd: string, chapters: number = CHAPTERS_DEFAULT): {
  lines: Record<string, unknown>[]
  stats: FixtureStats
} {
  const rnd = lcg(0xc0135)
  const lines: Record<string, unknown>[] = []
  const byKind: Record<string, number> = {}
  let n = 0
  let toolSeq = 0

  const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    entrypoint: 'cli',
    cwd,
    sessionId: COMPASS_SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    ...extra,
  })

  const push = (kind: string, extra: Record<string, unknown>): void => {
    n++
    byKind[kind] = (byKind[kind] ?? 0) + 1
    lines.push(
      base({
        parentUuid: n === 1 ? null : uuid(n - 1),
        uuid: uuid(n),
        timestamp: new Date(BASE_TS + n * STEP_MS).toISOString(),
        ...extra,
      }),
    )
  }

  const userText = (kind: string, text: string): void =>
    push(kind, { type: 'user', message: { role: 'user', content: text } })

  const assistantContent = (kind: string, content: unknown[], stopReason: string): void =>
    push(kind, {
      type: 'assistant',
      requestId: `req_compass_${n + 1}`,
      message: {
        id: `msg_compass_${n + 1}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })

  const assistantText = (kind: string, text: string): void =>
    assistantContent(kind, [{ type: 'text', text }], 'end_turn')

  const toolPair = (
    kind: string,
    name: string,
    input: Record<string, unknown>,
    resultContent: unknown,
    toolUseResult: unknown,
  ): void => {
    toolSeq++
    const id = `toolu_compass_${toolSeq}`
    assistantContent(kind, [{ type: 'tool_use', id, name, input }], 'tool_use')
    push(`${kind}-result`, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: resultContent }],
      },
      toolUseResult,
    })
  }


  const LONG_DIR =
    '/Users/op/dev/orchard/src/components/mercury-ui/interaction/fixtures/deeply/nested/compass/baseline'

  const tsSnippet = (c: number): string =>
    [
      `export function compassProbe${c}(anchor: number, generation: number): number {`,
      `  const settled = anchor * ${c} + generation // bounded incremental warmup`,
      `  if (settled < 0) throw new Error('clamp-at-zero violated in chapter ${c}')`,
      `  return Math.min(settled, ${c * 33})`,
      `}`,
    ].join('\n')

  const pySnippet = (c: number): string =>
    [
      `def measure_chapter_${c}(rows: list[str]) -> dict[str, int]:`,
      `    """Deterministic per-chapter paint accounting (chapter ${c})."""`,
      `    visible = [r for r in rows if r.strip()]`,
      `    return {"rows": len(rows), "visible": len(visible), "chapter": ${c}}`,
    ].join('\n')

  const BOX_ART = [
    '┌──────────┬──────────┬──────────┐',
    '│ ╔══════╗ │ ▲▲▲▲▲▲▲▲ │ ░░▒▒▓▓██ │',
    '│ ║ cell ║ │ ◤◢◤◢◤◢◤◢ │ ├──┼──┤  │',
    '│ ╚══════╝ │ ▼▼▼▼▼▼▼▼ │ └──┴──┘  │',
    '└──────────┴──────────┴──────────┘',
  ].join('\n')

  const CJK_A =
    '端末の描画性能を測定する。千件の会話でもリサイズとスクロールが滑らかに動作することを確認する。'
  const CJK_B =
    '终端渲染性能基准测试:包含宽字符、组合字符与制表符画线,验证单元格宽度计算的一致性。'
  const COMBINING =
    'diacritiqués: é à ô ñ ü — çombining marks stress the grapheme path'

  userText('user-prose', 'load the compass baseline fixture and keep the transcript dense. ' + prose(rnd, 160))
  assistantText(
    'assistant-prose',
    'This transcript is the 1k navigation fixture: prose, code, diffs, tool cards, CJK and a streamed tail. ' +
      prose(rnd, 220),
  )

  const CHAPTERS = Math.max(1, Math.floor(chapters))
  for (let c = 1; c <= CHAPTERS; c++) {
    const longPath = `${LONG_DIR}/veryLongFileNameForWidthStress-chapter-${String(c).padStart(4, '0')}.tsx`
    const fileBody = `// chapter ${c}\n${tsSnippet(c)}\n`

    userText('user-prose', prose(rnd, 180 + Math.floor(rnd() * 140)))
    assistantText(
      'assistant-md',
      `Chapter ${c}: **bounded warmup** with _generation fences_ and \`invalidate(${c})\` on resize.\n\n` +
        prose(rnd, 260),
    )
    userText('user-short', `show chapter ${c} of ${longPath}`)

    toolPair(
      'read',
      'Read',
      { file_path: longPath },
      [{ type: 'text', text: fileBody }],
      {
        type: 'text',
        file: {
          filePath: longPath,
          content: fileBody,
          numLines: fileBody.split('\n').length,
          startLine: 1,
          totalLines: fileBody.split('\n').length,
        },
      },
    )

    toolPair(
      'glob',
      'Glob',
      { pattern: `src/components/mercury-ui/**/chapter-${c}*.tsx` },
      [{ type: 'text', text: `${longPath}\n${LONG_DIR}/index-${c}.ts` }],
      {
        durationMs: 10 + (c % 7),
        numFiles: 2,
        filenames: [longPath, `${LONG_DIR}/index-${c}.ts`],
        truncated: false,
      },
    )

    const diffLines = [
      `-  const settled = anchor * ${c} + generation // stale`,
      `-  return Math.max(settled, -1)`,
      `+  const settled = anchor * ${c} + generation // bounded incremental warmup`,
      `+  if (settled < 0) throw new Error('clamp-at-zero violated in chapter ${c}')`,
      `+  return Math.min(settled, ${c * 33})`,
    ]
    toolPair(
      'edit',
      'Edit',
      {
        file_path: longPath,
        old_string: `return Math.max(settled, -1)`,
        new_string: `return Math.min(settled, ${c * 33})`,
      },
      'ok',
      {
        filePath: longPath,
        oldString: `return Math.max(settled, -1)`,
        newString: `return Math.min(settled, ${c * 33})`,
        originalFile: fileBody,
        structuredPatch: [
          { oldStart: 2, oldLines: 2, newStart: 2, newLines: 3, lines: diffLines },
        ],
        userModified: false,
        replaceAll: false,
      },
    )

    toolPair(
      'bash',
      'Bash',
      { command: `bun test chapter-${c}`, description: `Run chapter ${c} probes` },
      [{ type: 'text', text: `chapter-${c}: 12 pass, 0 fail\nelapsed ${40 + (c % 9)}ms` }],
      {
        stdout: `chapter-${c}: 12 pass, 0 fail\nelapsed ${40 + (c % 9)}ms`,
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    )

    assistantText('assistant-code-ts', `The settled form:\n\n\`\`\`ts\n${tsSnippet(c)}\n\`\`\`\n\n` + prose(rnd, 90))
    userText('user-cjk', `${CJK_A} (${c})`)
    assistantText('assistant-cjk-art', `${CJK_B}\n\n\`\`\`\n${BOX_ART}\n\`\`\`\n\n${COMBINING}`)
    assistantText('assistant-code-py', `Python probe:\n\n\`\`\`py\n${pySnippet(c)}\n\`\`\``)
    userText(
      'user-url',
      `see https://compass.example.com/very/long/unbreakable/path/segment/chapter/${c}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?generation=${c} for the trace`,
    )
    assistantText(
      'assistant-table',
      [
        '| leg | p50 | p95 | frames | verdict |',
        '|-----|-----|-----|--------|---------|',
        `| resize-${c} | ${10 + (c % 5)}ms | ${30 + (c % 11)}ms | ${c % 4} | pending |`,
        `| scroll-${c} | ${8 + (c % 3)}ms | ${22 + (c % 7)}ms | ${c % 3} | pending |`,
      ].join('\n'),
    )

    const report = `chapter ${c} scouted: warmup bounded, generation fences hold. REPORT-${c}`
    toolPair(
      'agent',
      'Agent',
      { description: `Scout chapter ${c}`, prompt: `Read chapter ${c} and report.`, subagent_type: 'Explore' },
      [{ type: 'text', text: report }],
      {
        status: 'completed',
        agentId: `compassagent${c}`,
        agentType: 'Explore',
        content: [{ type: 'text', text: report }],
        totalDurationMs: 1000 + c,
        totalToolUseCount: 2,
        totalTokens: 900 + c,
        usage: {
          input_tokens: 500,
          output_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
        prompt: `Read chapter ${c} and report.`,
      },
    )
  }

  userText('user-short', 'summarize the fixture state')
  assistantText(
    'assistant-tail',
    `All ${CHAPTERS} chapters staged; the fixture bottom is live. ${TAIL_SENTINEL}`,
  )

  const bytes = lines.reduce((a, l) => a + JSON.stringify(l).length + 1, 0)
  return { lines, stats: { lines: lines.length, bytes, chapters: CHAPTERS, byKind } }
}

export function writeCompass1k(outPath: string, cwd: string): FixtureStats {
  const { lines, stats } = buildCompass1k(cwd)
  writeFileSync(outPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return stats
}

export function streamedTailTurn(): ScriptedTurn {
  const rnd = lcg(0xc0136)
  const deltas: string[] = []
  for (let i = 0; i < 59; i++) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)]!
    deltas.push(i % 9 === 8 ? `${w}.\n` : `${w} `)
  }
  deltas.push(` ${STREAM_FIN}`)
  return { kind: 'paced', deltas, gapMs: 45, stopReason: 'end_turn' }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null
  const cwd = args.includes('--cwd')
    ? args[args.indexOf('--cwd') + 1]!
    : join(import.meta.dir, '..', '..')
  if (out) {
    const stats = writeCompass1k(out, cwd)
    console.log(JSON.stringify({ out, sid: COMPASS_SID, ...stats }, null, 2))
  } else {
    const { stats } = buildCompass1k(cwd)
    console.log(JSON.stringify({ sid: COMPASS_SID, ...stats }, null, 2))
  }
}
