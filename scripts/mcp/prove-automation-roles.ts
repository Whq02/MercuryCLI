#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')
const { clientReach } = await import('../../src/services/mcp/automationAccess.ts')
const LEAD = '00000000-0000-4000-8000-000000000001'
const COORDINATOR = '00000000-0000-4000-8000-000000000002'
const OTHER = '00000000-0000-4000-8000-000000000003'

console.log('mercury mcp-server: lead and coordinator are names a client may send to, each resolved to the session named for it at startup')
{
  const one = clientReach({ name: 'c', run: false, send: ['coordinator'] }, { coordinator: COORDINATOR })
  check('the role coordinator resolves to the session named for it', one.send.length === 1 && one.send[0] === COORDINATOR, JSON.stringify(one))
  const all = clientReach({ name: 'c', run: true, send: ['lead', OTHER, 'coordinator'] }, { lead: LEAD, coordinator: COORDINATOR })
  check('lead and coordinator resolve side by side, a session id passes as it stands, the rest of the grant is untouched', JSON.stringify(all.send) === JSON.stringify([LEAD, OTHER, COORDINATOR]) && all.run === true && all.name === 'c', JSON.stringify(all))
  let unnamed = ''
  try {
    clientReach({ name: 'c', run: false, send: ['coordinator'] }, { lead: LEAD })
  } catch (error) {
    unnamed = error instanceof Error ? error.message : String(error)
  }
  check('a role no session was named for refuses by its name', unnamed === 'The coordinator session must be named at server startup', unnamed)
  let malformed = false
  try {
    clientReach({ name: 'c', run: false, send: ['lead'] }, { lead: 'not-a-session-id' })
  } catch {
    malformed = true
  }
  check('a role named with something that is no session id refuses', malformed)
}

console.log('\nthe server takes both names from its own options and resolves every grant through the one function')
{
  const server = readFileSync(join(ROOT, 'src/cli/mcpServer.ts'), 'utf8')
  const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
  check('the two options stand on mcp-server', main.includes(".option('--lead <session-id>', 'The session addressed by lead')") && main.includes(".option('--coordinator <session-id>', 'The session addressed by coordinator')"))
  check('the server builds the roles from them and passes every grant through clientReach', server.includes('const roles = { lead: options.lead ?? await launchingSession(cwd), coordinator: options.coordinator }') && server.split('clientReach(grant, roles)').length - 1 === 2, String(server.split('clientReach(grant, roles)').length - 1))
}

console.log(failures === 0 ? '\nPASS prove-automation-roles' : `\nFAIL prove-automation-roles (${failures})`)
process.exit(failures === 0 ? 0 : 1)
