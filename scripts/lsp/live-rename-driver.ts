#!/usr/bin/env bun
// live-rename-driver — the REAL-boot rename fan-out: the production LSP
// manager boots the REAL mercury-ts sidecar (packaged compiler) on a scratch
// TS project, pathRename moves a module that TWO files import, and the
// import edits land on disk through the one apply transaction. RUN_LIVE=1
// keeps it explicit (host-dependent timing); never gate-joined — the
// deterministic fan-out proof is prove-lsp-rename-fanout.ts.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

if (process.env.RUN_LIVE !== '1') {
  console.log('live-rename-driver: real-sidecar rename smoke — set RUN_LIVE=1 to run (never gate-joined).')
  process.exit(0)
}

const repo = path.resolve(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'live-rename-')))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'live-rename-home-'))
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(path.join(tmpdir(), 'live-rename-cs-'))
process.env.MERCURY_LSP_SIDECAR_ENTRY = path.join(repo, 'src/services/lsp/tsSidecar/entry.ts')
delete process.env.MERCURY_LSP
process.chdir(scratch)

// The scratch project: two importers of one module — the fan-out payload.
writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'live-rename-scratch', type: 'module' }))
writeFileSync(path.join(scratch, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler' } }))
writeFileSync(path.join(scratch, 'helper.ts'), 'export const helper = (n: number): number => n * 2\n')
writeFileSync(path.join(scratch, 'main.ts'), "import { helper } from './helper'\nconsole.log(helper(21))\n")
writeFileSync(path.join(scratch, 'extra.ts'), "import { helper } from './helper'\nexport const double = helper\n")

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) fail = 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const mgrModule = await import('../../src/services/lsp/manager.js')
mgrModule.initializeLspServerManager()
await mgrModule.waitForInitialization()
check('the REAL manager initialised', mgrModule.getInitializationStatus().status === 'success', JSON.stringify(mgrModule.getInitializationStatus()))
const manager = mgrModule.getLspServerManager()!
check('the real mercury-ts sidecar is registered', [...manager.getAllServers().keys()].includes('mercury-ts'))

// Warm the sidecar with the project files (real didOpen traffic).
for (const f of ['helper.ts', 'main.ts', 'extra.ts']) {
  const p = path.join(scratch, f)
  await manager.openFile(p, readFileSync(p, 'utf8'))
}

const { runMercuryLspOp } = await import('../../src/tools/LSPTool/mercuryOps.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const permCtx = {
  ...getEmptyToolPermissionContext(),
  additionalWorkingDirectories: new Map([[scratch, { source: 'session' }]]),
}
const ctx = {
  readFileState: new Map(),
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: permCtx }),
} as never

const oldPath = path.join(scratch, 'helper.ts')
const newPath = path.join(scratch, 'lib', 'helper.ts')
const r = await runMercuryLspOp({
  input: { operation: 'pathRename', filePath: oldPath, newPath, apply: true } as never,
  absolutePath: oldPath,
  cwd: scratch,
  manager,
  tool: { name: 'LSP', getPath: (i: { filePath?: string } | undefined) => i?.filePath } as never,
  context: ctx,
})

console.log('\n===== REAL RENAME TRANSCRIPT =====')
console.log(r.result)
console.log('==================================\n')

check('the move applied', r.effect.outcome === 'succeeded', r.effect.evidence)
check('the module landed at lib/helper.ts', !existsSync(oldPath) && existsSync(newPath))
const main = readFileSync(path.join(scratch, 'main.ts'), 'utf8')
const extra = readFileSync(path.join(scratch, 'extra.ts'), 'utf8')
console.log('main.ts after:  ' + JSON.stringify(main))
console.log('extra.ts after: ' + JSON.stringify(extra))
check('main.ts import updated by the REAL sidecar', main.includes("./lib/helper"), main)
check('extra.ts import updated by the REAL sidecar', extra.includes("./lib/helper"), extra)

await mgrModule.shutdownLspServerManager()
console.log('')
if (fail) {
  console.log('live-rename-driver: RED')
  process.exit(1)
}
console.log('live-rename-driver: GREEN — a real sidecar computed real import edits through the one transaction')
