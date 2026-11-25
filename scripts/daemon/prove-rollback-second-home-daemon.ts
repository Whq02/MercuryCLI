#!/usr/bin/env bun
import { stageRollbackScene } from './rollbackScene.ts'

if (process.platform === 'win32') {
  console.log('prove-rollback-second-home-daemon: [SKIP] the staged release install is the POSIX one')
  process.exit(0)
}

const scene = stageRollbackScene()
const { was, next } = scene
const second = scene.otherHome(2)
const shown = (text: string): void => console.log(text.split('\n').map(line => `    | ${line}`).join('\n'))

const THE_VERDICT = 'screenIsOlder in src/daemon/control/handshake.ts: the installed build decides before the version word does'
let failures = 0
const check = (label: string, ok: boolean, detail = '', fix = THE_VERDICT): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix ${fix}`}`)
}

console.log('============================================================')
console.log(' after a rollback, a second home is told what is installed')
console.log('============================================================')
try {
  const up = await scene.runningNext([second])
  check(`the staged install runs v${next} with v${was} kept behind it, and the second home's daemon is up on v${next}`, up.ok, up.detail)

  const rolled = await scene.rollBack([second])
  check(`the first home rolls back to v${was}`, rolled.said.status === 0 && rolled.said.out.includes(`rolled back: ${next} → ${was}`), rolled.said.out)
  check('the rollback names no one version for every window still open', rolled.said.out.includes('window still open keeps working on the version it started with') && !/keeps working on v\d/.test(rolled.said.out), rolled.said.out, 'OPEN_WINDOWS_LINE in src/commands/verbs/update.ts')
  check('the second home\'s daemon logs the build the install moved back to', rolled.logged, rolled.detail)

  const status = scene.run(second.env, ['daemon', 'status'])
  shown(status.out)
  check(`a new start under the second home, v${was}, is not told that it is not the installed build`, status.status === 0 && !status.out.includes('not the installed build'), status.out)
  const restart = scene.run(second.env, ['daemon', 'restart'])
  shown(restart.out)
  check(`its daemon restart does not call v${next} installed`, !restart.out.includes(`v${next} is installed`), restart.out)
  check(`its daemon restart lands the daemon on v${was}`, restart.status === 0 && restart.out.includes(`v${was}`), `exit ${restart.status}: ${restart.out}`)
  const after = scene.run(second.env, ['daemon', 'status'])
  shown(after.out)
  check(`the daemon that answers afterwards is v${was}`, after.out.includes(`v${was}`) && !after.out.includes(`v${next}`), after.out)
} finally {
  scene.end()
}

console.log(failures === 0 ? '\nprove-rollback-second-home-daemon: ALL HOLD' : `\nprove-rollback-second-home-daemon: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
