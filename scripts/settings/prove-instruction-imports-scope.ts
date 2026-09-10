#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'imports-scope-home-')))
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'imports-scope-root-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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
  const { parseInstructionFileContent } = await import('../../src/services/instructions/sourceText.ts')
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

{
  const { mercuryNativeConvention } = await import('../../src/services/instructions/adapters/mercuryNative.ts')
  const dir = '/proj'
  const projectFiles = mercuryNativeConvention.projectDirFiles(dir)
  const localFiles = (mercuryNativeConvention as { localDirFiles?: (d: string) => string[] }).localDirFiles?.(dir) ?? []
  check(
    'FC-101: the project roster is the NON-EMPTY canonical pair (root MERCURY.md and .mercury/MERCURY.md)',
    JSON.stringify(projectFiles) === JSON.stringify(['/proj/MERCURY.md', '/proj/.mercury/MERCURY.md']),
    JSON.stringify(projectFiles),
  )
  check(
    'FC-101: the local roster is the NON-EMPTY canonical pair beside it',
    JSON.stringify(localFiles) === JSON.stringify(['/proj/MERCURY.local.md', '/proj/.mercury/MERCURY.local.md']),
    JSON.stringify(localFiles),
  )
  check(
    'FC-101: every home that offers MERCURY.md offers MERCURY.local.md',
    projectFiles.length > 0 &&
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
