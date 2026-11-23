#!/usr/bin/env bun

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const { clientReach } = await import('../../src/integrations/mcp/automationAccess.ts')
const LEAD = '00000000-0000-4000-8000-000000000001'
const COORDINATOR = '00000000-0000-4000-8000-000000000002'
const OTHER = '00000000-0000-4000-8000-000000000003'

console.log('mercury mcp-server: lead and coordinator are names a client may send to, each resolved to the session named for it at startup')
{
  const one = clientReach({ name: 'c', run: false, send: ['coordinator'] }, { coordinator: COORDINATOR })
  check('the role coordinator resolves to the session named for it', one.send.length === 1 && one.send[0] === COORDINATOR, JSON.stringify(one) + '; clientReach in src/integrations/mcp/automationAccess.ts must replace the role name with the session id given for it')
  const all = clientReach({ name: 'c', run: true, send: ['lead', OTHER, 'coordinator'] }, { lead: LEAD, coordinator: COORDINATOR })
  check('lead and coordinator resolve side by side, a session id passes as it stands, the rest of the grant is untouched', JSON.stringify(all.send) === JSON.stringify([LEAD, OTHER, COORDINATOR]) && all.run === true && all.name === 'c', JSON.stringify(all) + '; clientReach in src/integrations/mcp/automationAccess.ts must resolve each role in send, keep session ids and leave run and name as granted')
  let unnamed = ''
  try {
    clientReach({ name: 'c', run: false, send: ['coordinator'] }, { lead: LEAD })
  } catch (error) {
    unnamed = error instanceof Error ? error.message : String(error)
  }
  check('a role no session was named for refuses by its name', unnamed === 'The coordinator session must be named at server startup', unnamed + '; clientReach in src/integrations/mcp/automationAccess.ts must throw this message when no session was named for the role')
  let malformed = false
  try {
    clientReach({ name: 'c', run: false, send: ['lead'] }, { lead: 'not-a-session-id' })
  } catch {
    malformed = true
  }
  check('a role named with something that is no session id refuses', malformed, 'clientReach in src/integrations/mcp/automationAccess.ts did not throw for a role bound to a value that is not a session id')
}

console.log('\nthe server takes both names from its own options and resolves every grant through the one function')
{
  const { builtHelp } = await import('../lib/builtProduct.ts')
  const help = builtHelp('mcp-server')
  check('the two options stand on mcp-server', help.includes('--lead <session-id> The session addressed by lead') && help.includes('--coordinator <session-id> The session addressed by coordinator'), 'the mcp-server help lacks --lead or --coordinator; declare both options in src/boot/main/sessionDoors.ts')
}

console.log(failures === 0 ? '\nPASS prove-automation-roles' : `\nFAIL prove-automation-roles (${failures})`)
process.exit(failures === 0 ? 0 : 1)
