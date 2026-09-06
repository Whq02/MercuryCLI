#!/usr/bin/env bun
import { resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 300) : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const t = await import('../../src/services/voice/transcribe.js')
type Reads = import('../../src/services/voice/transcribe.js').TranscriberReads
type Local = import('../../src/services/voice/transcribe.js').LocalTranscriberRead
type Pin = import('../../src/services/voice/transcribe.js').TranscriberPin
type Saved = import('../../src/services/voice/transcribe.js').SavedTranscriber

const OK: Local = { state: 'ok', label: 'on-device transcriber (base.en-q5_1)', model: 'base.en-q5_1', language: 'en', pack: { version: '0.1.0', platform: 'fixture-os-fixture-arch', engine: 'whisper.cpp 1.8.3', gpu: 'none', where: 'the checkout' } }
const NO_PACK: Local = { state: 'absent', reason: 'pack', note: 'absent on this checkout — bun run scripts/vendor/build-whisper.ts builds it (cargo and cmake)', short: 'no on-device pack (bun run setup)' }
const NO_MODEL: Local = { state: 'absent', reason: 'model', note: 'pack present, model missing — /speak download fetches ggml-base.en-q5_1.bin (60 MB)', short: 'on-device model: /speak download' }
const reads = (openai: string | null, gemini: string | null, local: Local): Reads => ({ openaiApiKeyLabel: () => openai, geminiApiKeyLabel: () => gemini, localTranscriber: () => local })

section('§1 the matrix against the oracle')
{
  const locals: Array<[string, Local]> = [['ok', OK], ['no-pack', NO_PACK], ['no-model', NO_MODEL]]
  const orders: string[][] = [[], ['openai'], ['gemini', 'openai'], ['anthropic', 'openai', 'gemini'], ['anthropic']]
  const keys: Array<[string, string | null, string | null]> = [['none', null, null], ['openai', 'OpenAI API key (env)', null], ['gemini', null, 'Gemini API key (stored)'], ['both', 'OpenAI API key (stored)', 'Gemini API key (env-gemini)']]
  const pins: Array<[string, Pin]> = [['unset', { kind: 'unset' }], ['on-device', { kind: 'on-device' }], ['cloud', { kind: 'cloud' }], ['openai', { kind: 'family', family: 'openai' }], ['gemini', { kind: 'family', family: 'gemini' }], ['anthropic', { kind: 'family', family: 'anthropic' }], ['broken', { kind: 'broken', note: 'MERCURY_VOICE_TRANSCRIBER=bogus is not on-device, cloud or a family id' }]]
  const saveds: Array<[string, Saved]> = [['unset', { kind: 'unset' }], ['on-device', { kind: 'on-device' }], ['openai', { kind: 'family', family: 'openai' }], ['gemini', { kind: 'family', family: 'gemini' }], ['anthropic', { kind: 'family', family: 'anthropic' }], ['unknown', { kind: 'unknown', raw: 'bogus' }]]
  let cells = 0
  let wrong = 0
  const firstWithKey = (order: string[], openai: string | null, gemini: string | null): string | null => order.find(f => (f === 'openai' && openai !== null) || (f === 'gemini' && gemini !== null)) ?? null
  for (const [localName, local] of locals) {
    for (const order of orders) {
      for (const [keyName, openai, gemini] of keys) {
        for (const [pinName, pin] of pins) {
          for (const law of ['on-device-first', 'cloud-first'] as const) {
            for (const [savedName, saved] of saveds) {
              cells++
              const r = t.pickTranscriber(order, reads(openai, gemini, local), pin, law, saved)
              const cloud = firstWithKey(order, openai, gemini)
              const byOrder = law === 'on-device-first' ? (local.state === 'ok' ? 'local' : cloud !== null ? `cloud:${cloud}` : 'none:doors') : cloud !== null ? `cloud:${cloud}` : local.state === 'ok' ? 'local' : 'none:doors'
              let expected: string
              let savedState: 'serving' | 'unavailable' | 'overridden' | null = null
              if (pin.kind === 'broken') expected = 'none:pin'
              else if (pin.kind === 'on-device') expected = local.state === 'ok' ? 'local' : 'none:pin'
              else if (pin.kind === 'family') {
                const has = (pin.family === 'openai' && openai !== null) || (pin.family === 'gemini' && gemini !== null)
                expected = has ? `cloud:${pin.family}` : 'none:pin'
              } else if (pin.kind === 'cloud') expected = cloud !== null ? `cloud:${cloud}` : 'none:doors'
              else expected = byOrder
              if (saved.kind !== 'unset') {
                if (pin.kind !== 'unset') savedState = 'overridden'
                else if (saved.kind === 'on-device') {
                  if (local.state === 'ok') {
                    expected = 'local'
                    savedState = 'serving'
                  } else savedState = 'unavailable'
                } else if (saved.kind === 'family') {
                  const has = (saved.family === 'openai' && openai !== null) || (saved.family === 'gemini' && gemini !== null)
                  if (has) {
                    expected = `cloud:${saved.family}`
                    savedState = 'serving'
                  } else savedState = 'unavailable'
                } else savedState = 'unavailable'
              }
              const actual =
                r.state === 'ok'
                  ? r.choice.kind === 'local'
                    ? 'local'
                    : `cloud:${r.choice.family}`
                  : r.note.startsWith('MERCURY_VOICE_TRANSCRIBER=')
                    ? 'none:pin'
                    : r.note.startsWith('nothing transcribes yet — ') && r.note.endsWith(t.NO_TRANSCRIBER_DOORS)
                      ? 'none:doors'
                      : `none:?(${r.note})`
              const rideThrough = r.local === local
              const savedRight = savedState === null ? r.saved === null : r.saved !== null && r.saved.state === savedState && (savedState !== 'unavailable' || (typeof r.saved.note === 'string' && r.saved.note !== '' && typeof r.saved.short === 'string'))
              const localWon = r.state === 'ok' && r.choice.kind === 'local'
              const unusedRight = localWon && pin.kind === 'unset' ? r.unused.length === order.filter(f => (f === 'openai' && openai !== null) || (f === 'gemini' && gemini !== null)).length && r.unused.every(u => /MERCURY_VOICE_TRANSCRIBER=(openai|gemini) chooses it$/.test(u)) : r.state !== 'ok' || r.unused.length === 0
              const heldRight = !(local.state === 'ok' && (pin.kind === 'cloud' || pin.kind === 'family')) || r.skipped.some(s => s.startsWith('on-device transcriber: held back by MERCURY_VOICE_TRANSCRIBER='))
              if (actual !== expected || !rideThrough || !unusedRight || !heldRight || !savedRight) {
                wrong++
                if (wrong <= 8) console.log(`    cell local=${localName} order=[${order.join(',')}] keys=${keyName} pin=${pinName} law=${law} saved=${savedName}: expected ${expected} (saved ${savedState}), got ${actual} (saved ${r.saved?.state ?? 'null'})${rideThrough ? '' : ' (read did not ride through)'}${unusedRight ? '' : ' (unused wrong)'}${heldRight ? '' : ' (held-back line missing)'}`)
              }
            }
          }
        }
      }
    }
  }
  check(`every cell of the matrix (${cells}) agrees with the oracle of the pin law, the saved-choice law and the order law`, wrong === 0, `${wrong} wrong`)
  check('the order that ships is on-device first', t.TRANSCRIBER_ORDER === 'on-device-first')
}

section('§2 the words — skipped, unused, the pin naming itself, the receipt and its tail')
{
  let r = t.pickTranscriber(['anthropic', 'openai', 'gemini'], reads('OpenAI API key (env)', 'Gemini API key (stored)', OK))
  check('on-device wins over every signed-in family under the shipped order', r.state === 'ok' && r.choice.kind === 'local' && r.choice.model === 'base.en-q5_1' && r.choice.label === 'on-device transcriber (base.en-q5_1)', JSON.stringify(r))
  check('…the cloud families with a key are listed as not used, each with the pin that chooses it', r.state === 'ok' && r.unused.join(' | ') === 'OpenAI (OpenAI API key (env)) — MERCURY_VOICE_TRANSCRIBER=openai chooses it | Gemini (Gemini API key (stored)) — MERCURY_VOICE_TRANSCRIBER=gemini chooses it', r.state === 'ok' ? r.unused.join(' | ') : r.note)
  check('…and Anthropic is still passed over by name, once', r.skipped.filter(s => s.startsWith('Anthropic')).length === 1 && r.skipped.some(s => s === 'Anthropic: no speech-to-text endpoint'), r.skipped.join(' | '))
  r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, OK), { kind: 'cloud' })
  check('pin cloud ⇒ the ledger walk, the on-device road held back by name', r.state === 'ok' && r.choice.kind === 'cloud' && r.choice.family === 'openai' && r.skipped.includes('on-device transcriber: held back by MERCURY_VOICE_TRANSCRIBER=cloud'), JSON.stringify(r))
  r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, OK), { kind: 'family', family: 'gemini' })
  check('pin gemini without a Gemini key ⇒ none, the pin names itself', r.state === 'none' && r.note === 'MERCURY_VOICE_TRANSCRIBER=gemini but no Gemini API key is signed in — the pin names itself, no silent fallback', r.state === 'none' ? r.note : 'ok')
  r = t.pickTranscriber([], reads(null, 'Gemini API key (stored)', OK), { kind: 'family', family: 'gemini' })
  check('pin gemini with a Gemini key ⇒ Gemini, even with no ledger row (a key is a sign-in)', r.state === 'ok' && r.choice.kind === 'cloud' && r.choice.family === 'gemini' && r.skipped.includes('on-device transcriber: held back by MERCURY_VOICE_TRANSCRIBER=gemini'), JSON.stringify(r))
  r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, OK), { kind: 'family', family: 'anthropic' })
  check('pin anthropic ⇒ none: no speech-to-text endpoint, the pin names itself', r.state === 'none' && r.note === 'MERCURY_VOICE_TRANSCRIBER=anthropic but Anthropic: no speech-to-text endpoint — the pin names itself, no silent fallback', r.state === 'none' ? r.note : 'ok')
  r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, NO_PACK), { kind: 'on-device' })
  check('pin on-device with no pack ⇒ none naming the pin and the whole reason, never the cloud', r.state === 'none' && r.note === `MERCURY_VOICE_TRANSCRIBER=on-device but the on-device transcriber is ${NO_PACK.note} — the pin names itself, no silent fallback`, r.state === 'none' ? r.note : 'ok')
  r = t.pickTranscriber([], reads(null, null, OK), { kind: 'on-device' })
  check('pin on-device with the road usable ⇒ on-device, nothing walked', r.state === 'ok' && r.choice.kind === 'local' && r.skipped.length === 0 && r.unused.length === 0)
  r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, OK), { kind: 'unset' }, 'cloud-first')
  check('the other order (cloud first) is proven too: the family wins and the on-device road is named second', r.state === 'ok' && r.choice.kind === 'cloud' && r.skipped.includes('on-device transcriber: usable, second in the order (cloud first)'), JSON.stringify(r))
  r = t.pickTranscriber([], reads(null, null, OK), { kind: 'unset' }, 'cloud-first')
  check('…and a keyless home under cloud first still lands on-device', r.state === 'ok' && r.choice.kind === 'local')

  check('keyless + no pack ⇒ the receipt names the pack door then the cloud doors', t.noTranscriberReceipt(NO_PACK) === 'nothing transcribes yet — no on-device pack (bun run setup); or /logins openai (API key) or /logins gemini', t.noTranscriberReceipt(NO_PACK))
  check('keyless + no model ⇒ the receipt names the download door then the cloud doors', t.noTranscriberReceipt(NO_MODEL) === 'nothing transcribes yet — on-device model: /speak download; or /logins openai (API key) or /logins gemini', t.noTranscriberReceipt(NO_MODEL))
  check('keyless + pin cloud with the road usable ⇒ the receipt says the pin held it back', t.noTranscriberReceipt(OK, { kind: 'cloud' }) === 'nothing transcribes yet — on-device held back by the pin; or /logins openai (API key) or /logins gemini', t.noTranscriberReceipt(OK, { kind: 'cloud' }))
  const shorts = [NO_PACK.short, NO_MODEL.short, 'no on-device pack in this build', 'on-device pack pin broken', 'on-device model pin broken', 'damaged model: /speak download', 'CPU below the on-device floor', 'on-device held back by the pin']
  const longest = Math.max(...shorts.map(s => t.noTranscriberReceipt({ ...NO_PACK, short: s }).length))
  check(`every receipt keeps the cloud doors as its tail and fits the notice row at 120 columns (longest ${longest})`, longest <= 106 && shorts.every(s => t.noTranscriberReceipt({ ...NO_PACK, short: s }).endsWith(`; or ${t.NO_TRANSCRIBER_DOORS}`)))
  check('the doors are the neutral grammar', t.NO_TRANSCRIBER_DOORS === '/logins openai (API key) or /logins gemini')

  check('the pin parses: unset · on-device · cloud · a family id, case-blind', t.parseTranscriberPin(undefined).kind === 'unset' && t.parseTranscriberPin(' ').kind === 'unset' && t.parseTranscriberPin('ON-DEVICE').kind === 'on-device' && t.parseTranscriberPin('cloud').kind === 'cloud' && JSON.stringify(t.parseTranscriberPin('openai')) === JSON.stringify({ kind: 'family', family: 'openai' }))
  const broken = t.parseTranscriberPin('bogus')
  check('a pin outside the vocabulary names itself and the vocabulary', broken.kind === 'broken' && broken.note.startsWith('MERCURY_VOICE_TRANSCRIBER=bogus is not on-device, cloud or a family id (') && broken.note.includes('openai') && broken.note.endsWith('the pin names itself, no silent fallback'), broken.kind === 'broken' ? broken.note : broken.kind)
  r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, OK), broken)
  check('…and the picker answers none with that note, never a silent fallback', r.state === 'none' && broken.kind === 'broken' && r.note === broken.note)
  check('every family answers the table: API-key slots for OpenAI and Gemini, none elsewhere; the Local-models row stays a family row', t.FAMILY_TRANSCRIBER.openai.slot === 'api-key' && t.FAMILY_TRANSCRIBER.gemini.slot === 'api-key' && t.FAMILY_TRANSCRIBER.local.slot === 'none' && Object.values(t.FAMILY_TRANSCRIBER).every(v => v.slot === 'api-key' || v.why !== ''))
}

section('§2b the saved choice — served when it can be, named when it cannot, overridden by the pin; the options door')
{
  const SAVED_OPENAI: Saved = { kind: 'family', family: 'openai' }
  const SAVED_GEMINI: Saved = { kind: 'family', family: 'gemini' }
  let r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, OK), { kind: 'unset' }, 'on-device-first', SAVED_OPENAI)
  check('a saved family that is signed in serves over the present on-device road, which is named as usable with the saved choice', r.state === 'ok' && r.choice.kind === 'cloud' && r.choice.family === 'openai' && r.saved?.state === 'serving' && r.saved.display === 'OpenAI' && r.skipped.includes('on-device transcriber: usable (base.en-q5_1), your saved choice is OpenAI'), JSON.stringify(r))
  r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, OK), { kind: 'unset' }, 'on-device-first', SAVED_GEMINI)
  check('a saved family that is not signed in is named, and the default (on-device) serves', r.state === 'ok' && r.choice.kind === 'local' && r.saved?.state === 'unavailable' && r.saved.display === 'Gemini' && r.saved.note === 'not signed in — /logins gemini (API key)' && r.saved.short === 'is not signed in', JSON.stringify(r.saved))
  r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, NO_PACK), { kind: 'unset' }, 'on-device-first', { kind: 'on-device' })
  check('a saved on-device choice with no pack is named with the whole reason, and the family serves', r.state === 'ok' && r.choice.kind === 'cloud' && r.saved?.state === 'unavailable' && r.saved.note === NO_PACK.note && r.saved.short === 'cannot serve', JSON.stringify(r.saved))
  r = t.pickTranscriber([], reads(null, null, OK), { kind: 'unset' }, 'on-device-first', { kind: 'on-device' })
  check('a saved on-device choice with the road usable serves, and says so', r.state === 'ok' && r.choice.kind === 'local' && r.saved?.state === 'serving' && r.saved.name === 'on-device', JSON.stringify(r.saved))
  r = t.pickTranscriber([], reads(null, null, OK), { kind: 'unset' }, 'on-device-first', { kind: 'unknown', raw: 'bogus' })
  check('a saved word outside the vocabulary is named with the vocabulary, and the default serves', r.state === 'ok' && r.choice.kind === 'local' && r.saved?.state === 'unavailable' && r.saved.note === '"bogus" is not a transcriber this install can use (on-device · openai · gemini)' && r.saved.short === 'is not a transcriber', JSON.stringify(r.saved))
  r = t.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, OK), { kind: 'cloud' }, 'on-device-first', { kind: 'on-device' })
  check('the pin overrides a saved choice and names it', r.state === 'ok' && r.choice.kind === 'cloud' && r.saved?.state === 'overridden' && r.saved.note === 'MERCURY_VOICE_TRANSCRIBER=cloud overrides your saved choice (on-device) for this process', JSON.stringify(r.saved))
  r = t.pickTranscriber([], reads(null, null, NO_PACK), { kind: 'unset' }, 'on-device-first', SAVED_OPENAI)
  check('a saved family with nothing to fall to ⇒ none with the doors, the saved choice still named', r.state === 'none' && r.note.startsWith('nothing transcribes yet — ') && r.saved?.state === 'unavailable' && r.saved.display === 'OpenAI', JSON.stringify(r))
  check('the saved vocabulary parses: unset · on-device (case-blind) · a family · an unknown word kept as written', t.parseSavedTranscriber(undefined).kind === 'unset' && t.parseSavedTranscriber('ON-Device').kind === 'on-device' && JSON.stringify(t.parseSavedTranscriber('openai')) === JSON.stringify({ kind: 'family', family: 'openai' }) && JSON.stringify(t.parseSavedTranscriber('Bogus')) === JSON.stringify({ kind: 'unknown', raw: 'bogus' }))
  check('the options door accepts on-device and every family with a speech-to-text slot', JSON.stringify(t.transcriberOptionNames()) === JSON.stringify(['on-device', 'openai', 'gemini']))
  const rows = t.transcriberOptions(reads('OpenAI API key (env)', null, OK))
  check('the options rows: on-device ready with its model and pack, OpenAI ready with its label, Gemini not signed in with its door', rows.length === 3 && rows[0]?.name === 'on-device' && rows[0].state === 'ready' && rows[0].detail === 'whisper.cpp base.en-q5_1 (pack 0.1.0 fixture-os-fixture-arch, the checkout)' && rows[1]?.name === 'openai' && rows[1].state === 'ready' && rows[1].detail === 'OpenAI API key (env)' && rows[2]?.name === 'gemini' && rows[2].state === 'unavailable' && rows[2].detail === 'not signed in — /logins gemini (API key)', JSON.stringify(rows))
  const packless = t.transcriberOptions(reads(null, null, NO_MODEL))
  check('…and an on-device road that cannot serve carries its reason', packless[0]?.state === 'unavailable' && packless[0].detail === NO_MODEL.note, JSON.stringify(packless[0]))
}

section('§3 the kinds — display words, the error, the bound, the markers')
{
  check('the display word: the family name for a cloud choice, on-device for the local one', t.choiceDisplayName({ kind: 'cloud', family: 'openai', slot: 'api-key', label: 'x' }) === 'OpenAI' && t.choiceDisplayName({ kind: 'local', label: 'x', model: 'm' }) === 'on-device')
  check('the debug word never prints "Local models" for the on-device road', t.choiceDebugName({ kind: 'local', label: 'x', model: 'm' }) === 'on-device' && t.choiceDebugName({ kind: 'cloud', family: 'gemini', slot: 'api-key', label: 'x' }) === 'gemini')
  const local = new t.TranscribeError('local', 'x')
  const cloud = new t.TranscribeError('openai', 'y')
  check('the error carries the kind and the family (null for on-device)', local.kind === 'local' && local.family === null && cloud.kind === 'cloud' && cloud.family === 'openai' && local.name === 'TranscribeError')
  check('the on-device bound is two minutes plus the take (30 s ⇒ 150 s; 0 ⇒ 120 s)', t.localTranscribeDeadlineMs(30_000) === 150_000 && t.localTranscribeDeadlineMs(0) === 120_000 && t.localTranscribeDeadlineMs(-5) === 120_000)
  check('the cloud deadline stays two minutes', t.TRANSCRIBE_DEADLINE_MS === 120_000)
  check('the non-speech markers are dropped, words kept', t.stripNonSpeechMarkers('[BLANK_AUDIO] hello (silence) world [MUSIC]') === 'hello world' && t.stripNonSpeechMarkers('  ') === '' && t.stripNonSpeechMarkers('(yes) fine') === '(yes) fine')
}

if (failures > 0) {
  console.log(`\nprove-transcriber-picker: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-transcriber-picker: green')
process.exit(0)
