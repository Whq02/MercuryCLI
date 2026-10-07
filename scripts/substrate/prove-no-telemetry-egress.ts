import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { binaryName } from '../../src/utils/config.js'

const ROOT = process.cwd()
let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) fail = 1
}
function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const files = walk(join(ROOT, 'src'), [])
const carriers = (re: RegExp): string => files.filter(p => re.test(readFileSync(p, 'utf8'))).map(p => p.slice(ROOT.length + 1)).join(', ')

console.log(' no telemetry egress — nothing in the tree collects, converts or gates')
check('no analytics module exists', !existsSync(join(ROOT, 'src/services/analytics')))
check('no source imports an analytics module', carriers(/services\/analytics/) === '', carriers(/services\/analytics/))
check('no compiler-runtime shim exists', !existsSync(join(ROOT, 'src/types/react-compiler-runtime.d.ts')))
check('no decompile script exists', !existsSync(join(ROOT, 'scripts/codemod')))
check('no source carries a memo-cache call or the compiler-runtime import', carriers(/\b_c\(|react\/compiler-runtime/) === '', carriers(/\b_c\(|react\/compiler-runtime/))
check('no source carries a fork gate', carriers(/isForkSubagentEnabled|FORK_SUBAGENT_TYPE|forkGateOn|isForkPath/) === '', carriers(/isForkSubagentEnabled|FORK_SUBAGENT_TYPE|forkGateOn|isForkPath/))
check(`binaryName() === 'mercury' (got '${binaryName()}')`, binaryName() === 'mercury')

console.log(fail === 0 ? ' ✅ NO-TELEMETRY-EGRESS PROOF PASS' : ' ❌ PROOF FAILED')
process.exit(fail)
