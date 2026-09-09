#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hashline-measure-'))
process.env.MERCURY_BARE = '1'

const repoRoot = resolve(import.meta.dir, '../..')

const { anchorDomainLines, addAnchoredLineNumbers, formatLineAnchor } = await import(
  '../../src/services/changeTransaction/lineAnchors.ts'
)
const { addLineNumbers } = await import('../../src/utils/file.ts')
const { roughTokenCountEstimationForFileType } = await import('../../src/services/tokenEstimation.ts')

const CORPUS = [
  'src/services/changeTransaction/snapshotAnchor.ts',
  'src/services/changeTransaction/hunks.ts',
  'src/services/changeTransaction/lineAnchors.ts',
  'src/services/changeTransaction/seenLines.ts',
  'src/tools/FileEditTool/types.ts',
  'src/utils/fileStateCache.ts',
]

const CONTEXT_LINES = 2

interface Column {
  bytes: number
  tokens: number
}
const col = (): Column => ({ bytes: 0, tokens: 0 })
function charge(column: Column, payload: string, ext: string): void {
  column.bytes += Buffer.byteLength(payload, 'utf8')
  column.tokens += roughTokenCountEstimationForFileType(payload, ext)
}

function nonEmptyAt(lines: string[], i: number): number {
  for (let k = i; k <= lines.length; k++) {
    if ((lines[k - 1] ?? '').trim() !== '') return k
  }
  return Math.min(i, lines.length)
}

const exactEmit = col()
const hashEmit = col()
const exactRecovery = col()
const hashRecovery = col()
let readPlainBytes = 0
let readAnchoredBytes = 0
let readPlainTokens = 0
let readAnchoredTokens = 0
let editCount = 0
let fileCount = 0

for (const rel of CORPUS) {
  const path = join(repoRoot, rel)
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    continue
  }
  fileCount++
  const ext = rel.split('.').pop() ?? 'ts'
  const lines = anchorDomainLines(content)

  const plainPresentation = addLineNumbers({ content, startLine: 1 })
  const anchoredPresentation = addAnchoredLineNumbers({ content, startLine: 1, compact: true })
  readPlainBytes += Buffer.byteLength(plainPresentation, 'utf8')
  readAnchoredBytes += Buffer.byteLength(anchoredPresentation, 'utf8')
  readPlainTokens += roughTokenCountEstimationForFileType(plainPresentation, ext)
  readAnchoredTokens += roughTokenCountEstimationForFileType(anchoredPresentation, ext)

  const targets = [0.2, 0.5, 0.8].map(f => nonEmptyAt(lines, Math.max(1, Math.floor(lines.length * f))))
  const spellEdit = (n: number, replacement: string): { exact: string; hash: string } => {
    const from = Math.max(1, n - CONTEXT_LINES)
    const to = Math.min(lines.length, n + CONTEXT_LINES)
    const oldBlock = lines.slice(from - 1, to).join('\n')
    const newBlock = lines
      .slice(from - 1, to)
      .map((l, i) => (from + i === n ? replacement : l))
      .join('\n')
    return {
      exact: JSON.stringify({ file_path: path, old_string: oldBlock, new_string: newBlock }),
      hash: JSON.stringify({
        file_path: path,
        hunks: [{ lines: formatLineAnchor(n, lines[n - 1]!), replace: replacement }],
      }),
    }
  }

  for (const n of targets) {
    const spelled = spellEdit(n, `${lines[n - 1]!} // measured-edit`)
    charge(exactEmit, spelled.exact, 'json')
    charge(hashEmit, spelled.hash, 'json')
    editCount++
  }

  const mid = targets[1]!
  {
    const from = Math.max(1, mid - CONTEXT_LINES)
    const oldBlock = lines.slice(from - 1, mid).join('\n')
    const inserted = '// measured-insert'
    charge(
      exactEmit,
      JSON.stringify({ file_path: path, old_string: oldBlock, new_string: `${oldBlock}\n${inserted}` }),
      'json',
    )
    charge(
      hashEmit,
      JSON.stringify({
        file_path: path,
        hunks: [{ lines: formatLineAnchor(mid, lines[mid - 1]!), insert: 'after', replace: inserted }],
      }),
      'json',
    )
    editCount++
  }

  if (mid + 2 <= lines.length) {
    const from = Math.max(1, mid - CONTEXT_LINES)
    const to = Math.min(lines.length, mid + 2 + CONTEXT_LINES)
    const oldBlock = lines.slice(from - 1, to).join('\n')
    const replacement = '// measured-range'
    const newBlock = [
      ...lines.slice(from - 1, mid - 1),
      replacement,
      ...lines.slice(mid + 2, to),
    ].join('\n')
    charge(exactEmit, JSON.stringify({ file_path: path, old_string: oldBlock, new_string: newBlock }), 'json')
    charge(
      hashEmit,
      JSON.stringify({
        file_path: path,
        hunks: [
          {
            lines: `${formatLineAnchor(mid, lines[mid - 1]!)}-${formatLineAnchor(mid + 2, lines[mid + 1]!)}`,
            replace: replacement,
          },
        ],
      }),
      'json',
    )
    editCount++
  }

  {
    const n = targets[0]!
    const spelled = spellEdit(n, `${lines[n - 1]!} // recovered`)
    charge(exactRecovery, spelled.exact, 'json')
    const reaimed = JSON.stringify({
      file_path: path,
      hunks: [{ lines: formatLineAnchor(n, lines[n - 1]!), replace: `${lines[n - 1]!} // recovered` }],
    })
    charge(hashRecovery, reaimed, 'json')
  }
}

const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${(((b - a) / b) * 100).toFixed(1)}%`)

console.log('hashline measure — the same edits in two spellings')
console.log(`corpus: ${fileCount} repo files · ${editCount} edits (3 replaces + 1 insert + 1 range each)`)
console.log('')
console.log('EDIT-CALL OUTPUT (what the model emits):')
console.log(`  exact-string: ${exactEmit.bytes} bytes · ~${exactEmit.tokens} tokens`)
console.log(`  hashline:     ${hashEmit.bytes} bytes · ~${hashEmit.tokens} tokens`)
console.log(`  saved by hashline: ${pct(hashEmit.bytes, exactEmit.bytes)} bytes · ${pct(hashEmit.tokens, exactEmit.tokens)} tokens`)
console.log('')
console.log('READ-SIDE OVERHEAD (charged AGAINST hashline; whole-file reads, compact prefix):')
console.log(`  plain presentation:    ${readPlainBytes} bytes · ~${readPlainTokens} tokens`)
console.log(`  anchored presentation: ${readAnchoredBytes} bytes · ~${readAnchoredTokens} tokens`)
console.log(`  anchor overhead: +${readAnchoredBytes - readPlainBytes} bytes · ~+${readAnchoredTokens - readPlainTokens} tokens (${pct(readPlainBytes, readAnchoredBytes)} of the anchored read)`)
console.log('')
console.log('ONE STALE AIM PER FILE (the recovery re-emit after the refusal):')
console.log(`  exact-string retry: ${exactRecovery.bytes} bytes · ~${exactRecovery.tokens} tokens (plus the re-read it needs first)`)
console.log(`  hashline re-aim:    ${hashRecovery.bytes} bytes · ~${hashRecovery.tokens} tokens (the refusal already carried the fresh anchors)`)
console.log('')
const netHash = hashEmit.tokens + (readAnchoredTokens - readPlainTokens)
console.log('NET (edit output + read overhead, tokens):')
console.log(`  exact-string ~${exactEmit.tokens} vs hashline ~${netHash} — net saving ${pct(netHash, exactEmit.tokens)}`)
console.log('')
console.log(
  JSON.stringify({
    corpusFiles: fileCount,
    edits: editCount,
    exactEmit,
    hashEmit,
    readOverheadBytes: readAnchoredBytes - readPlainBytes,
    readOverheadTokens: readAnchoredTokens - readPlainTokens,
    exactRecovery,
    hashRecovery,
    netHashTokens: netHash,
  }),
)
