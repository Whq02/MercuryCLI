#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tensorfold-app-engine-proof-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const app = await import('../../src/services/providers/local/tensorfoldApp.ts')
const hosts = await import('../../src/services/providers/local/tensorfoldHosts.ts')

const APP = '/Applications/TensorFold.app/Contents/MacOS/TensorFold'
const ENGINE = '/Applications/TensorFold.app/Contents/Resources/engine/tensorfold-native'
const PS_APP_SERVING = [
  '    1     0 /sbin/launchd       /sbin/launchd',
  `  900     1 ${APP}  ${APP}`,
  `  901   900 ${APP}  ${APP} --type=utility`,
  `  950   901 ${ENGINE}  ${ENGINE} serve TensorFold/Qwen3.8-27B-MLX-4bit --host 127.0.0.1 --port 53121 --name qwen3.8-27b --drafter z-lab/Qwen3.8-27B-DFlash2`,
  '  960     1 /opt/homebrew/bin/tensorfold-native  /opt/homebrew/bin/tensorfold-native serve mlx-community/Qwen3.5-2B-MLX-4bit --port 8087 --name qwen3.5-2b',
].join('\n')
const PS_APP_IDLE = ['    1     0 /sbin/launchd       /sbin/launchd', `  900     1 ${APP}  ${APP}`].join('\n')
const PS_HAND_STARTED = ['    1     0 /sbin/launchd       /sbin/launchd', '  960   500 /opt/homebrew/bin/tensorfold-native  /opt/homebrew/bin/tensorfold-native serve mlx-community/Qwen3.5-2B-MLX-4bit --port 8087 --name qwen3.5-2b', '  500     1 -zsh  -zsh'].join('\n')

section('§1 the app\'s engine is told from a hand-started server by process, never by owned_by')
{
  const serving = app.tensorFoldAppStateOf(app.parseProcessRows(PS_APP_SERVING))
  check('the app is running and its engine is the tensorfold-native under the app bundle', serving.running && serving.engine?.pid === 950 && serving.engine.model === 'qwen3.8-27b' && serving.engine.port === 53121, JSON.stringify(serving))
  check('the hand-started server beside it is not taken for the app\'s', serving.engine?.pid !== 960)
  const idle = app.tensorFoldAppStateOf(app.parseProcessRows(PS_APP_IDLE))
  check('the app without an engine: running, serving nothing', idle.running && idle.engine === undefined, JSON.stringify(idle))
  const hand = app.tensorFoldAppStateOf(app.parseProcessRows(PS_HAND_STARTED))
  check('a server started by hand from a shell is not the app', !hand.running && hand.engine === undefined, JSON.stringify(hand))
  check('an empty process list: nothing', !app.tensorFoldAppStateOf([]).running)
  check('the served name reads --name, else the repo\'s last path element', app.engineServedName('serve TensorFold/Qwen3.8-27B-MLX-4bit --name qwen3.8-27b') === 'qwen3.8-27b' && app.engineServedName('serve TensorFold/Qwen3.8-27B-MLX-4bit --port 1') === 'Qwen3.8-27B-MLX-4bit')
}

section('§2 the words: the app is serving X · paste or quit; a second copy refused; never a pairable row')
{
  const serving = app.tensorFoldAppStateOf(app.parseProcessRows(PS_APP_SERVING))
  check('the app-is-serving words', app.appServingWords(serving) === 'the app is serving qwen3.8-27b · paste from its API tab · s serve with Mercury instead (quit the app first — two copies won\'t fit)', app.appServingWords(serving))
  check('a second copy is refused while the app serves', app.refuseSecondCopy(serving) === app.TENSORFOLD_SECOND_COPY_REFUSAL)
  check('nothing refused when the app is idle', app.refuseSecondCopy({ running: true }) === undefined)
  await hosts.rememberTensorFoldHost({ name: 'the app', baseUrl: 'http://127.0.0.1:53121', origin: 'app', key: 'app-session-key', serving: 'qwen3.8-27b' })
  await hosts.rememberTensorFoldHost({ name: 'studio', baseUrl: 'http://studio.local:8080', origin: 'lan-paired', key: 'k', serving: 'qwen3.8-27b' })
  check('the app host is remembered for its pasted base URL and key', hosts.tensorFoldHosts().some(host => host.origin === 'app') && hosts.tensorFoldHostKey('http://127.0.0.1:53121/v1') === 'app-session-key')
  check('the app host is never pairable; the paired Mac is', hosts.pairableTensorFoldHosts().map(host => host.name).join(',') === 'studio')
  const detected = await app.detectTensorFoldApp({ processes: async () => app.parseProcessRows(PS_APP_SERVING) })
  check('detectTensorFoldApp reads the injected process list', detected.engine?.port === 53121)
}

section('§3 the live process list on this machine answers without throwing')
{
  const live = await app.detectTensorFoldApp({ processes: app.listProcesses })
  check('a state comes back', typeof live.running === 'boolean')
}

console.log(`\nprove-tensorfold-app-engine: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
