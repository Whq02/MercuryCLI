#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' lead crew identity — briefs/verbs resolve from the lead seat')
console.log('============================================================')

const REPO = join(import.meta.dir, '../..')

const crewmate = await import('../../src/utils/crewmate.js')
const {
  getLeadCrewFallback,
  getCrewName,
  isCrewmate,
  resolveLeadAwareCrewName,
  setLeadCrewFallback,
} = crewmate

section('resolver UNIT — fallback rung, precedence, crewmate semantics untouched')
setLeadCrewFallback(null)
check('bare, no registration → undefined', resolveLeadAwareCrewName() === undefined)
setLeadCrewFallback('crewX')
check('registered → resolves the fallback', resolveLeadAwareCrewName() === 'crewX')
check('explicit crewContext arg BEATS the fallback', resolveLeadAwareCrewName({ crewName: 'ctx' }) === 'ctx')
check('getCrewName() itself stays blind (no global rung)', getCrewName() === undefined)
check('isCrewmate() stays false under a lead registration', isCrewmate() === false)
setLeadCrewFallback(null)
check('cleared → undefined again', resolveLeadAwareCrewName() === undefined)

type StoreState = Record<string, unknown>
const makeStore = () => {
  let state: StoreState = {}
  return {
    getState: () => state,
    setState: (updater: (prev: StoreState) => StoreState) => {
      state = updater(state)
    },
  }
}

section('DRIFT-LOCK — consumers + the crew-birth seam stay wired')
const mcpSrc = readFileSync(join(REPO, 'src/services/mcp/coordinationServer.ts'), 'utf8')
check(
  'coordination server has ZERO bare getCrewName() calls',
  !/[^A-Za-z]getCrewName\(\)/.test(mcpSrc),
)
const serviceSrc = readFileSync(join(REPO, 'src/services/coordination/coordinationService.ts'), 'utf8')
check('the coordination service consumes resolveLeadAwareCrewName (with the caller\'s context)', serviceSrc.includes('resolveLeadAwareCrewName(crewContext ?? undefined)'))
check('the coordination service has ZERO bare getCrewName() calls', !/[^A-Za-z]getCrewName\(\)/.test(serviceSrc))
check('coordination server resolves through the service', mcpSrc.includes('resolveCoordinationContext()'))
const briefSrc = readFileSync(join(REPO, 'src/tools/LiveCommsTool/LiveCommsTool.ts'), 'utf8')
check(
  'LiveComms resolves lead-aware with the AppState context (through the service)',
  briefSrc.includes('resolveCoordinationContext(context.getAppState().crewContext'),
)
const birthSrc = readFileSync(join(REPO, 'src/utils/crew/crewBirth.ts'), 'utf8')
check('the crew birth registers the lead crew from the first turn (every session has a crew from the moment it starts)', birthSrc.includes('setLeadCrewFallback(sessionCrewName(sessionId))'))
check('the birth never overrides a led crew the resume projection registered', birthSrc.includes('if (getLeadCrewFallback() === null) setLeadCrewFallback('))
const runnerSrc = readFileSync(join(REPO, 'src/cli/run.ts'), 'utf8')
const launcherSrc = readFileSync(join(REPO, 'src/chatLauncher.tsx'), 'utf8')
check('the headless runner and the Chat launcher both birth the crew once the session id is final', (runnerSrc.match(/birthSessionCrew\(/g) ?? []).length === 2 && launcherSrc.includes('birthSessionCrew(String(getSessionId()), update => {'))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL LEAD-CREW-IDENTITY PROOFS PASS')
else console.log(`❌ ${failures} LEAD-CREW-IDENTITY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
