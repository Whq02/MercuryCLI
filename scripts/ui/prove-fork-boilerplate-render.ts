#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' fork-boilerplate render leg — dispatch + collapse contract')
console.log('============================================================')

const userText = src('components', 'messages', 'UserTextMessage.tsx')
check(
  'UserTextMessage dispatches `<fork-boilerplate>` text to UserForkBoilerplateMessage',
  /param\.text\.includes\(`<\$\{FORK_BOILERPLATE_TAG\}>`\)/.test(userText) &&
    /<UserForkBoilerplateMessage addMargin=\{addMargin\} param=\{param\} \/>/.test(userText),
)
check(
  'the dispatch import is STATIC',
  /import \{ UserForkBoilerplateMessage \} from '\.\/UserForkBoilerplateMessage\.js'/.test(userText),
)
const comp = src('components', 'messages', 'UserForkBoilerplateMessage.tsx')
check(
  'the renderer leads with the directive (FORK_DIRECTIVE_PREFIX stripped)',
  /FORK_DIRECTIVE_PREFIX/.test(comp) && /fork directive:/.test(comp),
)
check(
  'the rules wall collapses to a dim one-liner (never raw XML)',
  /boilerplate collapsed/.test(comp) && /dimColor/.test(comp),
)
check(
  'glyphs come from the shared constants (no new literals)',
  /BULLET_OPERATOR/.test(comp) && /OUTPUT_CONNECTOR/.test(comp),
)

const distPath = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(distPath)) {
  console.log('  [SKIP] dist/mercury.mjs absent — run `bun run build.ts` for the dist needle')
} else {
  check(
    'dist carries the renderer (literal needle `boilerplate collapsed`)',
    readFileSync(distPath, 'utf-8').includes('boilerplate collapsed'),
  )
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ FORK-BOILERPLATE RENDER PROOFS PASS')
else console.log(`❌ ${failures} FORK-BOILERPLATE PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
