#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-setting-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_MODEL_LANES

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
const cap = await import('../../src/services/switchboard/capacityCheck.ts')
const compose = await import('../../src/services/capacity/composeCeilings.ts')
const gov = await import('../../src/services/capacity/governor.ts')
const sup = await import('../../src/daemon/concourseSupervisor.ts')
const verb = await import('../../src/commands/seats/applySeats.ts')

const SAMPLE = { cores: 8, availableBytes: 6 * cap.SEAT_COST_BYTES.runner, read: 'vm_stat' as const, sampledAt: 0 }
cap._setHeldMachineSeatReadingForTesting(6, SAMPLE)

{
  const before = cap.seatCeilingFacts()
  check('T1 with nothing stored the ceiling is the reading, named as the machine\'s', before.seats === 6 && before.source === 'machine' && before.reading === 6 && before.consented === null, JSON.stringify(before))
  check('T1 the ask is still owed', cap.needsCapacityAsk() === true)
  const nine = cap.setOperatorSeats(9)
  check('T1 setOperatorSeats stores the ceiling and names the source', nine.seats === 9 && nine.source === 'operator' && nine.sentence === 'the ceiling you set: 9 seats', JSON.stringify(nine))
  check('T1 the stored block carries the number and nothing else was decided (the ask stays owed)', getGlobalConfig().switchboardCapacity?.operatorSeats === 9 && cap.needsCapacityAsk() === true, JSON.stringify(getGlobalConfig().switchboardCapacity))
  check("T1 the value words: '9 · set by you'", cap.seatCeilingValueWords(nine) === '9 · set by you', cap.seatCeilingValueWords(nine))
  const warning = cap.seatCostWarning(nine)
  check("T1 above the reading the cost line names the reading and the runner's cost", warning !== null && warning.includes("this machine's reading: 6 seats (8 cores, 2.3 GB available, 384 MB a seat)") && warning.includes('runner process of about 384 MB'), String(warning))
  check('T1 the reading sentence stands beside the ceiling whatever the source', nine.readingSentence === "this machine's reading: 6 seats (8 cores, 2.3 GB available, 384 MB a seat)", nine.readingSentence)
  const four = cap.setOperatorSeats(4)
  check('T1 under the reading the cost line is silent', four.seats === 4 && cap.seatCostWarning(four) === null)
  const floored = cap.setOperatorSeats(0)
  check('T1 junk floors at one (never zero, never a refusal here — the verb refuses)', floored.seats === 1 && floored.source === 'operator')
  const fraction = cap.setOperatorSeats(7.9)
  check('T1 a fraction stores its whole part', fraction.seats === 7)
  const cleared = cap.setOperatorSeats(null)
  check('T1 clearing returns to the reading', cleared.seats === 6 && cleared.source === 'machine' && getGlobalConfig().switchboardCapacity?.operatorSeats === undefined, JSON.stringify(cleared))
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.UTC(2026, 0, 2), allowed: true, recommendedSeats: 3 } }))
  const consented = cap.seatCeilingFacts()
  check('T1 a consented probe number is the ceiling when nothing is set by hand', consented.seats === 3 && consented.source === 'consented' && consented.consented === 3, JSON.stringify(consented))
  const over = cap.setOperatorSeats(5)
  check('T1 the operator number outranks the consented one and keeps it on record', over.seats === 5 && over.source === 'operator' && over.consented === 3 && getGlobalConfig().switchboardCapacity?.recommendedSeats === 3, JSON.stringify(over))
  check('T1 the detail lines: the ceiling, the reading, the probe, the cost, the doors', (() => {
    const lines = cap.seatCeilingDetailLines(over)
    return lines[0] === 'ceiling 5 · set by you' && lines[1] === over.readingSentence && lines.some(l => l === 'the first-boot probe stored 3 seats') && lines.some(l => l.includes('a seat is one model call in flight')) && lines[lines.length - 1] === `doors: ${cap.SEAT_DOORS}`
  })(), JSON.stringify(cap.seatCeilingDetailLines(over)))
  const back = cap.setOperatorSeats(null)
  check('T1 clearing returns to the probe\'s number when one is stored', back.seats === 3 && back.source === 'consented')
  check('T1 the lever names the three doors', cap.seatCeilingLever().includes('/seats N') && cap.seatCeilingLever().includes('Boot Menu') && cap.seatCeilingLever().includes('/config') && cap.seatCeilingLever().includes('at once'), cap.seatCeilingLever())
  check('T1 the ask is answered once a probe decided', cap.needsCapacityAsk() === false)
}

{
  compose._resetComposeCeilingsForTesting()
  gov._resetCapacityGovernorForTesting()
  process.env.MERCURY_SEATS = '7'
  const inherited = compose.liveCeilingFacts(null)
  check("T2 a runner without an operator ceiling composes under the daemon's stamp", inherited.seats === 7 && inherited.seatSource === 'inherited', JSON.stringify(inherited))
  cap.setOperatorSeats(9)
  const operator = compose.liveCeilingFacts(null)
  check("T2 the operator's ceiling outranks the stamp — the change applies at the next ask, no restart", operator.seats === 9 && operator.seatSource === 'operator', JSON.stringify(operator))
  const composed = compose.refreshGovernorCeilings(null)
  check('T2 the governor composes nine lanes and nine delegated lanes', composed.modelLanes === 9 && composed.delegationLanes === 9, JSON.stringify(composed))
  check("T2 the provenance names the operator's source", gov.governorProvenance().seatSource === 'operator' && gov.governorProvenance().seats === 9, JSON.stringify(gov.governorProvenance()))
  cap.setOperatorSeats(2)
  compose.refreshGovernorCeilings(null)
  check('T2 lowering applies at the next ask too (admission, never retention)', gov.governorCeilings().modelLanes === 2 && gov.governorProvenance().seatSource === 'operator', JSON.stringify(gov.governorCeilings()))
  delete process.env.MERCURY_SEATS
  cap.setOperatorSeats(null)
  compose._resetComposeCeilingsForTesting()
  gov._resetCapacityGovernorForTesting()
}

{
  cap.setOperatorSeats(4)
  check("T3 the daemon's effective ceiling is the operator's number", sup.effectiveSeatCeiling() === 4, String(sup.effectiveSeatCeiling()))
  const live = Array.from({ length: 4 }, (_, i) => ({ workspaceId: `/scratch/ws-${i}` }))
  const refused = sup.evaluateConcourseAdmission(live, { workspaceId: '/scratch/ws-x' })
  check('T3 the refusal names the ceiling the operator set', refused.admit === false && refused.code === 'runtime-ceiling' && (refused.reason ?? '').includes('every seat is taken — the ceiling you set: 4 seats'), JSON.stringify(refused))
  check('T3 three live sessions are admitted under four', sup.evaluateConcourseAdmission(live.slice(0, 3), { workspaceId: '/scratch/ws-x' }).admit === true)
  cap.setOperatorSeats(null)
}

{
  check('T4 the parser: numbers, auto and its spellings, junk', verb.parseSeatsArg('8') === 8 && verb.parseSeatsArg(' 12 ') === 12 && verb.parseSeatsArg('auto') === 'auto' && verb.parseSeatsArg('reset') === 'auto' && verb.parseSeatsArg('0') === undefined && verb.parseSeatsArg('2.5') === undefined && verb.parseSeatsArg('many') === undefined && verb.parseSeatsArg('') === undefined)
  const status = verb.applySeats('')
  check('T4 the bare verb reports the ceiling, its source and the reading (the consented number here)', status.startsWith("Seats: 3 · the first-boot probe — this machine's reading: 6 seats (8 cores, 2.3 GB available, 384 MB a seat)"), status.split('\n')[0])
  check('T4 the bare verb states the law and the doors', status.includes('A seat is held only while a model call is in flight') && status.includes('/seats N sets the ceiling') && status.includes('/seats auto returns') && status.includes('Boot Menu') && status.includes('/config'), status)
  const set = verb.applySeats('12')
  check('T4 /seats 12 stores and confirms at once, with the cost line above the reading', set.startsWith('Seats set to 12 · set by you — applies to the next admission at once') && set.includes("Note: above this machine's reading: 6 seats") && cap.seatCeilingFacts().seats === 12, set)
  const under = verb.applySeats('5')
  check('T4 /seats 5 (under the reading) confirms without a cost line', under.startsWith('Seats set to 5 · set by you') && !under.includes('Note:'), under)
  const machineStatus = (() => {
    saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: false } }))
    return verb.applySeats('')
  })()
  check("T4 with the machine as the source the head carries the reading's inputs", machineStatus.startsWith("Seats: 6 · this machine's reading (8 cores, 2.3 GB available, 384 MB a seat)"), machineStatus.split('\n')[0])
  verb.applySeats('9')
  const auto = verb.applySeats('auto')
  check("T4 /seats auto returns to the machine's reading and says so", auto.startsWith("Seats follow this machine's reading again: 6 (8 cores, 2.3 GB available, 384 MB a seat)") && cap.seatCeilingFacts().source === 'machine', auto)
  const junk = verb.applySeats('0')
  check('T4 junk is refused with the accepted forms (0 included)', junk.startsWith('/seats takes a whole number of 1 or more, or auto') && cap.seatCeilingFacts().source === 'machine', junk)
}

{
  check("T5 the Boot Menu row is the owner's row: label Seats, no boot-env key, live application", cap.SEATS_MENU_ROW.label === 'Seats' && cap.SEATS_MENU_ROW.env === 'seats' && cap.SEATS_MENU_ROW.applicationClass === 'live' && cap.SEATS_MENU_ROW.options.length === 0)
  const menu = read('src/components/BootSettingsScreen.tsx')
  check('T5 the Boot Menu paints the row beside the env table, from the facts owner', menu.includes('SEATS_MENU_ROW') && menu.includes('seatCeilingValueWords(seatFacts)') && menu.includes('seatCeilingDetailLines(seatFacts)') && menu.includes('setOperatorSeats('))
  check('T5 the Boot Menu row never writes boot-env.json (the seats branch precedes the profile write)', /if \(isSeatsRow\(row\)\) return commitSeats\(/.test(menu))
  const config = read('src/components/Settings/Config.tsx')
  check('T5 the /config row reads the same value words and writes through the same owner', config.includes("id: 'seats'") && config.includes('seatCeilingValueWords(seatFacts)') && config.includes('setOperatorSeats(next)'))
  const table = read('src/commands.ts')
  check('T5 the /seats verb is registered', table.includes("import seats from './commands/seats/index.js'") && /^\s+seats,$/m.test(table))
  const doctor = read('src/utils/healthReport.ts')
  check("T5 the doctor's Seats row reads the value words, the reading's inputs and the doors", doctor.includes('seatCeilingValueWords(facts)') && doctor.includes('facts.readingSentence') && doctor.includes('Setting: ${facts.lever}'))
  const startup = read('src/substrate/startupMenu.ts')
  check('T5 the env-backed table itself is untouched (the row is config-backed, never baked)', !startup.includes("env: 'seats'"))
}

cap._setHeldMachineSeatReadingForTesting(null)
console.log(failures === 0 ? '\nprove-seat-setting: ALL LAWS HOLD' : `\nprove-seat-setting: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
