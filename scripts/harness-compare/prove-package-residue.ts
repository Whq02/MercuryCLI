import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)

let failures = 0
function ok(name: string, pass: boolean, detail = ''): void {
  console.log((pass ? '  ok  ' : '  FAIL ') + name + (detail && !pass ? ' — ' + detail : ''))
  if (!pass) failures = 1
}

const bundlePath = join(repoRoot, 'dist/mercury.mjs')
if (!existsSync(bundlePath)) {
  console.error('prove-package-residue: dist/mercury.mjs absent — build first (gate Phase-0 provides it)')
  process.exit(1)
}
const bundle = readFileSync(bundlePath, 'utf8')

const FORBIDDEN = [
  ['glassbird', 'benchmark machinery name'],
  ['Glassbird', 'benchmark machinery name (cased)'],
  ['cs-lab-anthropic', 'comparison-set id'],
  ['recovery-observation-2026', 'observation envelope name'],
  ['hc1-21ff039a', 'corpus digest'],
  ['stream-fault-recovery.json', 'campaign record'],
  ['adapter-journeys-2026', 'journey record'],
] as const

for (const [needle, label] of FORBIDDEN) {
  ok('bundle carries no ' + label + ' (' + needle + ')', !bundle.includes(needle))
}

ok("bundle never constructs a glassbird overlay path", !/['"`\/]glassbird['"`\/]/.test(bundle))

ok('the stream-fault repair IS in the bundle', bundle.includes('stream fault after partial content'))
ok('the continuation nudge IS in the bundle', bundle.includes('stream dropped mid-response'))

if (failures) {
  console.error('prove-package-residue: RED')
  process.exit(1)
}
console.log('prove-package-residue: green')
