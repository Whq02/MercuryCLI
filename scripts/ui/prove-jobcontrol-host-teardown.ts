import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCaptureDriver } from '../lib/captureDriver.ts'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const arg = process.argv.indexOf('--host-script')
const hostScript = arg < 0 ? join(root, 'scripts', 'ui', 'jobcontrol-host.py') : resolve(process.argv[arg + 1]!)

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`skip: jobcontrol-host.py is POSIX-only (${driver.kind})`)
  process.exit(0)
}
const pythonBin = driver.python

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const scratch = realpathSync(mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'jc-teardown-')))

try {
  const pidLog = join(scratch, 'shell-pid.txt')
  const okShell = join(scratch, 'ok-shell.py')
  writeFileSync(
    okShell,
    [
      `#!${pythonBin}`,
      'import os, sys, time',
      `open(${JSON.stringify(pidLog)}, "w").write(str(os.getpid()))`,
      'sys.stdout.write("host$ READY\\r\\n")',
      'sys.stdout.flush()',
      'time.sleep(5)',
      '',
    ].join('\n'),
  )
  chmodSync(okShell, 0o755)

  {
    const cfgPath = join(scratch, 'ok.cfg.json')
    const repPath = join(scratch, 'ok.rep.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        cols: 80,
        rows: 24,
        command: 'true',
        steps: [{ wait: 'READY', timeout: 5 }],
        budgetSeconds: 10,
      }),
    )
    const res = spawnSync(pythonBin, [hostScript, cfgPath, repPath], {
      encoding: 'utf8',
      timeout: 8000,
      killSignal: 'SIGKILL',
      env: { ...process.env, JOBCONTROL_HOST_SHELL: okShell },
    })
    const rep = existsSync(repPath) ? (JSON.parse(readFileSync(repPath, 'utf8')) as { endReason?: string }) : null
    check(
      'normal shell session writes its report and exits cleanly',
      res.status === 0 && res.signal === null && rep?.endReason === 'steps-done',
      `status=${res.status} signal=${res.signal} endReason=${rep?.endReason}`,
    )
  }

  {
    rmSync(pidLog, { force: true })
    const hookDir = join(scratch, 'pyhook')
    mkdirSync(hookDir, { recursive: true })
    writeFileSync(
      join(hookDir, 'sitecustomize.py'),
      [
        'import atexit, os, time',
        'if os.environ.get("JC_SIMULATE_CHILD_IN_EXIT") == "1":',
        '    _real_waitpid = os.waitpid',
        `    _pid_file = ${JSON.stringify(pidLog)}`,
        '    def _target_pid():',
        '        try:',
        '            return int(open(_pid_file).read().strip())',
        '        except Exception:',
        '            return -1',
        '    def _wedged_waitpid(pid, options):',
        '        if pid > 0 and pid == _target_pid():',
        '            if options == 0:',
        '                time.sleep(30)',
        '                return _real_waitpid(pid, 0)',
        '            return (0, 0)',
        '        return _real_waitpid(pid, options)',
        '    os.waitpid = _wedged_waitpid',
        '    @atexit.register',
        '    def _cleanup():',
        '        tp = _target_pid()',
        '        if tp > 1:',
        '            try:',
        '                _real_waitpid(tp, os.WNOHANG)',
        '            except OSError:',
        '                pass',
        '',
      ].join('\n'),
    )
    const cfgPath = join(scratch, 'wedged.cfg.json')
    const repPath = join(scratch, 'wedged.rep.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        cols: 80,
        rows: 24,
        command: 'true',
        steps: [{ wait: 'READY', timeout: 5 }],
        budgetSeconds: 10,
        teardownSeconds: 0.4,
      }),
    )
    const pyPath = [hookDir, process.env.PYTHONPATH ?? ''].filter(Boolean).join(delimiter)
    const t0 = Date.now()
    const res = spawnSync(pythonBin, [hostScript, cfgPath, repPath], {
      encoding: 'utf8',
      timeout: 2500,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        JOBCONTROL_HOST_SHELL: okShell,
        JC_SIMULATE_CHILD_IN_EXIT: '1',
        PYTHONPATH: pyPath,
      },
    })
    const elapsedMs = Date.now() - t0
    if (existsSync(pidLog)) {
      const pid = Number(readFileSync(pidLog, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
    const rep = existsSync(repPath) ? (JSON.parse(readFileSync(repPath, 'utf8')) as { endReason?: string }) : null
    check(
      'a child stuck in kernel exit does not hang jobcontrol-host.py forever in blocking waitpid',
      res.status === 0 && res.signal === null && elapsedMs < 2000 && rep?.endReason === 'steps-done',
      `status=${res.status} signal=${res.signal} elapsedMs=${elapsedMs} endReason=${rep?.endReason}`,
    )
  }

  {
    const hostSrc = readFileSync(hostScript, 'utf8')
    check(
      'teardown closes the PTY master fd, sends SIGCONT beside SIGKILL for stopped children, and bounds waitpid with WNOHANG',
      hostSrc.includes('os.close(fd)') && hostSrc.includes('signal.SIGCONT') && hostSrc.includes('os.WNOHANG'),
      'missing os.close(fd), SIGCONT, or WNOHANG in jobcontrol-host.py teardown',
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
