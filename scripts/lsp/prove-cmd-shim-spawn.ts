#!/usr/bin/env bun
// prove-cmd-shim-spawn — npm-installed language servers can spawn on win32
// (field card FC-051). An npm-style pyright-langserver.cmd threw EINVAL by
// resolved path and ENOENT by bare name (the runtime refuses batch files
// shell-less) while the remedy Mercury prints is `npm i -g pyright`. The
// spawn now rides shell:true for exactly the batch-shim SHAPE (.cmd/.bat on
// win32); every other command keeps the direct spawn. Live win32 leg is
// field-owed; these pins are call-shaped and comment-blind.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const client = readFileSync(join(import.meta.dir, '../../src/services/lsp/LSPClient.ts'), 'utf8')
check(
  'the batch-shim shape is detected (win32 + .cmd/.bat)',
  client.includes("process.platform === 'win32' && /\\.(cmd|bat)$/i.test(command.trim())"),
)
check(
  'and exactly that shape rides shell:true at the spawn',
  /\.\.\.\(isWindowsBatchShim \? \{ shell: true \} : \{\}\)/.test(client),
)
check(
  'the direct spawn stays for everything else (no blanket shell)',
  !/shell: true,\n/.test(client),
)

if (failures > 0) {
  console.error(`\nprove-cmd-shim-spawn: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cmd-shim-spawn: all green')
