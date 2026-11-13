#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWN_WORD = 'own-marker-7f3a'
const RESPAWNED = process.env.KILL_GUARD_REDIRECT_ROOT
if (RESPAWNED === undefined) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kill-guard-redirect-')))
  mkdirSync(join(root, 'config', 'tmp'), { recursive: true })
  mkdirSync(join(root, 'project'), { recursive: true })
  const child = Bun.spawnSync([process.execPath, ...process.argv.slice(1), OWN_WORD, '/dev/null', '2>/dev/null', '2', 'notes.txt'], {
    env: {
      ...process.env,
      KILL_GUARD_REDIRECT_ROOT: root,
      MERCURY_CONFIG_DIR: join(root, 'config'),
      MERCURY_TMPDIR: join(root, 'config', 'tmp'),
      MERCURY_DAEMON_DIR: join(root, 'config', 'daemon'),
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  rmSync(root, { recursive: true, force: true })
  process.exit(child.exitCode ?? 99)
}
delete process.env.MERCURY_HOME

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { shellSelfProtectionReason } = await import(`${SRC}/utils/permissions/shellProtectedPaths.ts`)
const project = join(RESPAWNED, 'project')
const reason = (command: string): Promise<string | null> => shellSelfProtectionReason(command, false, project)

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}

const own = [process.execPath, ...process.argv.slice(1)].join(' ')
section('the stand: this process is the one the guard protects, and its command line holds the words a redirect is written with')
check(
  'the command line of this process holds its own word, /dev/null, 2>/dev/null, a bare 2 and a file name',
  [OWN_WORD, ' /dev/null', ' 2>/dev/null', ' 2 ', 'notes.txt'].every(word => own.includes(word)),
  own,
)

section('A. a redirect is where the output goes, never the name of what is killed')
for (const [command, why] of [
  ["pkill -f 'examples/light_lab' 2>/dev/null", 'errors sent to /dev/null'],
  ["pkill -f 'examples/light_lab' 2>/dev/null; ls", 'the same, a second command after it'],
  ['pkill -f examples/light_lab >/dev/null 2>&1', 'both streams sent there'],
  ['pkill -f examples/light_lab 2>&1', 'errors joined to the output'],
  ['pkill -f examples/light_lab 2>&1 | tail -1', 'the same, piped on'],
  ['pkill -f examples/light_lab &>/dev/null', 'both streams by one arrow'],
  ['pkill -f examples/light_lab >&2', 'output sent to the error stream'],
  ['pkill -f examples/light_lab > /dev/null', 'a space after the arrow'],
  ['pkill -f examples/light_lab >> notes.txt', 'appended to a file'],
  ['pkill -f examples/light_lab < /dev/null', 'input taken from /dev/null'],
  ['pkill examples_light_lab 2>/dev/null', 'by name, not by command line'],
  ['killall light_lab 2>/dev/null', 'killall by name'],
  ['pgrep -f examples/light_lab 2>/dev/null | xargs kill', 'found by pgrep and piped to kill'],
  ['kill $(pgrep -f examples/light_lab 2>/dev/null)', 'the same by a substitution'],
] as Array<[string, string]>) {
  const answered = await reason(command)
  check(`not refused: ${command}  (${why})`, answered === null, answered ?? '')
}

section('B. a real kill by name or by group is refused exactly as before, with or without a redirect after it')
for (const [command, names] of [
  [`pkill -f ${OWN_WORD}`, `Killing by image ${OWN_WORD} is refused`],
  [`pkill -f ${OWN_WORD} 2>/dev/null`, `Killing by image ${OWN_WORD} is refused`],
  [`pkill -f ${OWN_WORD} >/dev/null 2>&1`, `Killing by image ${OWN_WORD} is refused`],
  [`pkill -f ${OWN_WORD} > /dev/null; ls`, `Killing by image ${OWN_WORD} is refused`],
  [`pgrep -f ${OWN_WORD} 2>/dev/null | xargs kill`, `Killing by image ${OWN_WORD} is refused`],
  ['pkill -f /dev/null', 'Killing by image /dev/null is refused'],
  ['pkill -f /dev/null 2>/dev/null', 'Killing by image /dev/null is refused'],
  ['pkill -f notes.txt > notes.txt', 'Killing by image notes.txt is refused'],
  ['pkill -f 2 >/dev/null', 'Killing by image 2 is refused'],
  ['pkill -f 2', 'Killing by image 2 is refused'],
  [`pkill -f ${OWN_WORD} 2>&1`, `Killing by image ${OWN_WORD} is refused`],
  [`pkill -f ${OWN_WORD} 2>&1 | tail -1`, `Killing by image ${OWN_WORD} is refused`],
  [`pkill -g ${process.pid} 2>/dev/null`, `Killing process group ${process.pid} is refused`],
  [`kill ${process.pid} 2>/dev/null`, `Killing pid ${process.pid} is refused`],
  [`kill -9 ${process.pid} >/dev/null 2>&1`, `Killing pid ${process.pid} is refused`],
  ['pkill -u $USER 2>/dev/null', 'Killing every process of user '],
  ['killall -u $USER > /dev/null', 'Killing every process of user '],
  ['pkill -u $USER 2>&1', 'Killing every process of user '],
] as Array<[string, string]>) {
  const answered = await reason(command)
  check(`refused: ${command}`, answered !== null && answered.includes(names) && answered.includes(' is refused'), answered ?? 'not refused')
}

section('quoted redirect words and an empty quoted operand are arguments, with or without a real redirect later')
for (const literal of ['>', '<']) {
  for (const suffix of ['', ' 2>/dev/null']) {
    const byPattern = await reason(`pkill -f '${literal}' '' ${OWN_WORD}${suffix}`)
    check(`a quoted ${literal} and empty operand do not hide the protected pattern${suffix}`, byPattern !== null && byPattern.includes(`Killing by image ${OWN_WORD} is refused`), byPattern ?? 'not refused')
    const executable = process.execPath.split(/[\\/]/).at(-1)!
    const byName = await reason(`killall '${literal}' '' ${executable}${suffix}`)
    check(`a quoted ${literal} and empty operand do not hide the protected executable${suffix}`, byName !== null && byName.includes(`Killing by image ${executable} is refused`), byName ?? 'not refused')
  }
}

section('C. the body of a quoted here-document is data: words in it that spell a kill are not read as one')
{
  const prose = `cat >> notes.md <<'EOF'\nthe session ran: pkill -f ${OWN_WORD} 2>/dev/null\nand then: killall -u $USER\nEOF`
  const answered = await reason(prose)
  check('a quoted here-document whose body names a kill of this very process is not refused', answered === null, answered ?? '')
  const live = await reason(`cat >> notes.md <<'EOF'\nnote\nEOF\npkill -f ${OWN_WORD}`)
  check('a kill written after the here-document is still read and refused', live !== null && live.includes(`Killing by image ${OWN_WORD} is refused`), live ?? 'not refused')
}

if (failures > 0) {
  console.log(`\n${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nall ${checks} green`)
