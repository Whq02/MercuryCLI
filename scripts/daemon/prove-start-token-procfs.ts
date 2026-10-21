#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' the process start token on Linux comes from /proc, spelled as ps -o lstart= spells it, and no process is spawned to read it')
console.log('============================================================')

const { getProcessStartToken, getProcessStartTokenAsync, linuxProcessStartToken, lstartWords } = await import('../../src/daemon/ownerWatch.ts')
const { parseProcessStartToken } = await import('../../src/daemon/processSweep.ts')

const fixedStat = '4242 (bun) S 1 4242 4242 0 -1 4194560 970 542 0 0 0 0 0 0 20 0 1 0 12068008 3874816 680 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20'
const boot = 1_792_438_460
const expected = lstartWords(new Date((boot + Math.floor(12068008 / 100)) * 1000))
check('a stat line yields the boot time plus the start ticks over the Linux clock rate, spelled like lstart', linuxProcessStartToken(4242, () => fixedStat, boot) === expected, `${linuxProcessStartToken(4242, () => fixedStat, boot)} ≠ ${expected}`)
check('…and the spelling parses back to that second', Math.abs(parseProcessStartToken(expected) - (boot + 120680) * 1000) < 1000, String(parseProcessStartToken(expected)))
check('a command name with parentheses and spaces does not move the field', linuxProcessStartToken(1, () => '1 (a (b) c) S 0 1 1 0 -1 4194560 1 1 0 0 0 0 0 0 20 0 1 0 500 1 1 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20', 1000) === lstartWords(new Date((1000 + 5) * 1000)))
const gone = Object.assign(new Error('no such file'), { code: 'ENOENT' })
check("a pid with no /proc entry reads as gone ('')", linuxProcessStartToken(999999, () => { throw gone }, boot) === '')
const refused = Object.assign(new Error('denied'), { code: 'EACCES' })
check('a /proc entry that cannot be read is unknown (null), never a death verdict', linuxProcessStartToken(1, () => { throw refused }, boot) === null)
check('a day under ten is padded with a space, as ps prints it', /^Mon Mar  2 00:00:00 2026$/.test(lstartWords(new Date(2026, 2, 2, 0, 0, 0))), lstartWords(new Date(2026, 2, 2, 0, 0, 0)))

if (process.platform === 'linux') {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 300))
  const pid = child.pid!
  const ps = (spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout ?? '').trim()
  const token = getProcessStartToken(pid)
  const asyncToken = await getProcessStartTokenAsync(pid)
  check(`the live token equals ps -o lstart= for pid ${pid}`, token !== null && token !== '' && token === ps, `${token} ≠ ${ps}`)
  check('the async reader says the same', asyncToken === token, `${asyncToken} ≠ ${token}`)
  child.kill('SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 300))
  check('a reaped pid reads as gone', getProcessStartToken(pid) === '' || getProcessStartToken(pid) === null, String(getProcessStartToken(pid)))
} else {
  console.log(`  [SKIP] the live comparison against ps runs on Linux only (this is ${process.platform}); the parser rows above hold everywhere`)
}

console.log(failures === 0 ? '\nprove-start-token-procfs: ALL LAWS HOLD' : `\nprove-start-token-procfs: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
