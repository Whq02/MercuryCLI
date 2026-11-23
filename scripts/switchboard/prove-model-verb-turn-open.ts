#!/usr/bin/env bun
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = join(process.env.TMPDIR ?? '/tmp', `model-verb-turn-open-${process.pid}`)
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  const failHint = ok ? '' : ' | to fix: the turn-open predicate is seatTurnOpen in src/daemon/session-seat/state.ts (exported by src/daemon/session-seat/sessionSeat.ts); the set_model hold-until-turn-end answer and the session/applied notification follow the wire contract in src/daemon/runner-wire/sessionVerbs.ts, with the verb handled by the runner behind it'
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${failHint}`)
}

const seat = await import(join(SRC, 'daemon/session-seat/sessionSeat.ts'))
const open = seat.seatTurnOpen as ((row: { outcome?: string; busy?: boolean; turnActive?: boolean } | undefined) => boolean) | undefined

console.log('T1 the turn-open predicate')
check('the predicate is exported', typeof open === 'function')
check('a turn past the cap (busy false, turnActive true) is OPEN — the switch parks', open?.({ busy: false, turnActive: true }) === true)
check('a turn inside the cap is open', open?.({ busy: true, turnActive: true }) === true)
check('a seat whose turn ended is not', open?.({ busy: false, turnActive: false }) === false)
check('with no turn fact the capped decision is the fallback (busy)', open?.({ busy: true }) === true)
check('with no turn fact the capped decision is the fallback (idle)', open?.({ busy: false }) === false)
check('a settled seat is never busy, whatever the bits', open?.({ outcome: 'degraded', busy: true, turnActive: true }) === false)
check('an unknown seat is not busy', open?.(undefined) === false)


console.log('T3 the runner defers the breadcrumbs to the turn boundary (source pins)')
{
  const { FIXTURE_MODEL, liveFactsOf, withFixtureRunner } = await import('../lib/builtProduct.ts')
  const { parseUserSpecifiedModel } = await import('../../src/models/catalogue/engineModel.ts')
  const NAMED = 'Sonnet 5'
  const NEXT_MODEL = String(parseUserSpecifiedModel(NAMED))
  const SPOKEN = 'the quiet sonnet'
  const held = await withFixtureRunner([{ kind: 'paced', deltas: ['one ', 'two ', 'three'], gapMs: 300 }], async (host, api) => {
    await host.prompt('go')
    await api.messageRequestStarted(1)
    const verb = host.send('session/set_model', { model: NAMED, words: SPOKEN })
    const answer = await verb.answer.catch(() => null)
    const during = (await liveFactsOf(host)).model.effective
    await host.waitFor('the paced turn ends', row => row.type === 'outcome').catch(() => undefined)
    const saidBack = await host.waitFor('the landed switch is said back', row => row.type === 'command_output', 10_000).then(row => String(row.text ?? ''), () => '')
    const after = (await liveFactsOf(host)).model.effective
    return { answer, during, after, saidBack, applied: host.notifications.filter(note => note.method === 'session/applied'), id: verb.id }
  })
  check('set_model holds while a turn is in flight and answers where the verb lands', NEXT_MODEL !== NAMED && JSON.stringify(held.answer) === JSON.stringify({ model: NEXT_MODEL, at: 'turn_end' }) && held.during === FIXTURE_MODEL && held.after === NEXT_MODEL && held.saidBack.startsWith(`<local-command-stdout>${SPOKEN} → ${NEXT_MODEL} · `) && JSON.stringify(held.applied) === JSON.stringify([{ method: 'session/applied', params: { request_id: held.id, verb: 'set_model', model: NEXT_MODEL } }]), JSON.stringify(held))
}

console.log(failures === 0 ? '\nprove-model-verb-turn-open: ALL PASS' : `\nprove-model-verb-turn-open: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
