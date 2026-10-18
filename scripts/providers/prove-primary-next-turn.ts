import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld, bootLead, LEAD_MODEL } from '../crew/crew-world.ts'

let failures = 0
const check = (name: string, yes: boolean, detail = ''): void => { if (!yes) failures++; console.log(`[${yes ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`) }
const backup = 'claude-opus-5-5'
const world = await makeWorld('primary-next-turn', [
  { kind: 'text', text: 'PRIMARY-RETURNED', whenModel: LEAD_MODEL, whenSaid: 'second turn starts with the session primary', model: LEAD_MODEL },
  ...Array.from({ length: 12 }, () => ({ kind: 'error' as const, status: 529, errorType: 'overloaded_error', message: 'Overloaded', whenModel: LEAD_MODEL })),
  { kind: 'text', text: 'BACKUP-ANSWER', whenModel: backup, model: backup },
])
const settings = join(world.config, 'settings.json')
const previous = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}
writeFileSync(settings, JSON.stringify({ ...previous, engine: { ...previous.engine, backups: [backup] } }))
world.env.MERCURY_BUSY_RETRY_SCALE = '0.001'
const lead = bootLead(world, ['--sovereign'], [])
try {
  lead.submit('first turn uses its configured backup if overloaded')
  await lead.waitFor('first answer', () => lead.frames.some(f=>f.type==='outcome'))
  const first = lead.frames.find(f=>f.type==='outcome')
  check('the overloaded turn is answered by its configured backup', first?.status==='completed' && first?.answer==='BACKUP-ANSWER', JSON.stringify(first))
  const count = world.fixture.messageRequests().length
  lead.submit('second turn starts with the session primary')
  await lead.waitFor('second answer', () => lead.frames.filter(f=>f.type==='outcome').length===2)
  const requests = world.fixture.messageRequests().slice(count)
  const second = lead.frames.filter(f=>f.type==='outcome')[1]
  check('the very next turn tries the session primary first', (requests[0]?.body as {model?:string})?.model===LEAD_MODEL)
  check('the primary answer reaches the parent without a cooldown wait', second?.status==='completed' && second?.answer==='PRIMARY-RETURNED')
  const notices=lead.frames.filter(f=>f.type==='notice').map(f=>String(f.text))
  check('one overload switch is announced and no permanent model switch is fabricated', notices.filter(t=>t.includes('is overloaded; this turn runs on')).length===1)
  check('both turns close cleanly', await lead.end()===0)
} catch(error) { check('primary restoration journey',false,String(error)) }
finally { await lead.terminate(); await world.fixture.close(); rmSync(world.dir,{recursive:true,force:true}) }
console.log(`${failures?'FAIL':'PASS'} primary-next-turn: ${failures} failed`)
process.exit(failures?1:0)
