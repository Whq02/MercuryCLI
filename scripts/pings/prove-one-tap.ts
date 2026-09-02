// ============================================================================
//  scripts/pings/prove-one-tap.ts — "you get ONE tap" across BOTH bell
//  writers: the ping engine and the notifier's
//  terminal_bell floor ring through the ONE bell tap, so a single event
//  reaching both paths beeps once, and taps within a second ring once
//  process-wide.
//
//    §1 the tap itself — coalesced within its window, rings again after;
//    §2 the REAL notifier: two terminal_bell sends inside one second emit
//       ONE bell byte (the second is a coalesced cue, still an honest
//       emission receipt);
//    §3 the two writers route through the tap (structural — a new bell
//       writer that bypasses it fails here by name).
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

// Scratch home BEFORE imports — no prover touches the real config home.
const scratch = mkdtempSync(join(tmpdir(), 'pings-onetap-'))
process.env.HOME = scratch
process.env.MERCURY_CONFIG_DIR = join(scratch, '.mercury')
delete process.env.NODE_ENV
delete process.env.CI

const { tapTerminalBell, _resetBellTapForTesting } = await import(
  '../../src/services/pings/bellTap.js'
)
const { sendNotification } = await import('../../src/services/notifier.js')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failures += 1
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

//
section('§1 the tap coalesces within its window and rings again after')
//
{
  _resetBellTapForTesting()
  let rings = 0
  const ring = (): void => {
    rings += 1
  }
  check('the first tap rings', tapTerminalBell(ring, 1000) === true && rings === 1)
  check('a second tap 400 ms later folds in', tapTerminalBell(ring, 1400) === false && rings === 1)
  check('a tap 999 ms in still folds', tapTerminalBell(ring, 1999) === false && rings === 1)
  check('a tap past the window rings again', tapTerminalBell(ring, 2100) === true && rings === 2)
}

//
section('§2 the REAL notifier: two terminal_bell sends in one second → ONE byte')
//
{
  _resetBellTapForTesting()
  let bells = 0
  const terminal = {
    notifyITerm2: () => {},
    notifyKitty: () => {},
    notifyGhostty: () => {},
    notifyBell: () => {
      bells += 1
    },
    progress: () => {},
  }
  // A scratch home resolves channel 'auto' with no known terminal identity
  // — the documented floor: terminal_bell.
  const m1 = await sendNotification({ message: 'a session needs you', notificationType: 'concourse-needs-you' }, terminal)
  const m2 = await sendNotification({ message: 'a session needs you', notificationType: 'concourse-needs-you' }, terminal)
  check("both sends resolve the floor ('terminal_bell')", m1 === 'terminal_bell' && m2 === 'terminal_bell', `${m1}/${m2}`)
  check('one audible byte for the pair', bells === 1, `bells=${bells}`)
}

//
section('§3 every bell writer routes through the ONE tap (structural)')
//
{
  const notifier = readFileSync(join(ROOT, 'src', 'services', 'notifier.ts'), 'utf8')
  check(
    "the notifier's terminal_bell floor rings through tapTerminalBell",
    (notifier.match(/tapTerminalBell\(\(\) => terminal\.notifyBell\(\)\)/g) ?? []).length === 2,
  )
  check('no bare notifyBell call remains in the notifier', !/^\s*terminal\.notifyBell\(\)/m.test(notifier))
  const hook = readFileSync(join(ROOT, 'src', 'hooks', 'usePingEngine.ts'), 'utf8')
  check(
    'the ping engine rings through the same tap',
    hook.includes('tapTerminalBell(() => termWrite(process.stdout, BEL'),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL ONE-TAP PROOFS PASS')
else console.log(`${failures} ONE-TAP PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
