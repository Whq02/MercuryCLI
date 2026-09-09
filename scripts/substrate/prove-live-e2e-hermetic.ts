import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const SCRIPTS = join(import.meta.dir, '..')
const liveScripts: string[] = []
function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/^live-.*\.ts$/.test(name)) liveScripts.push(p)
  }
}
walk(SCRIPTS)

check('live-E2E scripts discovered', liveScripts.length > 0, `${liveScripts.length} found`)
for (const p of liveScripts) {
  const body = readFileSync(p, 'utf8')
  const hermetic =
    body.includes('MERCURY_HOME') ||
    body.includes('MERCURY_CONFIG_DIR') ||
    body.includes('renderScenarios')
  check(`hermetic home: ${p.slice(SCRIPTS.length + 1)}`, hermetic,
    hermetic ? '' : 'pins neither a config home nor scenario() — it would write the REAL operator home')
}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} LIVE-E2E HERMETICITY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL LIVE-E2E SCRIPTS ARE HERMETIC')
