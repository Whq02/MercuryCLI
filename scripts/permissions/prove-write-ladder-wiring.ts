#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'write-ladder-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'write-ladder-')))
const realCwd = join(scratch, 'real', 'project')
const aliasRoot = join(scratch, 'alias')
const outside = join(scratch, 'outside')
const { mkdirSync } = await import('node:fs')
mkdirSync(realCwd, { recursive: true })
mkdirSync(outside, { recursive: true })
symlinkSync(join(scratch, 'real'), aliasRoot)
const aliasCwd = join(aliasRoot, 'project')
writeFileSync(join(outside, 'secret.txt'), 'outside\n')
symlinkSync(join(outside, 'secret.txt'), join(realCwd, 'escape.txt'))
process.chdir(realCwd)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


section('§2 behaviour — the REAL Write tool under the ladder, by real targets')
const { WriteTool } = await import('../../src/tools/write/WriteTool.ts')
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
  (await WriteTool.checkPermissions({ file_path, content: 'x\n' } as never, ctxFor(mode))) as {
    behavior: string
    decisionReason?: { type?: string; mode?: string }
  }

const viaReal = await decide('implement', join(realCwd, 'new.txt'))
check('implement: a new file under the real cwd spelling is ALLOWED by the mode fast path', viaReal.behavior === 'allow' && viaReal.decisionReason?.type === 'mode' && viaReal.decisionReason?.mode === 'implement', JSON.stringify(viaReal) + ' (check the implement-mode fast path in checkWritePermissionForTool, src/permissions/rules/filesystem.ts)')
const viaAlias = await decide('implement', join(aliasCwd, 'new.txt'))
check('implement: the SAME file spelled through a symlinked ancestor is ALLOWED (real target decides)', viaAlias.behavior === 'allow' && viaAlias.decisionReason?.type === 'mode', JSON.stringify(viaAlias) + ' (the path must be resolved to its real target before the fast path decides, in checkWritePermissionForTool, src/permissions/rules/filesystem.ts)')
const escape = await decide('implement', join(realCwd, 'escape.txt'))
check('implement: a link inside the tree pointing OUT is NOT allowed by the fast path', escape.behavior !== 'allow', JSON.stringify(escape) + ' (a link pointing out of the tree must not take the fast path in checkWritePermissionForTool, src/permissions/rules/filesystem.ts)')
const away = await decide('implement', join(outside, 'new.txt'))
check('implement: a path outside the tree is NOT allowed by the fast path', away.behavior !== 'allow', JSON.stringify(away) + ' (a path outside the working tree must not take the fast path in checkWritePermissionForTool, src/permissions/rules/filesystem.ts)')
const plain = await decide('default', join(realCwd, 'new.txt'))
check('default mode: the same in-tree write ASKS (the ladder reached its tail)', plain.behavior === 'ask', JSON.stringify(plain) + ' (default mode must fall through to ask in checkWritePermissionForTool, src/permissions/rules/filesystem.ts)')

rmSync(scratch, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} WRITE-LADDER WIRING PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ WRITE LADDER WIRING PROOF PASSES')
