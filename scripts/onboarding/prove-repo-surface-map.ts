#!/usr/bin/env bun
// ============================================================================
//  scripts/onboarding/prove-repo-surface-map.ts
//  PROOF: fast onboarding v1 — the auto-derived repo surface map
//  (MERCURY_ONBOARDING; src/utils/cockpit/repoSurfaceMap.ts).
//
//  Locks: detection correctness on synthetic Node + Python repos · null on an
//  empty tree · byte-determinism · the entry CAP (honest 'CAPPED' marker, no
//  hang) · the depth bound · gate semantics (=0 off, bare-stamp off) ·
//  STRUCTURE-ONLY (a planted secret file BODY never reaches the map) · the
//  live wiring (attachment union + registration + formatter + null-render +
//  /orient command registration — the severed-loop class).
//
//  Run: ~/.bun/bin/bun run scripts/onboarding/prove-repo-surface-map.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MACRO stamp BEFORE import (read at call time).
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { buildRepoSurfaceMap, hasOrientationDoc, repoSurfaceMapEnabled } = await import(
  '../../src/utils/cockpit/repoSurfaceMap.ts'
)

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' repo surface map — fast onboarding v1')
console.log('============================================================')

const work = mkdtempSync(join(tmpdir(), 'onboard-proof-'))
try {
  // ── Node fixture ─────────────────────────────────────────────────────────
  section('(1) Node repo detection')
  const node = join(work, 'node-repo')
  mkdirSync(join(node, 'src'), { recursive: true })
  mkdirSync(join(node, 'tests'), { recursive: true })
  mkdirSync(join(node, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(node, 'package.json'), JSON.stringify({
    name: 'acme-widget',
    bin: { widget: './bin/widget.js' },
    scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .' },
  }))
  writeFileSync(join(node, 'README.md'), '# Acme Widget\n\nA fixture.\n')
  writeFileSync(join(node, 'tsconfig.json'), '{}')
  writeFileSync(join(node, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(node, 'src', 'app.ts'), 'const SECRET_BODY_SENTINEL_9a7f = "sk-not-really"\n')
  writeFileSync(join(node, 'tests', 'index.test.ts'), 'test\n')
  writeFileSync(join(node, '.github', 'workflows', 'ci.yml'), 'on: push\n')

  const nodeMap = buildRepoSurfaceMap(node)
  check('map generated', nodeMap !== null)
  const nm = nodeMap ?? ''
  check('README headline surfaced', nm.includes('> Acme Widget'))
  check('package name + bin surfaced', nm.includes('acme-widget') && nm.includes('widget'))
  check('scripts surfaced (names only)', nm.includes('build · test · lint'))
  check('TypeScript detected', /languages.*TypeScript/.test(nm))
  check('stack markers include Node + tsconfig', nm.includes('Node package') && nm.includes('TypeScript config'))
  check('tests counted', /tests.*test files/.test(nm) && nm.includes('tests'))
  check('CI workflows counted', nm.includes('**CI**: 1 GitHub workflow'))
  check('top-level dirs listed', /top-level dirs.*src/.test(nm) && /tests/.test(nm))
  check('STRUCTURE-ONLY: planted file body absent', !nm.includes('SECRET_BODY_SENTINEL_9a7f') && !nm.includes('sk-not-really'))
  check('honest footer (regenerate hint + structure-only claim)', nm.includes('/orient') && nm.includes('Structure only'))

  section('(2) determinism')
  check('two scans byte-identical', buildRepoSurfaceMap(node) === nodeMap)

  // ── Python fixture ───────────────────────────────────────────────────────
  section('(3) Python repo detection')
  const py = join(work, 'py-repo')
  mkdirSync(join(py, 'pkg'), { recursive: true })
  writeFileSync(join(py, 'pyproject.toml'), '[project]\nname = "fixture"\n')
  writeFileSync(join(py, 'pkg', 'main.py'), 'x = 1\n')
  writeFileSync(join(py, 'pkg', 'test_main.py'), 'def test_x(): pass\n')
  const pyMap = buildRepoSurfaceMap(py) ?? ''
  check('Python detected', /languages.*Python/.test(pyMap))
  check('pyproject marker', pyMap.includes('Python project'))
  check('test_*.py counted as tests', /~1 test file/.test(pyMap))

  // ── empty / degenerate ───────────────────────────────────────────────────
  section('(4) empty + missing trees')
  const empty = join(work, 'empty')
  mkdirSync(empty)
  check('empty dir ⇒ null', buildRepoSurfaceMap(empty) === null)
  check('nonexistent path ⇒ null (never throws)', buildRepoSurfaceMap(join(work, 'nope')) === null)

  // ── caps ─────────────────────────────────────────────────────────────────
  section('(5) entry cap + depth bound')
  const big = join(work, 'big')
  mkdirSync(join(big, 'many'), { recursive: true })
  for (let i = 0; i < 4200; i++) writeFileSync(join(big, 'many', `f${String(i).padStart(5, '0')}.ts`), '')
  const t0 = Date.now()
  const bigMap = buildRepoSurfaceMap(big) ?? ''
  const bigMs = Date.now() - t0
  check('capped scan completes fast', bigMs < 5000, `${bigMs}ms`)
  check('CAPPED marker is honest', bigMap.includes('CAPPED at'))

  const deep = join(work, 'deep')
  let d = deep
  for (let i = 0; i < 9; i++) { d = join(d, `lvl${i}`); mkdirSync(d, { recursive: true }) }
  writeFileSync(join(d, 'too-deep.rs'), '')
  writeFileSync(join(deep, 'top.go'), '')
  const deepMap = buildRepoSurfaceMap(deep) ?? ''
  check('file beyond MAX_DEPTH not counted', !/Rust/.test(deepMap) && /Go/.test(deepMap))

  // ── symlinks: the walk must stay INSIDE the
  // root — statSync followed a symlink, so a repo link into $HOME folded a
  // foreign tree's shape (counts/languages) into the map. Sharp oracle: a
  // subdir symlink to an outside tree changes NOTHING.
  section('(5b) symlinks never followed (walk stays inside the root)')
  const linky = join(work, 'linky')
  mkdirSync(join(linky, 'src'), { recursive: true })
  writeFileSync(join(linky, 'src', 'a.ts'), '')
  const outside = join(work, 'outside-tree')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'contract.sol'), '')
  const beforeLink = buildRepoSurfaceMap(linky) ?? ''
  symlinkSync(outside, join(linky, 'src', 'link-out'))
  const afterLink = buildRepoSurfaceMap(linky) ?? ''
  check('map byte-identical with a subdir symlink to an outside tree', afterLink === beforeLink)
  check('outside-tree language never counted', !/Solidity/.test(afterLink))

  // ── gates ────────────────────────────────────────────────────────────────
  // hasOrientationDoc memoizes once-per-process per root (the registry's
  // static-for-process row — the attachment gate runs it every tool round),
  // so each doc kind probes a FRESH root, and the memo grain itself is
  // pinned: a doc landing AFTER the first probe never flips that root's
  // answer within the process.
  section('(6) gate semantics')
  check('hasOrientationDoc: false on fixture', !hasOrientationDoc(node))
  for (const doc of ['CLAUDE.md', 'MERCURY.md', 'AGENTS.md']) {
    const root = join(work, `orient-${doc.toLowerCase().replace(/\W/g, '-')}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, doc), '# guide\n')
    check(`hasOrientationDoc: true on a ${doc} repo`, hasOrientationDoc(root))
  }
  writeFileSync(join(node, 'CLAUDE.md'), '# rules\n')
  check('hasOrientationDoc: memo grain holds — a doc landing after the first probe never flips the mapped root', !hasOrientationDoc(node))
  rmSync(join(node, 'CLAUDE.md'))
  const prev = process.env.MERCURY_ONBOARDING
  delete process.env.MERCURY_ONBOARDING
  check('unset ⇒ ON (default-on)', repoSurfaceMapEnabled() === true)
  process.env.MERCURY_ONBOARDING = '0'
  check("'=0' ⇒ OFF (live re-read)", repoSurfaceMapEnabled() === false)
  if (prev === undefined) delete process.env.MERCURY_ONBOARDING
  else process.env.MERCURY_ONBOARDING = prev
} finally {
  rmSync(work, { recursive: true, force: true })
}

// ── live wiring (the severed-loop class) ──────────────────────────────────
section('(7) live wiring — attachment + command are consumed')
// R3 module-scoped read: the attachments implementation is
// splitting into owned submodules; these invariants are module-scoped, so
// read the barrel + every submodule as one text.
const attachments = readFileSync(join(ROOT, 'src/utils/attachments.ts'), 'utf8') + readdirSync(join(ROOT, 'src/utils/attachments')).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(ROOT, 'src/utils/attachments', f), 'utf8')).join('\n')
// Re-anchored: the Attachment union moved to the owned
// attachments/types.ts submodule (R3); the producer + maybe() registration
// remain barrel-resident until their zone extracts.
const attachmentTypes = readFileSync(join(ROOT, 'src/utils/attachments/types.ts'), 'utf8')
check('attachment union member declared', /type: 'repo_surface_map'\n\s+markdown: string/.test(attachmentTypes))
check('producer gates: enabled + main-thread + interactive + once + no-orientation-doc', /getRepoSurfaceMapAttachment[\s\S]{0,700}repoSurfaceMapEnabled\(\)[\s\S]{0,700}agentId[\s\S]{0,400}getIsNonInteractiveSession\(\)[\s\S]{0,900}hasOrientationDoc/.test(attachments))
check("maybe('repo_surface_map') registered", attachments.includes("maybe('repo_surface_map'"))
const messages = readFileSync(join(ROOT, 'src/utils/messages/attachmentText.ts'), 'utf8')
check('formatter case emits a system-reminder', /case 'repo_surface_map':[\s\S]{0,900}wrapMessagesInSystemReminder/.test(messages))
const nullRender = readFileSync(join(ROOT, 'src/components/messages/nullRenderingAttachments.ts'), 'utf8')
check('null-render registered (no transcript bubble)', nullRender.includes("'repo_surface_map'"))
const commandsTs = readFileSync(join(ROOT, 'src/commands.ts'), 'utf8')
check('/orient registered in the command list', commandsTs.includes("import orient from './commands/orient/index.js'") && /^\s+orient,$/m.test(commandsTs))
const orientIdx = readFileSync(join(ROOT, 'src/commands/orient/index.ts'), 'utf8')
check('/orient isEnabled rides the same gate', orientIdx.includes('repoSurfaceMapEnabled()'))

console.log('='.repeat(60))
console.log(failures === 0 ? ' ALL ONBOARDING PROOFS PASS' : ` ${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
