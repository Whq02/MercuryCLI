#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const owner = await import('../../src/components/concourse/boardModalOwner.ts')
type Facts = import('../../src/components/concourse/boardModalOwner.ts').BoardModalFactsV1
const { boardModalOwner } = owner
const mayArmBoardModal = (owner as Record<string, unknown>).mayArmBoardModal as ((f: Facts, t: string) => boolean) | undefined
const gitOfferOwnsTheKeys = (owner as Record<string, unknown>).gitOfferOwnsTheKeys as ((f: Facts) => boolean) | undefined

const quiet: Facts = {
  capacityAsk: false,
  trustAsk: false,
  settingsOpen: false,
  groundPickerOpen: false,
  rowPick: false,
  seatAsk: false,
  gitOffer: false,
  contractAsk: false,
  managerSeatAsk: false,
  managerCardArmed: false,
  coordinatorFocused: false,
  helpOpen: false,
}
const armed = (over: Partial<Facts>): Facts => ({ ...quiet, ...over })

console.log('the board\'s pointer doors and stacked mount follow the one key owner')

section('§1 mayArmBoardModal — a pointer door arms only while no other owner stands')
{
  check('the predicate is exported', typeof mayArmBoardModal === 'function')
  if (mayArmBoardModal) {
    const may = mayArmBoardModal
    check('a quiet board: the ground picker may arm', may(quiet, 'ground-picker') === true)
    check('a quiet board: the model picker may arm', may(quiet, 'settings') === true)
    check('THE SEAT-OVERLOAD CARD STANDS ⇒ the ground picker may NOT arm (the base opened it over the card)', may(armed({ seatAsk: true }), 'ground-picker') === false)
    check('…nor the model picker', may(armed({ seatAsk: true }), 'settings') === false)
    check('the manager seat-ask card stands ⇒ neither picker arms', may(armed({ managerSeatAsk: true }), 'ground-picker') === false && may(armed({ managerSeatAsk: true }), 'settings') === false)
    check('the capacity ask stands ⇒ no picker arms', may(armed({ capacityAsk: true }), 'ground-picker') === false)
    check('the trust ask stands ⇒ no picker arms', may(armed({ trustAsk: true }), 'settings') === false)
    check('the row pick stands ⇒ no picker arms', may(armed({ rowPick: true }), 'ground-picker') === false)
    check('the git-offer card stands ⇒ no picker arms over it', may(armed({ gitOffer: true }), 'ground-picker') === false)
    check('the atlas is open ⇒ no picker arms under it', may(armed({ helpOpen: true }), 'settings') === false)
    check('the ground picker is open ⇒ its own door still answers (the click closes it)', may(armed({ groundPickerOpen: true }), 'ground-picker') === true)
    check('the model picker is open ⇒ its own door still answers', may(armed({ settingsOpen: true }), 'settings') === true)
    check('the ground picker is open ⇒ the MODEL door does not arm a second Select', may(armed({ groundPickerOpen: true }), 'settings') === false)
    check('the model picker is open ⇒ the GROUND door does not arm a second Select', may(armed({ settingsOpen: true }), 'ground-picker') === false)
    check('a manager card with focus elsewhere ⇒ the doors answer', may(armed({ managerCardArmed: true, coordinatorFocused: false }), 'ground-picker') === true)
    check('a focused manager card ⇒ the doors yield', may(armed({ managerCardArmed: true, coordinatorFocused: true }), 'ground-picker') === false)
    check('the predicate is the owner table, not a second lattice', may(armed({ seatAsk: true, groundPickerOpen: true }), 'ground-picker') === (boardModalOwner(armed({ seatAsk: true, groundPickerOpen: true })) === 'ground-picker'))
  }
}

section('§2 gitOfferOwnsTheKeys — the stacked card paints exactly while the table names it')
{
  check('the predicate is exported', typeof gitOfferOwnsTheKeys === 'function')
  if (gitOfferOwnsTheKeys) {
    const owns = gitOfferOwnsTheKeys
    check('an offer alone owns the keys (the card paints)', owns(armed({ gitOffer: true })) === true)
    check('THE MODEL PICKER IS OPEN ⇒ the card does not paint over it (the base stacked it on top)', owns(armed({ gitOffer: true, settingsOpen: true })) === false)
    check('THE GROUND PICKER IS OPEN ⇒ the card does not paint over it', owns(armed({ gitOffer: true, groundPickerOpen: true })) === false)
    check('the row pick stands ⇒ the card waits', owns(armed({ gitOffer: true, rowPick: true })) === false)
    check('the seat-overload card stands ⇒ the card waits (as before)', owns(armed({ gitOffer: true, seatAsk: true })) === false)
    check('the manager seat ask stands ⇒ the card waits', owns(armed({ gitOffer: true, managerSeatAsk: true })) === false)
    check('the trust or capacity ask stands ⇒ the card waits', owns(armed({ gitOffer: true, trustAsk: true })) === false && owns(armed({ gitOffer: true, capacityAsk: true })) === false)
    check('the atlas is open ⇒ the card waits', owns(armed({ gitOffer: true, helpOpen: true })) === false)
    check('the picker closes ⇒ the card returns', owns(armed({ gitOffer: true, settingsOpen: false })) === true)
    check('no offer ⇒ nothing to paint', owns(quiet) === false)
  }
}

section('§3 the screen consults the owner at both routes')
{
  const src = readFileSync(join(ROOT, 'src/components/concourse/ConcourseScreen.tsx'), 'utf8')
  check('the screen imports both predicates', /mayArmBoardModal/.test(src) && /gitOfferOwnsTheKeys/.test(src))
  const ground = src.match(/openGroundPicker: \(\) => \{([\s\S]*?)\n\s*\},/)?.[1] ?? ''
  const model = src.match(/openCoordinatorModel: \(\) => \{([\s\S]*?)\n\s*\},/)?.[1] ?? ''
  check("the ground-picker POINTER door consults the owner before arming", /mayArmBoardModal\(modalFactsNow\(\), 'ground-picker'\)/.test(ground) && /setGroundPickerOpen/.test(ground), ground.trim().slice(0, 120))
  check('the model-picker POINTER door consults the owner before arming', /mayArmBoardModal\(modalFactsNow\(\), 'settings'\)/.test(model) && /openCoordinatorSettings\(\)/.test(model), model.trim().slice(0, 120))
  check('the doors read the facts at CLICK time from the refs (never a stale render)', /const modalFactsNow = \(\): BoardModalFactsV1 => \(\{[\s\S]*?capacityAskRef\.current[\s\S]*?helpOpenRef\.current/.test(src))
  const stacked = src.slice(src.indexOf('gitOfferOwnsTheKeys({'), src.indexOf('<GitOfferCard', src.indexOf('gitOfferOwnsTheKeys({')))
  check('the STACKED git-offer mount is gated on the owner naming it', stacked.length > 0 && /groundPickerOpen,/.test(stacked) && /settingsOpen,/.test(stacked) && /helpOpen,/.test(stacked))
  check('…and still yields to the contract ask (the pane order stands)', /gitOffer !== undefined &&\s*!contractAsk &&\s*geo\.profile !== 'wide' &&/.test(src))
  check('the old unfenced stacked gate is gone', !/gitOffer !== undefined && seatAsk === null && !contractAsk && geo\.profile !== 'wide' \?/.test(src))
  check("the keyboard path still yields whole to the owner (the doors joined it, never replaced it)", /const modalOwner = boardModalOwner\(\{/.test(src))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-board-modal-doors${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
