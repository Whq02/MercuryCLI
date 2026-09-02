#!/usr/bin/env bun
// prove-instruction-imports-scope — two instruction-discovery defects
// (field cards FC-030 · FC-031).
//
// FC-030: the @import approval boundary was computed against the BOOT CWD
//   alone, so a parent MERCURY.md discovered above the cwd had every import
//   dropped as "external" — including one naming a file in the very
//   directory that holds the importing file. The importing file's own
//   directory now counts as an instruction root for its imports.
// FC-031: instructionExcludes matched case-sensitively on win32 — a pattern
//   naming the same file with a lowercase drive letter excluded nothing.
//   The match options now carry nocase on windows (platform-parameterised,
//   provable off-box).
//
//   §1 FC-030 behavioral: a parent file's sibling import composes from a
//      subdirectory cwd.
//   §2 FC-031: the exclude matcher is platform-parameterised and folds case
//      exactly on windows.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'imports-scope-home-')))
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'imports-scope-root-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// root/MERCURY.md imports ./shared.md; the session boots in root/pkg.
writeFileSync(join(ROOT, 'MERCURY.md'), 'Root rules.\n\n@./shared.md\n')
writeFileSync(join(ROOT, 'shared.md'), 'THE-SHARED-SENTENCE lives here.\n')
mkdirSync(join(ROOT, 'pkg'), { recursive: true })
process.chdir(join(ROOT, 'pkg'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const discovery = await import('../../src/services/instructions/discovery.ts')

section('§1 FC-030 — a parent file imports its own sibling')
{
  const { processInstructionFile } = discovery as unknown as {
    processInstructionFile: (
      convention: { isExcluded: (p: string, t: string) => boolean },
      filePath: string,
      type: string,
      processedPaths: Set<string>,
      includeExternal: boolean,
      depth?: number,
      parent?: string,
      diagnostics?: Array<{ kind: string; path: string }>,
    ) => Promise<Array<{ content: string; path?: string }>>
  }
  const convention = { isExcluded: () => false }
  const diagnostics: Array<{ kind: string; path: string }> = []
  const entries = await processInstructionFile(
    convention as never,
    join(ROOT, 'MERCURY.md'),
    'project' as never,
    new Set<string>(),
    false,
    0,
    undefined,
    diagnostics as never,
  )
  const flat = JSON.stringify(entries)
  check('the parent file itself composes', flat.includes('Root rules'), flat.slice(0, 120))
  check(
    "its OWN-DIRECTORY sibling import composes from a subdirectory cwd (FC-030)",
    flat.includes('THE-SHARED-SENTENCE'),
    JSON.stringify(diagnostics),
  )
  check(
    'no external-import-blocked diagnostic fires for the sibling',
    !diagnostics.some(d => d.kind === 'external-import-blocked'),
    JSON.stringify(diagnostics),
  )
  // Control: a genuinely external import (outside both roots and the
  // importing file's directory) STAYS blocked.
  const strangerDir = realpathSync(mkdtempSync(join(tmpdir(), 'imports-scope-stranger-')))
  writeFileSync(join(strangerDir, 'outside.md'), 'OUTSIDE-SENTENCE\n')
  writeFileSync(join(ROOT, 'MERCURY2.md'), `Second file.\n\n@${join(strangerDir, 'outside.md')}\n`)
  const diag2: Array<{ kind: string; path: string }> = []
  const entries2 = await processInstructionFile(
    convention as never,
    join(ROOT, 'MERCURY2.md'),
    'project' as never,
    new Set<string>(),
    false,
    0,
    undefined,
    diag2 as never,
  )
  check(
    'control: a genuinely external import stays blocked',
    !JSON.stringify(entries2).includes('OUTSIDE-SENTENCE') && diag2.some(d => d.kind === 'external-import-blocked'),
    JSON.stringify(diag2),
  )
  rmSync(strangerDir, { recursive: true, force: true })
}

section('§2 FC-031 — the exclude matcher folds case on windows')
{
  const { readFileSync } = await import('node:fs')
  const srcText = readFileSync(join(import.meta.dir, '../../src/services/instructions/discovery.ts'), 'utf8')
  check(
    'matchOpts carries nocase keyed on windows (call-shaped)',
    /nocase:\s*[^,}]*win32|nocase:\s*isWin/i.test(srcText),
    srcText.match(/matchOpts[^\n]*/)?.[0],
  )
}

section('§3 FN-015 rank 44 — an @import spelled with Windows separators composes, or says why not')
{
  // The include scanner's capture class excluded the backslash, so each
  // token stopped at the first separator: @docs\style.md resolved to the
  // docs DIRECTORY, which exists — passing the missing-target diagnostic —
  // and then raised EISDIR in the reader, where the ordinary probe class
  // swallowed it. The operator believed the imported rules were in force;
  // they were not, and no surface said so. Two halves: the token accepts a
  // backslash followed by a non-space character (the escaped-space spelling
  // is untouched), and a resolved include that is a directory raises its
  // own diagnostic instead of the swallowed EISDIR.
  const { parseInstructionFileContent } = await import('../../src/services/instructions/sourceText.ts')
  // includeBasePath is the IMPORTING FILE (the engine resolves against its
  // dirname), exactly as the discovery walk passes it.
  const base = join(ROOT, 'MERCURY.md')
  const parsed = parseInstructionFileContent(
    'Rules.\n\n@docs\\style.md\n@.\\docs\\other.md\n@C:\\shared\\rules.md\n@notes\\ with\\ space.md\n@./posix.md\n',
    base,
    'project' as never,
    base,
  )
  const tokens = parsed.includePaths.map(p => p.slice(ROOT.length + 1))
  check(
    'a backslash inside the token is a separator, not a terminator (@docs\\style.md keeps its file name)',
    tokens.includes('docs\\style.md') && !tokens.includes('docs'),
    JSON.stringify(tokens),
  )
  check('the .\\ relative spelling keeps its file name too', tokens.includes('.\\docs\\other.md') || tokens.includes('docs\\other.md'), JSON.stringify(tokens))
  check('a drive-qualified spelling stays whole', parsed.includePaths.some(p => p.endsWith('C:\\shared\\rules.md')), JSON.stringify(parsed.includePaths))
  check('an escaped space still reads as a space', tokens.includes('notes with space.md'), JSON.stringify(tokens))
  check('the POSIX spelling is unchanged', tokens.includes('posix.md'), JSON.stringify(tokens))

  // The directory diagnostic: an include that resolves to a directory.
  mkdirSync(join(ROOT, 'docs'), { recursive: true })
  writeFileSync(join(ROOT, 'MERCURY3.md'), 'Third file.\n\n@./docs\n')
  const diag3: Array<{ kind: string; path: string; detail?: string }> = []
  const { processInstructionFile } = discovery as unknown as {
    processInstructionFile: (
      convention: { isExcluded: (p: string, t: string) => boolean },
      filePath: string,
      type: string,
      processedPaths: Set<string>,
      includeExternal: boolean,
      depth?: number,
      parent?: string,
      diagnostics?: Array<{ kind: string; path: string; detail?: string }>,
    ) => Promise<Array<{ content: string; path?: string }>>
  }
  const entries3 = await processInstructionFile(
    { isExcluded: () => false },
    join(ROOT, 'MERCURY3.md'),
    'project',
    new Set<string>(),
    false,
    0,
    undefined,
    diag3,
  )
  check('the importing file itself still composes', JSON.stringify(entries3).includes('Third file'))
  check(
    'an @import that resolves to a DIRECTORY raises its own diagnostic (never a swallowed EISDIR)',
    diag3.some(d => d.kind === 'import-target-is-directory' && d.path === join(ROOT, 'docs')),
    JSON.stringify(diag3),
  )
  check('…and is not reported as missing (it exists)', !diag3.some(d => d.kind === 'missing-import-target'), JSON.stringify(diag3))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(ROOT, { recursive: true, force: true })

// ── §FC-100: a wrong-TYPE import target is NAMED, never silent ──────────────
{
  const { processInstructionFile } = discovery as unknown as {
    processInstructionFile: (
      convention: { isExcluded: (p: string, t: string) => boolean },
      filePath: string,
      type: string,
      processedPaths: Set<string>,
      includeExternal: boolean,
      depth?: number,
      parent?: string,
      diagnostics?: Array<{ kind: string; path: string; detail?: string }>,
    ) => Promise<Array<{ content: string }>>
  }
  const { mkdtempSync: mkD, writeFileSync: wF, realpathSync: rP } = await import('node:fs')
  const { tmpdir: tD } = await import('node:os')
  const dir = rP(mkD(join(tD(), 'fc100-')))
  wF(join(dir, 'MERCURY.md'), 'Rules.\n\n@./style.rtf\n@./missing.md\n@./good.md\n')
  wF(join(dir, 'style.rtf'), '{rtf1 not composable}')
  wF(join(dir, 'good.md'), 'Good import.\n')
  const diagnostics: Array<{ kind: string; path: string; detail?: string }> = []
  const entries = await processInstructionFile(
    { isExcluded: () => false } as never,
    join(dir, 'MERCURY.md'),
    'project' as never,
    new Set<string>(),
    false,
    0,
    undefined,
    diagnostics as never,
  )
  const flat = JSON.stringify(entries)
  check('FC-100: the good .md import composes', flat.includes('Good import'))
  check('FC-100: the wrong-type target composes NOTHING', !flat.includes('rtf1'))
  check(
    'FC-100: … and is NAMED (unsupported-import-type with the extension in the detail)',
    diagnostics.some(d => d.kind === 'unsupported-import-type' && d.path.endsWith('style.rtf') && String(d.detail).includes('.rtf')),
    JSON.stringify(diagnostics),
  )
  check(
    'FC-100: the typo path still reports missing-import-target beside it',
    diagnostics.some(d => d.kind === 'missing-import-target' && d.path.endsWith('missing.md')),
  )
}

// ── §FC-101: the local convention is SYMMETRIC with the project one ─────────
{
  const { mercuryNativeConvention } = await import('../../src/services/instructions/adapters/mercuryNative.ts')
  const dir = '/proj'
  const projectFiles = mercuryNativeConvention.projectDirFiles(dir)
  const localFiles = (mercuryNativeConvention as { localDirFiles?: (d: string) => string[] }).localDirFiles?.(dir) ?? []
  check(
    'FC-101: every home that offers MERCURY.md offers MERCURY.local.md',
    localFiles.length === projectFiles.length &&
      projectFiles.every(p => localFiles.includes(p.replace(/MERCURY\.md$/, 'MERCURY.local.md'))),
    JSON.stringify({ projectFiles, localFiles }),
  )
  const { readFileSync: readEngineSrc } = await import('node:fs')
  const engineSrc = readEngineSrc(join(import.meta.dir, '..', '..', 'src', 'services', 'instructions', 'engine.ts'), 'utf8')
  check(
    'FC-101: BOTH engine walks consume the plural candidates',
    (engineSrc.match(/convention\.localDirFiles\?\.\(dir\)/g) ?? []).length === 2,
  )
}

if (failures > 0) {
  console.error(`\nprove-instruction-imports-scope: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-instruction-imports-scope: all green')
