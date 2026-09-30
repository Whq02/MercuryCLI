#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/pathValidation.ts src/utils/permissions/filesystem.ts src/bootstrap/state.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'write-permission-words-')))
const project = join(scratch, 'project')
const outside = join(scratch, 'outside')
const home = join(scratch, 'home')
for (const dir of [project, outside, home]) mkdirSync(dir)
process.env.MERCURY_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(project)
const { checkPathConstraints } = await import('../../src/tools/BashTool/pathValidation.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
try {
  const ctx = getEmptyToolPermissionContext()
  for (const [place, target] of [['inside', project], ['outside', outside]]) {
    const result = checkPathConstraints({ command: `mkdir ${join(target!, 'new')}` }, project, ctx)
    const words = 'message' in result ? result.message : ''
    check(`${place}: ordinary permission ask, not a folder refusal`, result.behavior === 'ask' && /approval/.test(words) && !/may only|grants reads only|ADDED/.test(words), words)
    check(`${place}: approval is actionable`, /permission card/.test(words))
    check(`${place}: no added-directory grant is suggested`, !JSON.stringify(result).includes('addDirectories'))
    if (place === 'outside') check('outside names the single starting folder', words.includes('starting folder') && words.includes(project))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`write-permission-words: ${failures === 0 ? 'GREEN' : `${failures} failed`}`)
process.exit(failures ? 1 : 0)
