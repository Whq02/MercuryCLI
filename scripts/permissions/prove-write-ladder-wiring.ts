#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-write-ladder-wiring.ts — PROOF: every file
//  mutation tool routes its permission verdict through the ONE write ladder
//  (checkWritePermissionForTool: deny/ask rules → path safety → the
//  implement fast path → allow rules → ask), and the ladder judges a path by
//  its REAL targets:
//    §1 source — Write, Edit and NotebookEdit each hand the ladder their
//       name + path accessor from checkPermissions (a tool without the hook
//       falls to the engine's passthrough → ask: implement mode would prompt
//       on every edit, headless -p would refuse every Write, and the
//       sensitive-path safety asks would never fire for the two most common
//       tools);
//    §2 behaviour (hermetic home, the REAL Write tool) — implement mode
//       allows a NEW file under the cwd whether spelled through the cwd's
//       real path or through a symlinked ancestor (the macOS /var →
//       /private/var class); a link inside the tree that points OUT stays
//       refused; a path outside the tree stays refused; default mode asks.
//
//  Run: ~/.bun/bin/bun run scripts/permissions/prove-write-ladder-wiring.ts
// ============================================================================
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'write-ladder-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
// Two spellings of one working directory: the real path and an alias that
// reaches it through a symlinked ancestor (built explicitly so the proof
// holds on a platform whose tmpdir is not itself a symlink).
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'write-ladder-')))
const realCwd = join(scratch, 'real', 'project')
const aliasRoot = join(scratch, 'alias')
const outside = join(scratch, 'outside')
const { mkdirSync } = await import('node:fs')
mkdirSync(realCwd, { recursive: true })
mkdirSync(outside, { recursive: true })
symlinkSync(join(scratch, 'real'), aliasRoot)
const aliasCwd = join(aliasRoot, 'project')
// The escape: a link INSIDE the tree pointing OUT of it.
writeFileSync(join(outside, 'secret.txt'), 'outside\n')
symlinkSync(join(outside, 'secret.txt'), join(realCwd, 'escape.txt'))
process.chdir(realCwd)

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§1 source — the three mutation tools hand the ladder their name + path accessor')
for (const [file, name] of [
  ['src/tools/FileWriteTool/FileWriteTool.ts', 'FILE_WRITE_TOOL_NAME'],
  ['src/tools/FileEditTool/FileEditTool.ts', 'FILE_EDIT_TOOL_NAME'],
  ['src/tools/NotebookEditTool/NotebookEditTool.ts', 'NOTEBOOK_EDIT_TOOL_NAME'],
] as const) {
  const src = readFileSync(join(REPO, file), 'utf8')
  const hook = src.slice(src.indexOf('async checkPermissions('))
  check(
    `${file}: checkPermissions routes through checkWritePermissionForTool with its own name`,
    src.includes('async checkPermissions(') &&
      /checkWritePermissionForTool\(\s*\{\s*name: [A-Z_]+_TOOL_NAME/.test(hook) &&
      hook.includes(`name: ${name}`),
  )
}

section('§2 behaviour — the REAL Write tool under the ladder, by real targets')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const ctxFor = (mode: string) =>
  ({
    getAppState: () => ({
      toolPermissionContext: {
        mode,
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      },
    }),
  }) as never
const decide = async (mode: string, file_path: string) =>
  (await FileWriteTool.checkPermissions({ file_path, content: 'x\n' } as never, ctxFor(mode))) as {
    behavior: string
    decisionReason?: { type?: string; mode?: string }
  }

const viaReal = await decide('implement', join(realCwd, 'new.txt'))
check('implement: a new file under the real cwd spelling is ALLOWED by the mode fast path', viaReal.behavior === 'allow' && viaReal.decisionReason?.type === 'mode' && viaReal.decisionReason?.mode === 'implement', JSON.stringify(viaReal))
const viaAlias = await decide('implement', join(aliasCwd, 'new.txt'))
check('implement: the SAME file spelled through a symlinked ancestor is ALLOWED (real target decides)', viaAlias.behavior === 'allow' && viaAlias.decisionReason?.type === 'mode', JSON.stringify(viaAlias))
const escape = await decide('implement', join(realCwd, 'escape.txt'))
check('implement: a link inside the tree pointing OUT is NOT allowed by the fast path', escape.behavior !== 'allow', JSON.stringify(escape))
const away = await decide('implement', join(outside, 'new.txt'))
check('implement: a path outside the tree is NOT allowed by the fast path', away.behavior !== 'allow', JSON.stringify(away))
const plain = await decide('default', join(realCwd, 'new.txt'))
check('default mode: the same in-tree write ASKS (the ladder reached its tail)', plain.behavior === 'ask', JSON.stringify(plain))

rmSync(scratch, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} WRITE-LADDER WIRING PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ WRITE LADDER WIRING PROOF PASSES')
