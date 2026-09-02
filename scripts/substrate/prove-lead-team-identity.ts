#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-lead-team-identity.ts
//  PROOF: lead sessions resolve their own team at the TOOL layer (task #70).
//
//  A LEAD runs in the operator's main session: no CLI identity args (that's
//  dynamicTeamContext — setting it would flip isTeammate(), the trap both
//  TeamCreate and the coordination-team design dodge) and no AsyncLocalStorage
//  scope. So every consumer of bare getTeamName() — TeamBrief, ALL five
//  coordination MCP verbs — answered the not-in-a-team EMPTY shape
//  from the lead seat. Live symptom: a lead's crewed run polled TeamBrief +
//  mcp__mercury__brief for 60s and saw an empty roster while the team's
//  config held every seat.
//
//  The fix: setLeadTeamFallback/resolveLeadAwareTeamName (teammate.ts) —
//  registered by the lead engage seams (TeamCreate; a third
//  seam retired with the router party), cleared/restored on disengage,
//  consumed by the briefs + MCP verbs. Deliberately NOT a rung inside
//  getTeamName(): isTeammate()/standalone semantics must not change.
//
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-lead-team-identity.ts
// ============================================================================
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

// Product imports AFTER the MACRO stamp-sim (static imports would hoist above it).
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

section('DRIFT-LOCK — consumers + the TeamCreate seams stay wired')
const mcpSrc = readFileSync(join(REPO, 'src/services/mcp/coordinationServer.ts'), 'utf8')
check(
  'coordination server has ZERO bare getTeamName() calls',
  !/[^A-Za-z]getTeamName\(\)/.test(mcpSrc),
)
// The lead-aware resolution lives in the coordination service; both
// projections (the MCP server, the TeamBrief tool) resolve through it.
const serviceSrc = readFileSync(join(REPO, 'src/services/coordination/coordinationService.ts'), 'utf8')
check('the coordination service consumes resolveLeadAwareTeamName (with the caller\'s context)', serviceSrc.includes('resolveLeadAwareTeamName(teamContext ?? undefined)'))
check('the coordination service has ZERO bare getTeamName() calls', !/[^A-Za-z]getTeamName\(\)/.test(serviceSrc))
check('coordination server resolves through the service', mcpSrc.includes('resolveCoordinationContext()'))
const briefSrc = readFileSync(join(REPO, 'src/tools/TeamBriefTool/TeamBriefTool.ts'), 'utf8')
check(
  'TeamBrief resolves lead-aware with the AppState context (through the service)',
  briefSrc.includes('resolveCoordinationContext(context.getAppState().teamContext'),
)
const teamCreateSrc = readFileSync(join(REPO, 'src/tools/TeamCreateTool/TeamCreateTool.ts'), 'utf8')
check('TeamCreate registers the lead team', teamCreateSrc.includes('setLeadTeamFallback(finalTeamName)'))
const teamDeleteSrc = readFileSync(join(REPO, 'src/tools/TeamDeleteTool/TeamDeleteTool.ts'), 'utf8')
check('TeamDelete clears the registration', teamDeleteSrc.includes('setLeadTeamFallback(null)'))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL LEAD-TEAM-IDENTITY PROOFS PASS')
else console.log(`❌ ${failures} LEAD-TEAM-IDENTITY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
