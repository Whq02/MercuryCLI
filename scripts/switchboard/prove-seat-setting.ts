#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-setting-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_MODEL_LANES

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}

const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const cap = await import('../../src/daemon/switchboard-capacity/capacityCheck.ts')
const compose = await import('../../src/crew/capacity/composeCeilings.ts')
const gov = await import('../../src/crew/capacity/governor.ts')
const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const verb = await import('../../src/commands/seats/applySeats.ts')

const SAMPLE = { cores: 8, availableBytes: 6 * cap.SEAT_COST_BYTES.runner, read: 'vm_stat' as const, sampledAt: 0 }
cap._setHeldMachineSeatReadingForTesting(6, SAMPLE)

{
  const before = cap.seatCeilingFacts()
  check('T1 with nothing stored the ceiling is the reading, named as the machine\'s', before.seats === 6 && before.source === 'machine' && before.reading === 6 && before.consented === null, JSON.stringify(before), 'seatCeilingFacts in src/daemon/switchboard-capacity/capacityCheck.ts must name the machine reading as the source when nothing is stored')
  check('T1 the ask is still owed', cap.needsCapacityAsk() === true, '', 'needsCapacityAsk in src/daemon/switchboard-capacity/capacityCheck.ts must stay true until a probe or consent decided')
  const nine = cap.setOperatorSeats(9)
  check('T1 setOperatorSeats stores the ceiling and names the source', nine.seats === 9 && nine.source === 'operator' && nine.sentence === 'the ceiling you set: 9 seats', JSON.stringify(nine), 'setOperatorSeats in src/daemon/switchboard-capacity/capacityCheck.ts must store the number and name the operator as the source')
  check('T1 the stored block carries the number and nothing else was decided (the ask stays owed)', getGlobalConfig().switchboardCapacity?.operatorSeats === 9 && cap.needsCapacityAsk() === true, JSON.stringify(getGlobalConfig().switchboardCapacity), 'setOperatorSeats in src/daemon/switchboard-capacity/capacityCheck.ts must store only operatorSeats in switchboardCapacity and leave the ask owed')
  check("T1 the value words: '9 · set by you'", cap.seatCeilingValueWords(nine) === '9 · set by you', cap.seatCeilingValueWords(nine), 'fix seatCeilingValueWords in src/daemon/switchboard-capacity/capacityCheck.ts')
  const warning = cap.seatCostWarning(nine)
  check("T1 above the reading the cost line names the reading and the runner's cost", warning !== null && warning.includes("this machine's reading: 6 seats (8 cores, 2.3 GB available, 384 MB a seat)") && warning.includes('runner process of about 384 MB'), String(warning), 'fix seatCostWarning in src/daemon/switchboard-capacity/capacityCheck.ts so it names the reading and the runner cost')
  check('T1 the reading sentence stands beside the ceiling whatever the source', nine.readingSentence === "this machine's reading: 6 seats (8 cores, 2.3 GB available, 384 MB a seat)", nine.readingSentence, 'fix readingSentence in the facts built by src/daemon/switchboard-capacity/capacityCheck.ts')
  const four = cap.setOperatorSeats(4)
  check('T1 under the reading the cost line is silent', four.seats === 4 && cap.seatCostWarning(four) === null)
  const floored = cap.setOperatorSeats(0)
  check('T1 junk floors at one (never zero, never a refusal here — the verb refuses)', floored.seats === 1 && floored.source === 'operator')
  const fraction = cap.setOperatorSeats(7.9)
  check('T1 a fraction stores its whole part', fraction.seats === 7)
  const cleared = cap.setOperatorSeats(null)
  check('T1 clearing returns to the reading', cleared.seats === 6 && cleared.source === 'machine' && getGlobalConfig().switchboardCapacity?.operatorSeats === undefined, JSON.stringify(cleared), 'setOperatorSeats(null) in src/daemon/switchboard-capacity/capacityCheck.ts must delete operatorSeats and fall back to the reading')
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.UTC(2026, 0, 2), allowed: true, recommendedSeats: 3 } }))
  const consented = cap.seatCeilingFacts()
  check('T1 a consented probe number is the ceiling when nothing is set by hand', consented.seats === 3 && consented.source === 'consented' && consented.consented === 3, JSON.stringify(consented), 'seatCeilingFacts in src/daemon/switchboard-capacity/capacityCheck.ts must use the consented probe number when no operator number is stored')
  const over = cap.setOperatorSeats(5)
  check('T1 the operator number outranks the consented one and keeps it on record', over.seats === 5 && over.source === 'operator' && over.consented === 3 && getGlobalConfig().switchboardCapacity?.recommendedSeats === 3, JSON.stringify(over), 'seatCeilingFacts in src/daemon/switchboard-capacity/capacityCheck.ts must rank the operator number above the consented one and keep the consented one')
  check('T1 the detail lines: the reading, its inputs, the cost a seat, the probe, the doors — one short line each', (() => {
    const lines = cap.seatCeilingDetailLines(over)
    return lines[0] === 'reading: 6 seats (this machine)' && lines[1] === '8 cores · 2.3 GB available' && lines[2] === '384 MB a seat (a session runner)' && lines[3] === 'first-boot probe: 3 seats' && lines.includes('doors: /seats N · Boot Menu · /config') && lines[lines.length - 1] === '/seats auto returns to the reading' && lines.every(l => l.length <= 42)
  })(), JSON.stringify(cap.seatCeilingDetailLines(over)), 'fix seatCeilingDetailLines in src/daemon/switchboard-capacity/capacityCheck.ts (line order, text, and a length of 42 at most)')
  check('T1 above the reading the detail carries the cost line', cap.seatCeilingDetailLines(cap.setOperatorSeats(9)).includes('above the reading — the machine may swap') && !cap.seatCeilingDetailLines(cap.setOperatorSeats(5)).includes('above the reading — the machine may swap'), '', 'seatCeilingDetailLines in src/daemon/switchboard-capacity/capacityCheck.ts must add the cost line only above the reading')
  const back = cap.setOperatorSeats(null)
  check('T1 clearing returns to the probe\'s number when one is stored', back.seats === 3 && back.source === 'consented')
  check('T1 the lever names the three doors', cap.seatCeilingLever().includes('/seats N') && cap.seatCeilingLever().includes('Boot Menu') && cap.seatCeilingLever().includes('/config') && cap.seatCeilingLever().includes('at once'), cap.seatCeilingLever(), 'fix seatCeilingLever in src/daemon/switchboard-capacity/capacityCheck.ts to name /seats N, Boot Menu, /config and at once')
  check('T1 the ask is answered once a probe decided', cap.needsCapacityAsk() === false)
}

{
  compose._resetComposeCeilingsForTesting()
  gov._resetCapacityGovernorForTesting()
  process.env.MERCURY_SEATS = '7'
  const inherited = compose.liveCeilingFacts(null)
  check("T2 a runner without an operator ceiling composes under the daemon's stamp", inherited.seats === 7 && inherited.seatSource === 'inherited', JSON.stringify(inherited), 'liveCeilingFacts in src/crew/capacity/composeCeilings.ts must take the MERCURY_SEATS stamp when no operator ceiling is stored')
  cap.setOperatorSeats(9)
  const operator = compose.liveCeilingFacts(null)
  check("T2 the operator's ceiling outranks the stamp — the change applies at the next ask, no restart", operator.seats === 9 && operator.seatSource === 'operator', JSON.stringify(operator), 'liveCeilingFacts in src/crew/capacity/composeCeilings.ts must rank the operator ceiling above the stamp')
  const composed = compose.refreshGovernorCeilings(null)
  check('T2 the governor composes nine lanes and nine delegated lanes', composed.modelLanes === 9 && composed.delegationLanes === 9, JSON.stringify(composed), 'refreshGovernorCeilings in src/crew/capacity/composeCeilings.ts must set model and delegation lanes from the ceiling')
  check("T2 the provenance names the operator's source", gov.governorProvenance().seatSource === 'operator' && gov.governorProvenance().seats === 9, JSON.stringify(gov.governorProvenance()), 'refreshGovernorCeilings in src/crew/capacity/composeCeilings.ts must record the seat source in the governor provenance (src/crew/capacity/governor.ts)')
  cap.setOperatorSeats(2)
  compose.refreshGovernorCeilings(null)
  check('T2 lowering applies at the next ask too (admission, never retention)', gov.governorCeilings().modelLanes === 2 && gov.governorProvenance().seatSource === 'operator', JSON.stringify(gov.governorCeilings()), 'refreshGovernorCeilings in src/crew/capacity/composeCeilings.ts must apply a lowered ceiling at the next call')
  delete process.env.MERCURY_SEATS
  cap.setOperatorSeats(null)
  compose._resetComposeCeilingsForTesting()
  gov._resetCapacityGovernorForTesting()
}

{
  cap.setOperatorSeats(4)
  check("T3 the daemon's effective ceiling is the operator's number", sup.effectiveSeatCeiling() === 4, String(sup.effectiveSeatCeiling()), 'effectiveSeatCeiling in src/daemon/concourse-workers/admission.ts must use the operator number')
  const live = Array.from({ length: 4 }, (_, i) => ({ workspaceId: `/scratch/ws-${i}` }))
  const refused = sup.evaluateConcourseAdmission(live, { workspaceId: '/scratch/ws-x' })
  check('T3 the refusal names the ceiling the operator set', refused.admit === false && refused.code === 'runtime-ceiling' && (refused.reason ?? '').includes('every seat is taken: 4 live sessions hold the 4 seats (the ceiling you set: 4 seats)'), JSON.stringify(refused), 'evaluateConcourseAdmission in src/daemon/concourse-workers/admission.ts must refuse with code runtime-ceiling and a reason naming the operator ceiling')
  check('T3 three live sessions are admitted under four', sup.evaluateConcourseAdmission(live.slice(0, 3), { workspaceId: '/scratch/ws-x' }).admit === true, '', 'evaluateConcourseAdmission in src/daemon/concourse-workers/admission.ts must admit while seats are free')
  cap.setOperatorSeats(null)
}

{
  check('T4 the parser: numbers, auto and its spellings, junk', verb.parseSeatsArg('8') === 8 && verb.parseSeatsArg(' 12 ') === 12 && verb.parseSeatsArg('auto') === 'auto' && verb.parseSeatsArg('reset') === 'auto' && verb.parseSeatsArg('0') === undefined && verb.parseSeatsArg('2.5') === undefined && verb.parseSeatsArg('many') === undefined && verb.parseSeatsArg('') === undefined, '', 'fix parseSeatsArg in src/commands/seats/applySeats.ts')
  const status = verb.applySeats('')
  check('T4 the bare verb reports the ceiling, its source and the reading (the consented number here)', status.startsWith("Seats: 3 · the first-boot probe — this machine's reading: 6 seats (8 cores, 2.3 GB available, 384 MB a seat)"), status.split('\n')[0], 'applySeats in src/commands/seats/applySeats.ts must open its report with the source and the reading')
  check('T4 the bare verb states the law and the doors', status.includes('A seat is held only while a model call is in flight') && status.includes('/seats N sets the ceiling') && status.includes('/seats auto returns') && status.includes('Boot Menu') && status.includes('/config'), status, 'applySeats in src/commands/seats/applySeats.ts must state the law and the doors in a bare report')
  const set = verb.applySeats('12')
  check('T4 /seats 12 stores and confirms at once, with the cost line above the reading', set.startsWith('Seats set to 12 · set by you — applies to the next admission at once') && set.includes("Note: above this machine's reading: 6 seats") && cap.seatCeilingFacts().seats === 12, set, 'applySeats in src/commands/seats/applySeats.ts must store the number, confirm at once, and add the cost note above the reading')
  const under = verb.applySeats('5')
  check('T4 /seats 5 (under the reading) confirms without a cost line', under.startsWith('Seats set to 5 · set by you') && !under.includes('Note:'), under, 'applySeats in src/commands/seats/applySeats.ts must confirm without a cost note under the reading')
  const machineStatus = (() => {
    saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: false } }))
    return verb.applySeats('')
  })()
  check("T4 with the machine as the source the head carries the reading's inputs", machineStatus.startsWith("Seats: 6 · this machine's reading (8 cores, 2.3 GB available, 384 MB a seat)"), machineStatus.split('\n')[0], 'applySeats in src/commands/seats/applySeats.ts must carry the reading inputs when the machine is the source')
  verb.applySeats('9')
  const auto = verb.applySeats('auto')
  check("T4 /seats auto returns to the machine's reading and says so", auto.startsWith("Seats follow this machine's reading again: 6 (8 cores, 2.3 GB available, 384 MB a seat)") && cap.seatCeilingFacts().source === 'machine', auto, 'applySeats(auto) in src/commands/seats/applySeats.ts must clear the operator number and say the seats follow the reading')
  const junk = verb.applySeats('0')
  check('T4 junk is refused with the accepted forms (0 included)', junk.startsWith('/seats takes a whole number of 1 or more, or auto') && cap.seatCeilingFacts().source === 'machine', junk, 'applySeats in src/commands/seats/applySeats.ts must refuse junk with the accepted forms and store nothing')
}

{
  check("T5 the Boot Menu row is the owner's row: label Seats, no boot-env key, live application", cap.SEATS_MENU_ROW.label === 'Seats' && cap.SEATS_MENU_ROW.env === 'seats' && cap.SEATS_MENU_ROW.applicationClass === 'live' && cap.SEATS_MENU_ROW.options.length === 0)
  const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
  const seatsSays = await crewChecks().find(row => row.id === 'seats')?.run()
  const seatFactsNow = cap.seatCeilingFacts()
  const unnumbered = (text: string): string => text.replace(/\d+(?:\.\d+)?/g, '#')
  check("T5 /health's Seats row reads the value words, the reading's inputs and the doors", seatsSays !== undefined && unnumbered(seatsSays.evidence).startsWith(unnumbered(`${cap.seatCeilingValueWords(seatFactsNow)} · ${seatFactsNow.readingSentence} · `)) && seatsSays.detail?.endsWith(` Setting: ${seatFactsNow.lever}.`) === true, `${seatsSays?.evidence} · ${seatsSays?.detail}`, 'the seats check in src/platform/health/sections/crew.ts must report the value words, the reading and the lever of seatCeilingFacts')
}

cap._setHeldMachineSeatReadingForTesting(null)
console.log(failures === 0 ? '\nprove-seat-setting: ALL LAWS HOLD' : `\nprove-seat-setting: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
