import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'ping-rule-'))
process.env.HOME = scratch
process.env.MERCURY_CONFIG_DIR = join(scratch, '.mercury')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
writeFileSync(join(process.env.MERCURY_CONFIG_DIR, 'settings.json'), '{}')

const focus = await import('../../src/ink/session/focus-store.ts')
const { updateLastInteractionTime } = await import('../../src/bootstrap/state.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const ping = await import('../../src/hooks/useTurnEndPing.ts')
const bytes = await import('../../src/ink/termio/notifyPing.ts')

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
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const T = ping.DEFAULT_INTERACTION_THRESHOLD_MS

section('§1 the presence rule: the focus signal first, the interaction window only when focus is unreported')
{
  focus.resetTerminalFocusState()
  updateLastInteractionTime(true)
  check('unknown focus + an interaction inside the window = at the screen', ping.isUserAtScreen(T) === true)
  await new Promise(r => setTimeout(r, 30))
  check('unknown focus + no interaction in the window = away', ping.isUserAtScreen(10) === false)
  focus.setTerminalFocused(false)
  updateLastInteractionTime(true)
  check('a reported blur is away even with a fresh interaction (the signal outranks the window)', ping.isUserAtScreen(T) === false)
  focus.setTerminalFocused(true)
  check('a reported focus is at the screen', ping.isUserAtScreen(T) === true)
  focus.resetTerminalFocusState()
  check('the window is six seconds', T === 6000)
}

section('§2 the bytes: OSC 9 on iTerm2, the bell everywhere else, nothing else in the vocabulary')
{
  check('iTerm2 takes OSC 9', bytes.defaultPingMethod('iTerm.app') === 'osc9')
  for (const t of ['Apple_Terminal', 'kitty', 'ghostty', 'WezTerm', 'windows-terminal', '', null]) {
    check(`${t === null ? 'no terminal identity' : t === '' ? 'an empty identity' : t} takes the bell`, bytes.defaultPingMethod(t) === 'bell')
  }
  const wrote: string[] = []
  const w = (d: string): void => {
    wrote.push(d)
  }
  const m1 = bytes.postTerminalNotification('hello', { method: 'osc9', write: w })
  check('one OSC 9 write carries the message behind the two newlines', m1 === 'osc9' && wrote.length === 1 && wrote[0]!.includes(']9;\n\nhello'), JSON.stringify(wrote))
  check('the OSC 9 write is not a bare bell', !/^\x07$/.test(wrote[0]!))
  wrote.length = 0
  const m2 = bytes.postTerminalNotification('hello', { method: 'bell', write: w })
  check('the bell road writes exactly one BEL byte, unwrapped', m2 === 'bell' && wrote.length === 1 && wrote[0] === '\x07', JSON.stringify(wrote))
  wrote.length = 0
  bytes.postTerminalNotification('a\x1bb\x07c', { method: 'osc9', write: w })
  check('control bytes never ride inside the OSC payload', wrote[0]!.includes(']9;\n\na b c'), JSON.stringify(wrote))
  const emitter = src('src/ink/termio/notifyPing.ts')
  check("the method vocabulary is exactly 'osc9' | 'bell'", /export type PingMethod = 'osc9' \| 'bell'\n/.test(emitter))
  check('the emitter never touches OSC 9;4 (progress stays progress)', !emitter.includes('9;4'))
}

section('§3 the switch: view.ping, read at call time')
{
  check('a fresh home pings', ping.pingEnabled() === true)
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'settings.json'), JSON.stringify({ view: { ping: false } }))
  resetSettingsCache()
  check('view.ping: false turns it off', ping.pingEnabled() === false)
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'settings.json'), JSON.stringify({ view: { ping: true } }))
  resetSettingsCache()
  check('view.ping: true turns it back on', ping.pingEnabled() === true)
  const types = src('src/utils/settings/types.ts')
  check('the switch is declared under the view group', /view: z\.object\(\{[\s\S]*?ping: z\.boolean\(\)\.optional\(\)/.test(types))
  const schema = JSON.parse(src('scripts/settings/settings-schema.json')) as { properties: { view: { properties: Record<string, unknown> } } }
  check('the generated schema carries view.ping', 'ping' in schema.properties.view.properties)
  const config = src('src/components/Settings/Config.tsx')
  check("/config carries the one row (id 'ping', the user settings' view.ping)", config.includes("id: 'ping'") && config.includes("writeSource('userSettings', { view: { ping: next ? undefined : false } })"))
  check('/config carries no channel picker and no second switch', !config.includes('CHANNEL_LABELS') && !config.includes("id: 'notifChannel'") && !config.includes("id: 'pingsBell'"))
}

section('§4 one event, one emitter, one mount')
{
  const hook = src('src/hooks/useTurnEndPing.ts')
  check('the hook is inert without a terminal write in context (a headless render, a runner, a crewmate)', hook.includes('if (write === null || turn.lastCompletedAt === null) return'))
  check('a reported focus state decides at the turn end; unknown focus waits one window', hook.includes("if (getTerminalFocusState() !== 'unknown') {\n      fire()\n      return\n    }") && hook.includes('const timer = setTimeout(fire, threshold)'))
  check('the switch and the busy fact are read at fire time', hook.includes('if (busyRef.current || isUserAtScreen(threshold) || !pingEnabled()) return'))
  check('the effect re-arms only on a new turn boundary', hook.includes('}, [write, turn.lastCompletedAt, threshold])'))
  const repl = src('src/screens/Chat.tsx')
  check('the chat screen mounts the ping on its turn boundary and the seat liveness', repl.includes('useTurnEndPing({ lastCompletedAt, busy: isLoading })'))
  const { execFileSync } = await import('node:child_process')
  const grep = (needle: string): string[] =>
    execFileSync('git', ['grep', '-l', needle, '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort()
  check('the hook has exactly one mount (the chat screen)', grep('useTurnEndPing(').join(',') === 'src/hooks/useTurnEndPing.ts,src/screens/Chat.tsx', grep('useTurnEndPing(').join(','))
  check('the emitter has exactly one caller (the hook)', grep('postTerminalNotification(').join(',') === 'src/hooks/useTurnEndPing.ts,src/ink/termio/notifyPing.ts', grep('postTerminalNotification(').join(','))
  let bare = 0
  for (const f of execFileSync('git', ['grep', '-l', 'BEL', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)) {
    const text = src(f)
    if (/write\(BEL\)|termWrite\([^)]*\bBEL\b/.test(text) && f !== 'src/ink/termio/notifyPing.ts') bare += 1
  }
  check('no other module writes a bell byte', bare === 0, String(bare))
  check('the consent card carries no ping of its own', !src('src/components/permissions/PermissionRequest.tsx').includes('Ping'))
  check('the question dialogs carry no ping of their own', !src('src/components/mcp/ElicitationDialog.tsx').includes('Ping'))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL PING-RULE PROOFS PASS')
else console.log(`${failures} PING-RULE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
