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
console.log(' lead team identity — briefs/verbs resolve from the lead seat')
console.log('============================================================')

const REPO = join(import.meta.dir, '../..')

const teammate = await import('../../src/utils/teammate.js')
const {
  getLeadTeamFallback,
  getTeamName,
  isTeammate,
  resolveLeadAwareTeamName,
  setLeadTeamFallback,
} = teammate

section('resolver UNIT — fallback rung, precedence, teammate semantics untouched')
setLeadTeamFallback(null)
check('bare, no registration → undefined', resolveLeadAwareTeamName() === undefined)
setLeadTeamFallback('teamX')
check('registered → resolves the fallback', resolveLeadAwareTeamName() === 'teamX')
check('explicit teamContext arg BEATS the fallback', resolveLeadAwareTeamName({ teamName: 'ctx' }) === 'ctx')
check('getTeamName() itself stays blind (no global rung)', getTeamName() === undefined)
check('isTeammate() stays false under a lead registration', isTeammate() === false)
setLeadTeamFallback(null)
check('cleared → undefined again', resolveLeadAwareTeamName() === undefined)

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
  'coordination server has ZERO bare getTeamName() calls',
  !/[^A-Za-z]getTeamName\(\)/.test(mcpSrc),
)
const serviceSrc = readFileSync(join(REPO, 'src/services/coordination/coordinationService.ts'), 'utf8')
check('the coordination service consumes resolveLeadAwareTeamName (with the caller\'s context)', serviceSrc.includes('resolveLeadAwareTeamName(teamContext ?? undefined)'))
check('the coordination service has ZERO bare getTeamName() calls', !/[^A-Za-z]getTeamName\(\)/.test(serviceSrc))
check('coordination server resolves through the service', mcpSrc.includes('resolveCoordinationContext()'))
const briefSrc = readFileSync(join(REPO, 'src/tools/TeamBriefTool/TeamBriefTool.ts'), 'utf8')
check(
  'TeamBrief resolves lead-aware with the AppState context (through the service)',
  briefSrc.includes('resolveCoordinationContext(context.getAppState().teamContext'),
)
const birthSrc = readFileSync(join(REPO, 'src/utils/crew/crewBirth.ts'), 'utf8')
check('the crew birth registers the lead team from the first turn (every session has a crew from the moment it starts)', birthSrc.includes('setLeadTeamFallback(sessionCrewName(sessionId))'))
check('the birth never overrides a led team the resume projection registered', birthSrc.includes('if (getLeadTeamFallback() === null) setLeadTeamFallback('))
const runnerSrc = readFileSync(join(REPO, 'src/cli/print.ts'), 'utf8')
const launcherSrc = readFileSync(join(REPO, 'src/replLauncher.tsx'), 'utf8')
check('the headless runner and the REPL launcher both birth the crew once the session id is final', (runnerSrc.match(/birthSessionCrew\(/g) ?? []).length === 2 && launcherSrc.includes('birthSessionCrew(String(getSessionId()), update => {'))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL LEAD-TEAM-IDENTITY PROOFS PASS')
else console.log(`❌ ${failures} LEAD-TEAM-IDENTITY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
