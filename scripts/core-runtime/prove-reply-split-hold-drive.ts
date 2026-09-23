#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, childEnv, DIST, endLeg, finish, printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.ts'

const driver = requireCaptureDriver('reply-split-hold-drive')
const HOST = join(ROOT, 'scripts', 'core-runtime', 'reply-split-host.py')
const COMPOSER_UP = '? for shortcuts'
const HEAD = '\x1b[?64;1;2;6;9;15;18;21;'
const TAIL = '22c'
const GAP_MS = Number(process.env.PROOF_REPLY_GAP_MS ?? '70')
const LEAK = ['[?64', '22c', ';18;21;']

console.log(`reply split hold drive: ${scratch} (dist: ${DIST}; the terminal answers CSI c in two writes ${GAP_MS} ms apart — past the 50 ms flush, inside the two-flush hold)`)

type Report = {
  marks: Record<string, string[]>
  final: string[]
  events: Array<Record<string, unknown>>
  sawQueryAt: number | null
  alive: boolean
}

async function runHost(cfg: Record<string, unknown>, tag: string): Promise<{ report: Report | null; status: number | null; stderr: string }> {
  const cfgPath = join(scratch, `${tag}-host.json`)
  const reportPath = join(scratch, `${tag}-report.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const stderr: string[] = []
  const status = await new Promise<number | null>(resolve => {
    const child = spawn(driver.python, [HOST, cfgPath, reportPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', chunk => stderr.push(String(chunk)))
    child.on('exit', code => resolve(code))
    child.on('error', () => resolve(null))
  })
  const report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Report) : null
  return { report, status, stderr: stderr.join('') }
}

const leg = await startLeg('reply-split', [{ kind: 'text', text: 'Finished.' }], null)
try {
  const debugLog = join(scratch, 'reply-split-debug.log')
  const env = childEnv(leg, { MERCURY_FULLSCREEN: '0', MERCURY_DESKTOP_DRIVER: 'none', MERCURY_CRITTER: 'clam' })
  const cfg = {
    cols: 120,
    rows: 40,
    cwd: leg.cwd,
    argv: [productNode(), DIST, '--chat', `--debug-file=${debugLog}`],
    env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)),
    budgetSeconds: 90,
    steps: [
      { wait: COMPOSER_UP, timeout: 60 },
      { sleep: 1.5 },
      { mark: 'composer-up' },
      { reply: { head: HEAD, gapMs: GAP_MS, tail: TAIL } },
      { sleep: 1.5 },
      { mark: 'after-reply' },
      { send: 'zz' },
      { sleep: 1.0 },
      { mark: 'after-typing' },
    ],
  }
  const { report, status, stderr } = await runHost(cfg, 'reply-split')
  check('the host ran the bundle in a pseudo-terminal and reported', report !== null && status === 0, `status=${status} ${stderr.slice(-400)}`)
  if (report !== null) {
    const up = report.marks['composer-up'] ?? []
    const after = report.marks['after-reply'] ?? []
    const typed = report.marks['after-typing'] ?? []
    printFrame('the composer before the reply (inline, 120x40)', up.filter(r => r !== ''))
    printFrame('after the split device-attributes reply', after.filter(r => r !== ''))
    check('the bundle asked the terminal for its device attributes at boot (CSI c seen on the pty)', report.sawQueryAt !== null, JSON.stringify(report.events.slice(0, 6)))
    check('the composer was up before the reply', up.some(r => r.includes(COMPOSER_UP)), up.filter(r => r !== '').slice(-6).join('\n'))
    const leaked = after.filter(r => LEAK.some(needle => r.includes(needle)))
    console.log(`  observed: ${leaked.length} row(s) carry the reply's bytes after the split reply`)
    check('nothing of the split reply is typed into the prompt', leaked.length === 0, leaked.join('\n'))
    check('the loop still hears the keyboard after the reply (zz typed into the composer)', typed.some(r => r.includes('❯ zz')), typed.filter(r => r.includes('❯')).join('\n'))
    const log = existsSync(debugLog) ? readFileSync(debugLog, 'utf8') : ''
    const settled = log.includes('XTVERSION query ignored by the terminal') || log.includes('Terminal identified via XTVERSION')
    console.log(`  observed: the boot query batch ${settled ? 'settled' : 'never settled'} (${log.length} bytes of debug log)`)
    check('the split reply closed the boot query batch (the probe is not lost)', settled, log.split('\n').filter(l => /XTVERSION|kitty|DECRQM|Synchronized/i.test(l)).slice(0, 5).join(' | ') || 'no probe line in the log')
  }
} finally {
  await endLeg(leg)
}

finish('reply-split-hold-drive')
