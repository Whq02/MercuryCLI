#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod/v4'
import { removeScratch } from '../lib/removeScratch.ts'

const SELF = 'scripts/bash/prove-readers-recording.ts'
const CORPUS = join(import.meta.dir, 'readers-corpus.json')
const RECORDING = join(import.meta.dir, 'readers-recording.json')
const FAKE_USER = 'operator'
const OWN_PID = 4_194_305
const SLICES = 4
const ROOT_LENGTH = 160
const SHOWN = 20
const CELL = 6
const LONGEST_SHOWN = 4000

const valueOf = (flag: string): string | undefined => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined)
const RECORD = process.argv.includes('--record')
const TREE = resolve(valueOf('--tree') ?? join(import.meta.dir, '..', '..'))
const BASE = valueOf('--base') ?? process.env.READERS_RECORDING_BASE
const READINGS = valueOf('--readings')
const DISAGREE = valueOf('--disagree')
const LINES = valueOf('--lines')?.split(',').map(Number)

const DENY = ['Bash(rm *)', 'Bash(git push *)', 'Read(secrets/**)', 'Read(**/hidden.key)', 'Read(~/vault/**)', 'Edit(secrets/**)', 'Edit(~/vault/**)']
const DOORS: ReadonlyArray<readonly [name: string, mode: string, deny: readonly string[]]> = [
  ['decision:default, no rule', 'default', []],
  ['decision:default', 'default', DENY],
  ['decision:sovereign', 'sovereign', DENY],
  ['decision:flow', 'flow', DENY],
]
const POSIX_ENTRIES = [
  'parseForSecurity',
  'checkSemantics',
  'splitCommand',
  'extractOutputRedirections',
  'analyzeCommand',
  'prefix',
  'checkPermissionMode',
  'rewriteReadOnlyGitCommand',
  'hardenedGitRead',
  'serviceInput',
  'readShellCommands:posix',
  'readShellCommands:powershell',
  'wards:Bash',
  'wards:PowerShell',
  'floors:bash',
  'floors:powershell',
  'flowShellAsk:bash',
  'flowShellAsk:powershell',
  'denyRuleReach',
  ...DOORS.map(([name]) => name),
]
const WINDOWS_ENTRIES = ['windows:wards:Bash', 'windows:wards:PowerShell']
const ENTRIES = [...POSIX_ENTRIES, ...WINDOWS_ENTRIES]

type Programs = { read: true; programs: string[] } | { read: false; why: string }
type Seen = { ast: Programs; wards: Programs; meets: string }
type Judged = { readings: Record<string, string[]>; seen: Record<string, Seen>; spent: Record<string, number> }
type Kind = 'a hole closed' | 'an ask removed' | 'not a hole: the guard keeps its base verdict'
type ExpectedChange = { line: string; entry: string; base: string; now: string; cell: string; kind: Kind; why: string }
const EXPECTED_CHANGES: readonly ExpectedChange[] = [
  { line: "alias h='cd ~'; h; rm -rf *", entry: 'readShellCommands:posix', base: 'rm -rf * is read standing in <project>', now: 'rm -rf * is read standing in <home>', cell: '0p1pss', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the alias; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: "alias h='cd ~'; h; rm -rf *", entry: 'wards:Bash', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: 'r5xhdp', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the alias; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: "alias h='cd ~'; h; rm -rf *", entry: 'floors:bash', base: 'no floor refuses', now: 'the floor refuses: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'sgm54v', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the alias; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: "alias h='cd ~'; h; rm -rf *", entry: 'decision:default, no rule', base: 'ask: alias evaluates its arguments as shell code; simplify the command, or approve', now: 'deny: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'ckhfhg', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the alias; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: "alias h='cd ~'; h; rm -rf *", entry: 'decision:default', base: "deny: alias h='cd ~'; h; rm -rf * is denied by the rule Bash(rm *) in the project local settings.", now: 'deny: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'ckhfhg', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the alias; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: "alias h='cd ~'; h; rm -rf *", entry: 'decision:sovereign', base: "deny: alias h='cd ~'; h; rm -rf * is denied by the rule Bash(rm *) in the project local settings.", now: 'deny: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'ckhfhg', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the alias; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: "alias h='cd ~'; h; rm -rf *", entry: 'decision:flow', base: "deny: alias h='cd ~'; h; rm -rf * is denied by the rule Bash(rm *) in the project local settings.", now: 'deny: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'ckhfhg', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the alias; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: "alias h='cd ~'; h; rm -rf *", entry: 'windows:wards:Bash', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: 'r5xhdp', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the alias; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'eval "cd ~"; rm -rf *', entry: 'readShellCommands:posix', base: 'rm -rf * is read standing in <project>', now: 'rm -rf * is read standing in <home>', cell: 'v19gf4', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the eval; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'eval "cd ~"; rm -rf *', entry: 'wards:Bash', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: 'r5xhdp', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the eval; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'eval "cd ~"; rm -rf *', entry: 'floors:bash', base: 'no floor refuses', now: 'the floor refuses: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'sgm54v', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the eval; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'eval "cd ~"; rm -rf *', entry: 'decision:default, no rule', base: 'ask: eval evaluates its arguments as shell code; simplify the command, or approve', now: 'deny: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'ckhfhg', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the eval; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'eval "cd ~"; rm -rf *', entry: 'decision:default', base: 'deny: eval "cd ~"; rm -rf * is denied by the rule Bash(rm *) in the project local settings.', now: 'deny: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'ckhfhg', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the eval; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'eval "cd ~"; rm -rf *', entry: 'decision:sovereign', base: 'deny: eval "cd ~"; rm -rf * is denied by the rule Bash(rm *) in the project local settings.', now: 'deny: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'ckhfhg', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the eval; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'eval "cd ~"; rm -rf *', entry: 'decision:flow', base: 'deny: eval "cd ~"; rm -rf * is denied by the rule Bash(rm *) in the project local settings.', now: 'deny: Changing * is refused: <home>/.mercury/runtime is part of Mercury’s running runtime.', cell: 'ckhfhg', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the eval; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'eval "cd ~"; rm -rf *', entry: 'windows:wards:Bash', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: 'r5xhdp', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the eval; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'f() { cd ~; }; f; rm -rf *', entry: 'readShellCommands:posix', base: 'rm -rf * is read standing in <project>', now: 'rm -rf * is read standing in <home>', cell: '94m8vb', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the called function; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'f() { cd ~; }; f; rm -rf *', entry: 'wards:Bash', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: 'r5xhdp', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the called function; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'f() { cd ~; }; f; rm -rf *', entry: 'windows:wards:Bash', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: 'r5xhdp', kind: 'a hole closed', why: 'the shell stands in the home folder when rm -rf * runs, moved there by the called function; cd ~; rm -rf * is refused by the same ward and the same floor on the base' },
  { line: 'cd <CONFIG>; cd /usr; cd ~-; rm -rf runtime', entry: 'flowShellAsk:bash', base: 'asks before rm -rf runtime: it deletes /usr/~-/runtime, outside the project', now: 'no ask', cell: 'cvbd7m', kind: 'an ask removed', why: 'Flow took ~- for a folder named /usr/~-; the reading knows it is the folder left, <config>, own ground in this world as rm -rf <CONFIG>/runtime already answers on the base; the floor refuses the line as before, and on a home outside the temp roots the ask stays and names ~/.mercury/runtime' },
  { line: 'cd ~/.ssh; cd /usr; cd ~-; echo k >> authorized_keys', entry: 'flowShellAsk:bash', base: 'asks before echo k >> authorized_keys: it writes /usr/~-/authorized_keys, outside the project', now: 'no ask', cell: 'cvbd7m', kind: 'an ask removed', why: 'Flow took ~- for a folder named /usr/~-; the reading knows it is the folder left, ~/.ssh, own ground in this world as echo k >> ~/.ssh/authorized_keys already answers on the base; the floor refuses the line as before, and on a home outside the temp roots the ask stays and names ~/.ssh/authorized_keys' },
  { line: "      process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\\r\\n\\r\\n${payload}`)", entry: 'readShellCommands:powershell', base: "5 commands: payload | Buffer.byteLength <not known> | payload | Content-Length: $<not known>\\r\\n\\r\\n$<not known>) | process.stdout.write <not known>", now: "4 commands: payload | Buffer.byteLength <not known> | Content-Length: $<not known>\\r\\n\\r\\n$payload) | process.stdout.write <not known>", cell: 'p1h3sw', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: '${V} secrets/k.txt', entry: 'readShellCommands:powershell', base: '2 commands: V | $<not known> secrets/k.txt', now: '1 commands: $V secrets/k.txt', cell: 'dj21nc', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: '${X} x', entry: 'readShellCommands:powershell', base: '2 commands: X | $<not known> x', now: '1 commands: $X x', cell: 'm0nkv6', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'D=sub; mkdir ${D}', entry: 'readShellCommands:powershell', base: '3 commands: sub | D | mkdir $<not known>', now: '2 commands: sub | mkdir $D', cell: 'f9336q', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'D=sub; touch ${D}/a', entry: 'readShellCommands:powershell', base: '3 commands: sub | D | touch $<not known>/a', now: '2 commands: sub | touch $D/a', cell: 'nv92h5', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'Remove-Item -Recurse -Force ${env:USERPROFILE}', entry: 'readShellCommands:powershell', base: '2 commands: env:USERPROFILE | Remove-Item -Recurse -Force $<not known>', now: '1 commands: Remove-Item -Recurse -Force $env:USERPROFILE', cell: 'j5hppq', kind: 'a hole closed', why: 'in PowerShell ${name} is the braced spelling of $name: the line deletes the home folder; the same ward refuses $env:USERPROFILE, "${env:USERPROFILE}" and $HOME under the PowerShell tool on the base, and this very line under the Bash tool' },
  { line: 'Remove-Item -Recurse -Force ${env:USERPROFILE}', entry: 'wards:PowerShell', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: 'bt7fmb', kind: 'a hole closed', why: 'in PowerShell ${name} is the braced spelling of $name: the line deletes the home folder; the same ward refuses $env:USERPROFILE, "${env:USERPROFILE}" and $HOME under the PowerShell tool on the base, and this very line under the Bash tool' },
  { line: 'Remove-Item -Recurse -Force ${env:USERPROFILE}', entry: 'windows:wards:PowerShell', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: 'bt7fmb', kind: 'a hole closed', why: 'in PowerShell ${name} is the braced spelling of $name: the line deletes the home folder; the same ward refuses $env:USERPROFILE, "${env:USERPROFILE}" and $HOME under the PowerShell tool on the base, and this very line under the Bash tool' },
  { line: 'bash -c ${V}', entry: 'readShellCommands:powershell', base: '3 commands: V | bash -c $<not known> | <not known>', now: '2 commands: bash -c $V | $V', cell: 'rsfc84', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'bash <<< ${V}', entry: 'readShellCommands:powershell', base: '2 commands: V | bash <<< $<not known>', now: '1 commands: bash <<< $V', cell: 'm1gjzf', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'cat ${V}', entry: 'readShellCommands:powershell', base: '2 commands: V | cat $<not known>', now: '1 commands: cat $V', cell: '713wn6', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'docker ${X} ps', entry: 'readShellCommands:powershell', base: '2 commands: X | docker $<not known> ps', now: '1 commands: docker $X ps', cell: 'qqs6vv', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'echo ${x}', entry: 'readShellCommands:powershell', base: '2 commands: x | echo $<not known>', now: '1 commands: echo $x', cell: 'fr044j', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'echo x > ${V}', entry: 'readShellCommands:powershell', base: '2 commands: V | echo x', now: '1 commands: echo x', cell: 'c41hkk', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'foreach (${f} in Get-ChildItem -Recurse) { Get-Content ${f}.FullName }', entry: 'readShellCommands:powershell', base: '5 commands: f | Get-ChildItem -Recurse | f | Get-Content $<not known>.FullName | foreach <not known> <not known>', now: '3 commands: Get-ChildItem -Recurse | Get-Content $f.FullName | foreach <not known> <not known>', cell: 'k8gqtz', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'killall -u ${LOGNAME}', entry: 'readShellCommands:powershell', base: '2 commands: LOGNAME | killall -u $<not known>', now: '1 commands: killall -u $LOGNAME', cell: 'n1mmnz', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'mywrap ${V}', entry: 'readShellCommands:powershell', base: '2 commands: V | mywrap $<not known>', now: '1 commands: mywrap $V', cell: '06bvps', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'rm -rf ${HOME}/x', entry: 'readShellCommands:powershell', base: '2 commands: HOME | rm -rf $<not known>/x', now: '1 commands: rm -rf $HOME/x', cell: '6919rh', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'sleep ${a} & sleep ${b}', entry: 'readShellCommands:powershell', base: '4 commands: a | sleep $<not known> | b | sleep $<not known>', now: '2 commands: sleep $a | sleep $b', cell: 't45zpc', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'source ${V}', entry: 'readShellCommands:powershell', base: '2 commands: V | source $<not known>', now: '1 commands: source $V', cell: '7pttxq', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'xargs cat <<< ${V}', entry: 'readShellCommands:powershell', base: '2 commands: V | xargs cat <<< $<not known>', now: '1 commands: xargs cat <<< $V', cell: '0shq6d', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text ${name} is the variable, where the base read $ with a part not known and the name as a command of its own; no guard answers this line otherwise' },
  { line: 'builtin cd -- config && cat *.json', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/config', cell: 'ndv8db', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- "$dir"; cat .credentials.json', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in a folder not known', cell: 'tq5nrd', kind: 'a hole closed', why: 'a bare -- ends the parameters of a move: the read stands in a folder not known; the same floor refuses cd "$DIR" && cat .credentials.json as PowerShell text on the base, and this very line as bash text' },
  { line: 'cd -- "$dir"; cat .credentials.json', entry: 'floors:powershell', base: 'no floor refuses', now: 'the secret-reach floor refuses: .credentials.json', cell: 'p43d9s', kind: 'a hole closed', why: 'a bare -- ends the parameters of a move: the read stands in a folder not known; the same floor refuses cd "$DIR" && cat .credentials.json as PowerShell text on the base, and this very line as bash text' },
  { line: 'cd -- "$dir"; cat notes.txt', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in a folder not known', cell: '1x16kv', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- -weird; cat notes.txt', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/-weird', cell: '52cpt8', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- Documents && cat notes.txt', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/Documents', cell: 'r8xm9n', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- Documents; grep -r canary .', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/Documents', cell: 'q1gc8f', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- build && rm -rf *', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/build', cell: 'b9x5s2', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- config && cat mcp-auth.json', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/config', cell: 'vp5mh8', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- config; cat *', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/config', cell: '082pgw', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- config; cat *.json', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/config', cell: 'v312cd', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- sub; cat notes.txt', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/sub', cell: '31bn2d', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd -- ~ && rm -rf *', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <home>', cell: '5w3k4c', kind: 'a hole closed', why: 'a bare -- ends the parameters of a move: the line moves home and deletes there; the same ward refuses cd ~ && rm -rf * under the PowerShell tool on the base, and this very line under the Bash tool' },
  { line: 'cd -- ~ && rm -rf *', entry: 'wards:PowerShell', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: '9msfw5', kind: 'a hole closed', why: 'a bare -- ends the parameters of a move: the line moves home and deletes there; the same ward refuses cd ~ && rm -rf * under the PowerShell tool on the base, and this very line under the Bash tool' },
  { line: 'cd -- ~ && rm -rf *', entry: 'windows:wards:PowerShell', base: 'not refused', now: 'refused by the ward no-root-recursive-delete', cell: '9msfw5', kind: 'a hole closed', why: 'a bare -- ends the parameters of a move: the line moves home and deletes there; the same ward refuses cd ~ && rm -rf * under the PowerShell tool on the base, and this very line under the Bash tool' },
  { line: 'cd --; cat notes.txt', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <home>', cell: 'mvvhf7', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'cd --; grep -r canary .', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <home>', cell: 'rnz9q6', kind: 'a hole closed', why: 'a bare -- ends the parameters of a move: with nothing after it the line moves home and searches the whole of it; the same floor refuses this very line as bash text on the base' },
  { line: 'cd --; grep -r canary .', entry: 'floors:powershell', base: 'no floor refuses', now: 'the secret-reach floor refuses: the whole of this folder (name a folder beneath it)', cell: '80sb5c', kind: 'a hole closed', why: 'a bare -- ends the parameters of a move: with nothing after it the line moves home and searches the whole of it; the same floor refuses this very line as bash text on the base' },
  { line: 'cd -P -- config; cat *.json', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/config', cell: '9r4d6n', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
  { line: 'pushd -- config; cat *.json', entry: 'readShellCommands:powershell', base: 'the command after the move stands in <project>/--', now: 'the command after the move stands in <project>/config', cell: 'qj9xcw', kind: 'not a hole: the guard keeps its base verdict', why: 'the reading alone: as PowerShell text a bare -- ends the parameters of a move, so the folder after it is the one the bash reading of this line has, where the base read a folder named --; no guard answers this line otherwise' },
]

const SPELLING = '0123456789bcdfghjkmnpqrstvwxz'
function spelled(value: number, width: number): string {
  let out = ''
  let left = value
  for (let at = 0; at < width; at++) {
    out = SPELLING[left % SPELLING.length] + out
    left = Math.floor(left / SPELLING.length)
  }
  return out
}
const cellOf = (text: string): string => spelled(createHash('sha256').update(text).digest().readUInt32BE(0) >>> 3, CELL)
const lineKey = (line: string): string => spelled(Math.floor(createHash('sha256').update(line).digest().readUIntBE(0, 5) / 4), CELL + 2)
const cut = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, width)} … (${text.length} characters)`)

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const note = (text: string): void => console.log(`  [NOTE] ${text}`)

async function judgedBy(tree: string, indexes: readonly number[], scratch: string): Promise<Judged | null> {
  const count = Math.min(SLICES, Math.max(1, indexes.length))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !name.startsWith('READERS_RECORDING_')))
  const runs = Array.from({ length: count }, (_unused, slice) => {
    const named = join(scratch, `${tree === TREE ? 'own' : 'base'}-${slice}-`)
    const root = join(`${named}${'x'.repeat(Math.max(1, ROOT_LENGTH - named.length - '/in/world'.length))}`, 'in', 'world')
    const home = join(root, 'home', 'Users', FAKE_USER)
    const config = join(root, 'config')
    mkdirSync(home, { recursive: true })
    mkdirSync(join(config, 'tmp'), { recursive: true })
    if (root.length !== ROOT_LENGTH) throw new Error(`${SELF}: the scratch folder ${scratch} is too long a path for a world of ${ROOT_LENGTH} characters; set TMPDIR to a shorter folder`)
    writeFileSync(join(root, 'lines.json'), JSON.stringify(indexes.filter((_at, order) => order % count === slice)))
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'prove-readers-recording.ts'), '--tree', tree, ...(DISAGREE === undefined ? [] : ['--disagree', DISAGREE])], {
      env: { ...env, HOME: home, USERPROFILE: home, USER: FAKE_USER, LOGNAME: FAKE_USER, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(scratch, 'transpiled'), READERS_RECORDING_ROOT: root, MERCURY_CONFIG_DIR: config, MERCURY_TMPDIR: join(config, 'tmp'), MERCURY_DAEMON_DIR: join(config, 'daemon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-git-config') },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    return { root, exited: child.exited }
  })
  const out: Judged = { readings: {}, seen: {}, spent: {} }
  for (const run of runs) {
    if ((await run.exited) !== 0 || !existsSync(join(run.root, 'judged.json'))) return null
    const part = JSON.parse(readFileSync(join(run.root, 'judged.json'), 'utf8')) as Judged
    Object.assign(out.readings, part.readings)
    Object.assign(out.seen, part.seen)
    for (const [entry, ms] of Object.entries(part.spent)) out.spent[entry] = (out.spent[entry] ?? 0) + ms
  }
  return out
}

function disagreement(found: Seen): string | null {
  if (!found.ast.read && !found.wards.read) return null
  if (found.ast.read && found.wards.read) {
    const wards = found.wards.programs
    const ast = found.ast.programs
    return ast.every(name => wards.includes(name)) && wards.every(name => ast.includes(name)) ? null : 'both read it and see different programs'
  }
  return found.ast.read ? 'the permission walker reads it, the wards walker does not' : 'the wards walker reads it, the permission walker does not'
}

function writeDisagreements(path: string, lines: readonly string[], indexes: readonly number[], seen: Record<string, Seen>): void {
  const said = (programs: Programs): string => (programs.read ? (programs.programs.length === 0 ? 'no program' : programs.programs.join(' ')) : `not read: ${cut(programs.why, 90)}`)
  const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', '\\n')
  const rows: Array<{ kind: string; row: string }> = []
  let neither = 0
  for (const at of indexes) {
    const found = seen[String(at)]
    if (found === undefined) continue
    if (!found.ast.read && !found.wards.read) neither++
    const kind = disagreement(found)
    if (kind !== null) rows.push({ kind, row: `| \`${cell(cut(lines[at] as string, 100))}\` | ${cell(said(found.ast))} | ${cell(said(found.wards))} | ${cell(found.meets)} |` })
  }
  const kinds = [...new Set(rows.map(row => row.kind))].sort()
  const counted = kinds.map(kind => `${kind}: ${rows.filter(row => row.kind === kind).length}`)
  const head = ['# The lines the two walkers read differently', '', `Written by \`bun ${SELF} --disagree <path>\` from the tree \`${TREE}\`: ${indexes.length} corpus lines, ${rows.length} read differently by \`src/utils/bash/ast.ts\` (the permission walker) and \`src/utils/wards/wardsShellRead.ts\` (the wards walker); ${neither} more are read by neither.`, '', ...counted.map(row => `- ${row}`), '']
  const body = kinds.flatMap(kind => [`## ${kind} (${rows.filter(row => row.kind === kind).length})`, '', '| the line | the permission walker saw | the wards walker saw | what a user meets (default mode, no rule) |', '|---|---|---|---|', ...rows.filter(row => row.kind === kind).map(row => row.row), ''])
  writeFileSync(path, `${[...head, ...body].join('\n')}\n`)
  note(`${rows.length} of ${indexes.length} lines are read differently by the two walkers (${counted.join('; ')}); ${neither} are read by neither → ${path}`)
}

if (!process.env.READERS_RECORDING_ROOT) {
  console.log('============================================================')
  console.log(' the readers of a command line — the recording (what each entry answers)')
  console.log('============================================================')
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as string[]
  const indexes = LINES ?? corpus.map((_line, at) => at)
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'readers-recording-')))
  const started = performance.now()
  const judged = await judgedBy(TREE, indexes, scratch)
  const seconds = (performance.now() - started) / 1000
  if (judged === null) check('every slice of the corpus was judged', false, 'a slice ended without its answers; its own lines above say why')
  else {
    const readings = judged.readings
    const work = Object.entries(judged.spent).sort((a, b) => b[1] - a[1])
    note(`${indexes.length} lines, ${ENTRIES.length} entries each, judged in ${seconds.toFixed(1)} s on ${Math.min(SLICES, indexes.length)} processes: ${(work.reduce((sum, [, ms]) => sum + ms, 0) / 1000).toFixed(1)} s of judging (${work.map(([entry, ms]) => `${entry} ${(ms / 1000).toFixed(1)}`).join(' · ')})`)
    if (READINGS !== undefined) writeFileSync(READINGS, JSON.stringify(Object.fromEntries(indexes.map(at => [at, Object.fromEntries(ENTRIES.map((entry, column) => [entry, (readings[String(at)] as string[])[column]]))]))))
    if (DISAGREE !== undefined) writeDisagreements(DISAGREE, corpus, indexes, judged.seen)
    const recorded = existsSync(RECORDING) ? (JSON.parse(readFileSync(RECORDING, 'utf8')) as { platform: string; cell: number; entries: string[]; rows: string[] }) : undefined
    if (RECORD) {
      if (recorded !== undefined) check('the recording is made once, on the base: it is never re-recorded by a seat', false, `${RECORDING} stands; a verdict that changes on purpose is a row of EXPECTED_CHANGES in ${SELF}`)
      else if (LINES !== undefined) check('the recording holds every line of the corpus', false, '--record does not go with --lines')
      else {
        const head = JSON.stringify({ platform: process.platform, cell: CELL, entries: ENTRIES }).slice(1, -1)
        writeFileSync(RECORDING, `{${head},\n"rows":[\n${indexes.map(at => JSON.stringify(lineKey(corpus[at] as string) + (readings[String(at)] as string[]).map(cellOf).join(''))).join(',\n')}\n]}\n`)
        console.log(`\n  [RECORDED] ${indexes.length} lines, ${ENTRIES.length} entries each → ${RECORDING}`)
      }
    } else if (TREE !== resolve(join(import.meta.dir, '..', '..'))) note(`the answers are those of the tree ${TREE}; nothing is compared`)
    else if (recorded === undefined) check('the recording exists beside the proof', false, RECORDING)
    else if (recorded.platform !== process.platform) console.log(`\n  [SKIP] the recording was taken on ${recorded.platform} and reads a scratch tree as that platform lists and spells it; on ${process.platform} nothing of it is compared`)
    else {
      section(`(1) the corpus — ${corpus.length} lines, ${recorded.entries.length} entries each`)
      check('the entries are the recorded ones, in their order', JSON.stringify(recorded.entries) === JSON.stringify(ENTRIES) && recorded.cell === CELL, JSON.stringify(recorded.entries))
      check('the recording has one row a corpus line, in the corpus order', recorded.rows.length === corpus.length && corpus.every((line, at) => (recorded.rows[at] ?? '').startsWith(lineKey(line))), `${recorded.rows.length} rows, ${corpus.length} lines`)
      const expected = new Map(EXPECTED_CHANGES.map(change => [`${change.line}\u0000${change.entry}`, change]))
      check('each row of EXPECTED_CHANGES names a corpus line and an entry, once', expected.size === EXPECTED_CHANGES.length && EXPECTED_CHANGES.every(change => corpus.includes(change.line) && ENTRIES.includes(change.entry)))
      const moved: Array<{ at: number; entry: string; column: number; was: string; now: string }> = []
      const met = new Set<string>()
      for (const at of indexes) {
        const row = (recorded.rows[at] ?? '').slice(CELL + 2)
        const now = readings[String(at)] as string[]
        ENTRIES.forEach((entry, column) => {
          const change = expected.get(`${corpus[at]}\u0000${entry}`)
          const was = change === undefined ? row.slice(column * CELL, (column + 1) * CELL) : change.cell
          const cell = cellOf(now[column] as string)
          if (change !== undefined) met.add(`${change.line}\u0000${change.entry}`)
          if (cell !== was) moved.push({ at, entry, column, was, now: cell })
        })
      }
      section(`(2) every entry answers every line as recorded${EXPECTED_CHANGES.length > 0 ? `, but for the ${EXPECTED_CHANGES.length} rows of EXPECTED_CHANGES` : ''}`)
      const differing = [...new Set(moved.map(row => row.at))]
      const perEntry = new Map<string, number>()
      for (const row of moved) perEntry.set(row.entry, (perEntry.get(row.entry) ?? 0) + 1)
      check(
        `${indexes.length} lines × ${ENTRIES.length} entries answer what the base answered`,
        moved.length === 0,
        `${moved.length} answers moved on ${differing.length} lines (${[...perEntry.entries()].sort((a, b) => b[1] - a[1]).map(([entry, count]) => `${entry} ${count}`).join(', ')}). A verdict that changes because a guard now sees what it could not is a row of EXPECTED_CHANGES, added by the captain; anything else is a fault of the change to the reader the entry names`,
      )
      const shown = differing.slice(0, SHOWN)
      const base = BASE === undefined || shown.length === 0 ? null : await judgedBy(resolve(BASE), shown, scratch)
      for (const at of shown) {
        console.log(`\n    line ${at}: ${JSON.stringify(cut(corpus[at] as string, 300))}`)
        for (const row of moved.filter(one => one.at === at)) {
          console.log(`      ${row.entry} — recorded ${row.was}, now ${row.now}`)
          if (base !== null) console.log(`        recorded: ${cut(base.readings[String(at)]?.[row.column] ?? '(the base tree did not answer)', LONGEST_SHOWN)}`)
          console.log(`        now:      ${cut((readings[String(at)] as string[])[row.column] as string, LONGEST_SHOWN)}`)
        }
      }
      if (differing.length > 0 && base === null) note(`the recording holds a digest an answer; to print what the base answered beside each, name a tree at the base: bun ${SELF} --base <tree>`)
      if (differing.length > SHOWN) note(`${differing.length - SHOWN} more lines differ; --lines ${differing.slice(SHOWN, SHOWN + 40).join(',')} reads the next ones`)
      if (LINES === undefined) check('each row of EXPECTED_CHANGES was met in this run', met.size === EXPECTED_CHANGES.length, `${EXPECTED_CHANGES.length - met.size} were not`)
      if (EXPECTED_CHANGES.length > 0) {
        section(`(3) the verdicts that changed on purpose — ${EXPECTED_CHANGES.length}`)
        for (const change of EXPECTED_CHANGES) console.log(`    ${change.kind} · ${change.entry} · ${JSON.stringify(cut(change.line, 120))}\n      base: ${change.base}\n      now:  ${change.now}\n      ${change.why}`)
      }
    }
  }
  removeScratch(scratch)
  console.log('\n============================================================')
  if (failures === 0) {
    console.log(RECORD ? ' RECORDED' : ` READERS RECORDING GREEN (${checks} checks)`)
    process.exit(0)
  }
  console.log(` ${failures} READERS RECORDING FAILURE(S)`)
  process.exit(1)
}

const ROOT = process.env.READERS_RECORDING_ROOT
const HOME = join(ROOT, 'home', 'Users', FAKE_USER)
const CONFIG = join(ROOT, 'config')
const PROJECT = join(ROOT, 'work', 'outer', 'middle', 'project')
const SRC = join(TREE, 'src')
const PAD = ` #${'x'.repeat(10_050)}`
const LONG_NAME = 'n'.repeat(300)
if (homedir() !== HOME) {
  process.stderr.write(`${SELF}: the scratch home did not take (os.homedir() is ${homedir()}, wanted ${HOME})\n`)
  process.exit(98)
}

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
for (const folder of ['.git', 'sub', 'build', 'secrets/deep', 'docs', '.mercury']) mkdirSync(join(PROJECT, folder), { recursive: true })
for (const file of ['x', 'notes.txt', 'a.txt', 'b.txt', 'list', 'AGENTS.md', 'docs/plain.md', 'sub/notes.txt']) put(PROJECT, file, `${file}\n`)
for (const file of ['hidden.key', 'sub/hidden.key', 'secrets/k.txt', 'secrets/deep/inner.txt', '.mercury/settings.local.json', '.env', '.env.local', 'node_modules/.bin/tsc']) put(PROJECT, file, 'K\n')
put(PROJECT, 'MERCURY.md', '# instructions\n')
for (const folder of ['.gnupg', '.kube', '.docker', '.config/gh', 'Library/Keychains', 'Library/Caches', 'Documents']) mkdirSync(join(HOME, folder), { recursive: true })
for (const file of ['.ssh/authorized_keys', '.ssh/id_ed25519', '.aws/credentials', '.netrc', '.npmrc', '.git-credentials', 'vault/k.txt']) put(HOME, file, 'STAND-IN\n')
for (const file of ['.credentials.json', '.provider-secrets.json', 'mcp-auth.json', 'browser-secrets.json']) put(CONFIG, file, '{"secret":"STAND-IN"}\n')
put(CONFIG, 'runtime/current/mercury.mjs', 'export {}\n')
mkdirSync(join(CONFIG, 'daemon'), { recursive: true })
if (process.platform !== 'win32') {
  symlinkSync(join(PROJECT, 'secrets', 'k.txt'), join(PROJECT, 'link-to-k'))
  symlinkSync(join(PROJECT, 'secrets'), join(PROJECT, 'link-to-dir'))
  symlinkSync(join(CONFIG, '.credentials.json'), join(PROJECT, 'link-creds'))
}

process.chdir(PROJECT)
process.argv.splice(1, process.argv.length, 'readers-recording')
Object.defineProperty(process, 'pid', { value: OWN_PID, configurable: true })
Object.defineProperty(process, 'execPath', { value: '/usr/local/bin/bun', configurable: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS', 'MERCURY_SPAWNED_BY', 'MERCURY_TREE_SCAN_CEILING']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getEmptyToolPermissionContext } = await import(join(SRC, 'Tool.ts'))
const { enableConfigs } = await import(join(SRC, 'utils/config.ts'))
const { setOriginalCwd, setCwdState, setProjectRoot, setSessionTrustAccepted } = await import(join(SRC, 'bootstrap/state.ts'))
const { registerWardsGuard, WARDS_HOOK_ID } = await import(join(SRC, 'guards/wardsGuard.ts'))
const { judgeToolCall } = await import(join(SRC, 'guards/guards.ts'))
const { runWithCwdOverride } = await import(join(SRC, 'utils/cwd.ts'))
const { BashTool } = await import(join(SRC, 'tools/BashTool/BashTool.tsx'))
const { PowerShellTool } = await import(join(SRC, 'tools/PowerShellTool/PowerShellTool.tsx'))
const ast = await import(join(SRC, 'utils/bash/ast.ts'))
const commands = await import(join(SRC, 'utils/bash/commands.ts'))
const { ParsedCommand } = await import(join(SRC, 'utils/bash/ParsedCommand.ts'))
const door = await import(join(SRC, 'utils/permissions/decision/commandAnalysis.ts'))
const wardsRead = await import(join(SRC, 'utils/wards/wardsShellRead.ts'))
const floors = await import(join(SRC, 'utils/permissions/shellProtectedPaths.ts'))
const { flowShellAsk } = await import(join(SRC, 'utils/permissions/flowLaw.ts'))
const { denyRuleReach } = await import(join(SRC, 'tools/BashTool/denyRuleReach.ts'))
const { decideToolPermissionWithModes } = await import(join(SRC, 'utils/permissions/decision/wrapper.ts'))
const { getDenyRules } = await import(join(SRC, 'utils/permissions/decision/rules.ts'))
const bashPermissions = await import(join(SRC, 'tools/BashTool/bashPermissions.ts'))
const { checkPermissionMode } = await import(join(SRC, 'tools/BashTool/modeValidation.ts'))
const { hardenedGitRead } = await import(join(SRC, 'tools/AgentTool/reviewerPolicy.ts'))
const serviceInput = await import(join(SRC, 'utils/permissions/serviceInputHistory.ts'))
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(PROJECT)
setCwdState(PROJECT)
setProjectRoot(PROJECT)

const spellings = (path: string): string[] => [path, path.toLowerCase()].flatMap(spelled => [spelled, spelled.replaceAll('/', '\\\\'), spelled.replaceAll('/', '\\')])
const NAMED: Array<[string, string]> = ([[PROJECT, '<project>'], [HOME, '<home>'], [CONFIG, '<config>'], [ROOT, '<scratch>'], [dirname(ROOT), '<above>'], [dirname(dirname(ROOT)), '<above 2>']] as Array<[string, string]>).flatMap(([path, word]) => [...new Set(spellings(path))].map(spelled => [spelled, word] as [string, string]))
const LEAVES = [PROJECT, HOME, CONFIG].map(spellings)
const STEM = 9
const CUT_END = /^(?:…|\\?"|$)/

function cutPathsNamed(text: string): string {
  let out = text
  for (let spelling = 0; spelling < 6; spelling++) {
    const leaves = LEAVES.map(leaf => leaf[spelling] as string)
    const stem = (leaves[0] as string).slice(0, STEM)
    for (let at = out.indexOf(stem); at !== -1; at = out.indexOf(stem, at + 1)) {
      let longest = 0
      for (const leaf of leaves) {
        let same = 0
        while (same < leaf.length && out[at + same] === leaf[same]) same++
        longest = Math.max(longest, same)
      }
      if (CUT_END.test(out.slice(at + longest, at + longest + 2))) out = `${out.slice(0, at)}<scratch, cut at ${longest}>${out.slice(at + longest)}`
    }
  }
  return out
}

const named = (text: string): string => cutPathsNamed(NAMED.reduce((out, [path, word]) => out.replaceAll(path, word), text))
const filled = (line: string): string =>
  line.replaceAll('<HOME>', HOME).replaceAll('<USER>', FAKE_USER).replaceAll('<PROJECT>', PROJECT).replaceAll('<CONFIG>', CONFIG).replaceAll('<DAEMON_PID>', String(OWN_PID)).replaceAll('<OWN_PID>', String(OWN_PID)).replaceAll('<PAD>', PAD).replaceAll('<LONG>', LONG_NAME)
const asLists = (_key: string, value: unknown): unknown => (value instanceof Map ? { entries: [...value] } : value instanceof Set ? { values: [...value] } : value)

const spent: Record<string, number> = {}
async function answered(entry: string, run: () => unknown): Promise<{ text: string; value: unknown }> {
  const started = performance.now()
  let value: unknown
  try {
    value = await run()
  } catch (error) {
    value = { threw: error instanceof Error ? error.message : String(error) }
  }
  spent[entry] = (spent[entry] ?? 0) + performance.now() - started
  return { text: named(JSON.stringify(value === undefined ? null : value, asLists) ?? 'null'), value }
}

function contextOf(mode: string, deny: readonly string[]): Record<string, unknown> {
  return { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign', alwaysDenyRules: deny.length > 0 ? { localSettings: [...deny] } : {}, alwaysAllowRules: {}, alwaysAskRules: {} }
}

const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string(), cwd: z.string().optional() }),
  checkPermissions: (input: { command: string; cwd?: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashPermissions.bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
} as never

async function decided(command: string, mode: string, deny: readonly string[]): Promise<unknown> {
  const state = { toolPermissionContext: contextOf(mode, deny) }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: { tools: [] }, readFileState: new Map() } as never
  const outcome = await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'readers-recording' } } as never, 'readers-recording')
  return { decision: outcome.decision, decidedBy: outcome.wrapper?.decidedBy }
}

type Reach = Awaited<ReturnType<typeof denyRuleReach>>
type Rule = ReturnType<typeof getDenyRules>[number]
type Budget = { left: number; unsettled?: boolean }
const LEAVES_AS_IT_WAS = /^(?:cat|ls|grep|rg|head|tail|wc|stat|file|diff|git (?:status|log|diff|show|grep|blame|cat-file))(?:\s|$)/

async function reached(command: string): Promise<unknown> {
  const context = contextOf('default', DENY)
  const rules: Rule[] = getDenyRules(context as never)
  const bashRuleFor = (candidate: string): Rule | null => {
    for (const rule of rules) {
      const content = rule.ruleValue.ruleContent
      if (rule.ruleValue.toolName !== 'Bash' || content === undefined) continue
      const prefix = content.replace(/ \*$/, '')
      if (candidate === prefix || candidate.startsWith(`${prefix} `)) return rule
    }
    return null
  }
  const run = (text: string, folder: string, depth: number, budget: Budget): Promise<Reach> =>
    denyRuleReach(text, folder, context as never, {
      judge: async (inner: string, at: string, left: Budget) => {
        const refused = bashRuleFor(inner)
        if (refused !== null) return { denied: { behavior: 'deny', message: `the judge refuses ${inner}`, decisionReason: { type: 'rule', rule: refused } } as never, hidden: null }
        const below = await run(inner, at, depth + 1, left)
        return below.denied !== null ? { denied: below.denied, hidden: null } : { denied: null, hidden: below.hidden, unread: below.unread ?? null }
      },
      bashDenyRule: bashRuleFor,
      optionNamedWrites: () => [],
      readOnly: async (text: string) => LEAVES_AS_IT_WAS.test(text),
    }, depth, budget)
  const budget: Budget = { left: 96 }
  const result = await run(command, PROJECT, 0, budget)
  return { result, left: budget.left, unsettled: budget.unsettled === true }
}

const TOOLS: Record<string, unknown> = { Bash: BashTool, PowerShell: PowerShellTool }
let armed = 0
function armWards(): string {
  const session = `readers-recording-${++armed}`
  const hook = runWithCwdOverride(PROJECT, () => registerWardsGuard((() => {}) as never, session))
  if (hook !== WARDS_HOOK_ID) throw new Error(`the wards guard did not engage for ${session}: ${String(hook)}`)
  return session
}
let judgedCalls = 0
function warded(command: string, tool: 'Bash' | 'PowerShell'): Promise<unknown> {
  const session = armWards()
  return runWithCwdOverride(PROJECT, () => judgeToolCall(session, { tool, input: { command }, callId: `readers-recording-${++judgedCalls}`, messages: [], toolRef: TOOLS[tool] as never, asksAnswerable: true }))
}

const NOT_KNOWN = /__mercury_unknown|[$`\uFFFC]/
const programsOf = (names: Iterable<string>): string[] => [...new Set([...names].filter(name => name !== '').map(name => (NOT_KNOWN.test(name) ? '(set at run time)' : name)))].sort()

function astPrograms(parsed: { kind: string; reason?: string; commands?: Array<{ argv: string[] }> }): Programs {
  if (parsed.kind !== 'simple') return { read: false, why: parsed.reason ?? parsed.kind }
  const names: string[] = []
  for (const simple of door.shellCCommands(parsed.commands)) {
    const peeled = ast.peelWrappers(simple.argv)
    names.push(wardsRead.programOf(simple.argv[0] ?? ''))
    if (Array.isArray(peeled)) names.push(wardsRead.programOf(peeled[0] ?? ''))
  }
  return { read: true, programs: programsOf(names) }
}

function wardsPrograms(read: { threw?: string; unread?: { why: string }; commands: Array<{ argv: string[] }> }): Programs {
  if (read.threw !== undefined) return { read: false, why: `threw: ${read.threw}` }
  if (read.unread !== undefined) return { read: false, why: read.unread.why }
  return { read: true, programs: programsOf(read.commands.flatMap(command => wardsRead.layersOf(command.argv).map((layer: { program: string }) => layer.program))) }
}

const world = { cwd: PROJECT, home: HOME, homesRoot: dirname(HOME), ownNames: [FAKE_USER] }
const readingOf = (read: { commands: unknown; pipelineSizes: unknown; exported: unknown; homes: unknown; unread: unknown }): unknown => ({ commands: read.commands, pipelineSizes: read.pipelineSizes, exported: read.exported, homes: read.homes, unread: read.unread })
const seen: Record<string, Seen> = {}

async function posixReadings(command: string, at: number): Promise<string[]> {
  const out = new Map<string, string>()
  const keep = async (entry: string, run: () => unknown): Promise<unknown> => {
    const { text, value } = await answered(entry, run)
    out.set(entry, text)
    return value
  }
  let parsed: { kind: string; commands?: unknown[] } = { kind: 'parse-unavailable' }
  await door.withBashParseScope(async () => {
    parsed = (await keep('parseForSecurity', async () => {
      const result = await ast.parseForSecurity(command)
      await door.prepareShellCScripts(result)
      return result
    })) as typeof parsed
    await keep('checkSemantics', () => (parsed.kind === 'simple' ? ast.checkSemantics(parsed.commands) : null))
    await keep('splitCommand', () => [commands.splitCommand(command), commands.splitCommandWithOperators(command), commands.splitListSegments(command)])
    await keep('extractOutputRedirections', () => commands.extractOutputRedirections(command))
    await keep('analyzeCommand', async () => {
      const whole = await ParsedCommand.parse(command)
      return whole === null ? null : { pipes: whole.getPipeSegments(), plain: whole.withoutOutputRedirections(), writes: whole.getOutputRedirections(), analysis: whole.getTreeSitterAnalysis() }
    })
    await keep('prefix', () => [bashPermissions.getSimpleCommandPrefix(command), bashPermissions.getFirstWordPrefix(command)])
    await keep('checkPermissionMode', () => [checkPermissionMode({ command }, contextOf('default', []) as never), checkPermissionMode({ command }, contextOf('implement', []) as never)])
    const rewritten = await keep('rewriteReadOnlyGitCommand', () => bashPermissions.rewriteReadOnlyGitCommand(command, PROJECT))
    await keep('hardenedGitRead', () => hardenedGitRead(BashTool, { command: typeof rewritten === 'string' ? rewritten : command }))
  })
  await keep('serviceInput', async () => {
    const service = serviceInput.serviceInputKey(PROJECT, `readers-recording-${at}`)
    serviceInput.noteServiceInput(service, 'run', command, true)
    return serviceInput.serviceInputAsSent(service, '', 'run')
  })
  const read = await keep('readShellCommands:posix', async () => readingOf(await wardsRead.readShellCommands(command, 'posix', world)))
  await keep('readShellCommands:powershell', async () => readingOf(await wardsRead.readShellCommands(command, 'powershell', world)))
  const ward = (await keep('wards:Bash', () => warded(command, 'Bash'))) as { refused?: boolean; reason?: string }
  await keep('wards:PowerShell', () => warded(command, 'PowerShell'))
  await keep('floors:bash', async () => [await floors.shellSelfProtectionReason(command, false, PROJECT), await floors.shellMercurySecretPath(command, false, PROJECT), await floors.shellCredentialWritePath(command, false, PROJECT)])
  await keep('floors:powershell', async () => [await floors.shellSelfProtectionReason(command, true, PROJECT), await floors.shellMercurySecretPath(command, true, PROJECT), await floors.shellCredentialWritePath(command, true, PROJECT)])
  await keep('flowShellAsk:bash', () => flowShellAsk(command, PROJECT, 'bash'))
  await keep('flowShellAsk:powershell', () => flowShellAsk(command, PROJECT, 'powershell'))
  await keep('denyRuleReach', () => reached(command))
  const doors: unknown[] = []
  for (const [name, mode, deny] of DOORS) doors.push(await keep(name, () => decided(command, mode, deny)))
  if (DISAGREE !== undefined) {
    const plain = (doors[0] as { decision?: { behavior?: string; message?: string } }).decision
    const wardWord = ward.refused === true ? `the wards refuse it (${/Ward '([^']+)'/.exec(ward.reason ?? '')?.[1] ?? 'unnamed'})` : 'the wards let it pass'
    seen[String(at)] = { ast: astPrograms(parsed as never), wards: wardsPrograms(read as never), meets: `${plain?.behavior ?? 'threw'}${plain?.message ? `: ${cut(named(plain.message).replaceAll('\n', ' '), 110)}` : ''}; ${wardWord}` }
  }
  return POSIX_ENTRIES.map(entry => out.get(entry) ?? 'null')
}

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as string[]
const own = JSON.parse(readFileSync(join(ROOT, 'lines.json'), 'utf8')) as number[]
const readings: Record<string, string[]> = {}
for (const at of own) readings[String(at)] = await posixReadings(filled(corpus[at] as string), at)
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
process.env.USERPROFILE = 'C:\\Users\\operator'
for (const at of own) {
  const command = filled(corpus[at] as string)
  ;(readings[String(at)] as string[]).push((await answered('windows:wards:Bash', () => warded(command, 'Bash'))).text, (await answered('windows:wards:PowerShell', () => warded(command, 'PowerShell'))).text)
}
if (platform) Object.defineProperty(process, 'platform', platform)
process.env.USERPROFILE = HOME
writeFileSync(join(ROOT, 'judged.json'), JSON.stringify({ readings, seen, spent } satisfies Judged))
process.exit(0)
