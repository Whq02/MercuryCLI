#!/usr/bin/env bun
// ============================================================================
//  prove-mention-vs-import — prose @mentions are not @imports (FC-110).
//
//  The include capture consumes to the next whitespace, so a MERCURY.md
//  sentence like "Lint with @typescript-eslint. Ask @alice before merging."
//  produced two fabricated import paths — sentence punctuation swallowed
//  into the first — and the doctor's instruction profile flipped to warn
//  with missing-import targets that were never imports at all.
//
//  §1 the pure parse: prose mentions come back as BARE MENTIONS, not
//     imports; trailing sentence punctuation is stripped from real
//     imports; fragments and escaped spaces keep working.
//  §2 the driven walk: a prose-mention file raises NO missing-import
//     diagnostic; a bare mention that names a REAL file still composes
//     (scope preserved); a genuinely missing path-evidence import still
//     warns (the real diagnostic survives).
//
//  Run: ~/.bun/bin/bun run scripts/settings/prove-mention-vs-import.ts
// ============================================================================
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mention-home-')))
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'mention-root-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { parseInstructionFileContent } = await import('../../src/services/instructions/sourceText.ts')

section('§1 THE PURE PARSE')
{
  const at = (content: string): { includePaths: string[]; bareMentionPaths: string[] } => {
    const parsed = parseInstructionFileContent(
      content,
      join(ROOT, 'MERCURY.md'),
      'Project' as never,
      join(ROOT, 'MERCURY.md'),
    ) as unknown as { includePaths: string[]; bareMentionPaths?: string[] }
    // Base-tolerant: the pre-fix shape has no bareMentionPaths.
    return { includePaths: parsed.includePaths, bareMentionPaths: parsed.bareMentionPaths ?? [] }
  }

  const prose = at('Lint with @typescript-eslint. Ask @alice before merging.\n')
  check(
    "the card's own sentence yields ZERO imports",
    prose.includePaths.length === 0,
    prose.includePaths.join(', '),
  )
  check(
    'both prose mentions come back as bare mentions (for the io layer to gate)',
    prose.bareMentionPaths.length === 2 &&
      prose.bareMentionPaths.some(p => p.endsWith('typescript-eslint')) &&
      prose.bareMentionPaths.some(p => p.endsWith('alice')),
    prose.bareMentionPaths.join(', '),
  )

  const punctuated = at('See @docs/setup.md. Then read @notes.md#usage, twice.\n')
  check(
    'trailing sentence punctuation is stripped from a real import',
    punctuated.includePaths.some(p => p.endsWith(join('docs', 'setup.md'))) &&
      !punctuated.includePaths.some(p => p.endsWith('.md.')),
    punctuated.includePaths.join(', '),
  )
  check(
    'a #fragment import keeps working and sheds the trailing comma',
    punctuated.includePaths.some(p => p.endsWith('notes.md')),
    punctuated.includePaths.join(', '),
  )

  const escaped = at('@./with\\ space.txt\n')
  check(
    'escaped spaces keep working',
    escaped.includePaths.some(p => p.endsWith('with space.txt')),
    escaped.includePaths.join(', '),
  )
}

section('§2 THE DRIVEN WALK')
{
  const { processInstructionFile } = (await import(
    '../../src/services/instructions/discovery.ts'
  )) as unknown as {
    processInstructionFile: (
      convention: { isExcluded: (p: string, t: string) => boolean },
      filePath: string,
      type: string,
      processedPaths: Set<string>,
      includeExternal: boolean,
      depth?: number,
      parent?: string,
      diagnostics?: Array<{ kind: string; path: string }>,
    ) => Promise<Array<{ content: string }>>
  }
  const convention = { isExcluded: () => false }
  const walk = async (
    dir: string,
  ): Promise<{ entries: Array<{ content: string }>; diagnostics: Array<{ kind: string; path: string }> }> => {
    const diagnostics: Array<{ kind: string; path: string }> = []
    const entries = await processInstructionFile(
      convention,
      join(dir, 'MERCURY.md'),
      'Project',
      new Set(),
      false,
      0,
      undefined,
      diagnostics,
    )
    return { entries, diagnostics }
  }

  const proseDir = join(ROOT, 'prose')
  mkdirSync(proseDir, { recursive: true })
  writeFileSync(
    join(proseDir, 'MERCURY.md'),
    'Lint with @typescript-eslint. Ask @alice before merging.\n',
  )
  const proseWalk = await walk(proseDir)
  check(
    'a prose-mention file raises NO missing-import diagnostic',
    proseWalk.diagnostics.filter(d => d.kind === 'missing-import-target').length === 0,
    proseWalk.diagnostics.map(d => `${d.kind}:${d.path}`).join(', '),
  )
  check('the file itself still composes', proseWalk.entries.length === 1)

  const bareDir = join(ROOT, 'bare')
  mkdirSync(bareDir, { recursive: true })
  writeFileSync(join(bareDir, 'MERCURY.md'), 'Rules.\n\n@Buildnotes\n')
  writeFileSync(join(bareDir, 'Buildnotes'), 'BARE-IMPORT-BODY\n')
  const bareWalk = await walk(bareDir)
  check(
    'a bare mention naming a REAL file still composes (scope preserved)',
    bareWalk.entries.some(e => e.content.includes('BARE-IMPORT-BODY')),
    `${bareWalk.entries.length} entries`,
  )

  const goneDir = join(ROOT, 'gone')
  mkdirSync(goneDir, { recursive: true })
  writeFileSync(join(goneDir, 'MERCURY.md'), 'Rules.\n\n@./gone.md\n')
  const goneWalk = await walk(goneDir)
  check(
    'a genuinely missing path-evidence import still warns',
    goneWalk.diagnostics.some(d => d.kind === 'missing-import-target' && d.path.endsWith('gone.md')),
    goneWalk.diagnostics.map(d => d.kind).join(', '),
  )
}

console.log(failures === 0 ? '\nprove-mention-vs-import: all green' : `\nprove-mention-vs-import: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
