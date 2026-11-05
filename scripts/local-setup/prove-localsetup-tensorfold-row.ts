#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

const framesAt = process.argv.indexOf('--frames')
const FRAMES = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })
const home = pinScratchHome('localsetup-tensorfold-row')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { runLocalSetupRoad } = await import('../../src/services/localSetup/ggufRoad.ts')
const helm = await import('../../src/utils/cockpit/helmFocus.ts')
const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
type Plan = { label: string; rows?: readonly { tag: string; words: string }[] }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}

async function firstStep(platform: NodeJS.Platform, answer: unknown): Promise<{ plan?: Plan; reason?: string }> {
  let plan: Plan | undefined
  let reason: string | undefined
  const consent = async (row: Plan): Promise<never> => {
    if (row.label === '1') plan = row
    return answer as never
  }
  for await (const event of runLocalSetupRoad(consent as never, { platform, home, configHome: home, currentModel: () => 'local/old' } as never)) {
    if (event.type === 'done') reason = event.summary.reason
  }
  return { ...(plan !== undefined ? { plan } : {}), ...(reason !== undefined ? { reason } : {}) }
}

console.log('§1 step 1 of /localsetup: four rows on darwin and linux, three on win32')
for (const platform of ['darwin', 'linux', 'win32'] as const) {
  const { plan } = await firstStep(platform, 'stop')
  const tags = plan?.rows?.map(row => row.tag) ?? []
  const want = platform === 'win32' ? ['Hugging Face', 'Bank', 'Ollama / running server'] : ['Hugging Face', 'Bank', 'Ollama / running server', 'TensorFold']
  check(`${platform}: ${want.length} rows (${want.join(' · ')})`, tags.join('|') === want.join('|'), tags.join('|'))
}
{
  const mac = (await firstStep('darwin', 'stop')).plan?.rows?.find(row => row.tag === 'TensorFold')?.words
  const linux = (await firstStep('linux', 'stop')).plan?.rows?.find(row => row.tag === 'TensorFold')?.words
  check("the pointer's words: this Mac on macOS, the NVIDIA GPU on Linux", mac === 'serve an MLX model on this Mac · /tensorfold' && linux === "serve an MLX model on this machine's NVIDIA GPU · /tensorfold", `${mac} | ${linux}`)
}

console.log('§2 picking it opens /tensorfold: the road ends, the popup closes, /tensorfold is the command the chat runs')
{
  popup.openSettingsPopup({ view: 'localsetup', width: () => 80, rows: 20, line: '', hint: '', body: () => null } as never)
  const picked = await firstStep('darwin', { pick: 'TensorFold' })
  check('the road ends without a download or a server', picked.reason === 'stopped', String(picked.reason))
  check('the /localsetup popup is closed', !popup.isSettingsPopupOpen())
  check('/tensorfold is dispatched', helm.consumeCommandDispatch() === '/tensorfold')
}

console.log('§3 the frame: the pointer as the last row of step 1 (DESIGN 25)')
{
  const React = await import('react')
  const h = React.createElement
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const { dialogRoadFrom, localSetupPopupRequest } = await import('../../src/commands/localsetup/localsetup.tsx')
  for (const [columns, rows] of [[160, 48], [110, 34], [96, 30]] as const) {
    const road = dialogRoadFrom((consent, signal) => runLocalSetupRoad(consent as never, { platform: 'darwin', home, configHome: home, ...(signal !== undefined ? { signal } : {}) } as never) as never)
    const m = await mountOffscreen(h(AppStateProvider as never, {} as never, h(ThemeProvider as never, {} as never, h(SettingsPopupSlot as never, { overlay: true } as never))), columns, rows)
    popup.openSettingsPopup(localSetupPopupRequest(road))
    const seen = await waitFor(() => m.screen().includes('TensorFold'), 8000)
    for (const key of [KEY.down, KEY.down, KEY.down, KEY.down]) {
      m.push(key)
      await settle(160)
    }
    await settle(200)
    const lines = m.lines()
    const row = lines.find(line => line.includes('TensorFold')) ?? ''
    check(`${columns}x${rows}: step 1 lists the TensorFold row with its words`, seen && /TensorFold\s+serve an MLX model on this Mac · \/tensorfold/.test(row), row.trim())
    check(`${columns}x${rows}: nothing is pre-chosen and the cursor reaches it fourth, last`, /[›❯]\s*TensorFold/.test(row), row.trim())
    if (FRAMES !== undefined) writeFileSync(join(FRAMES, `25-localsetup-pointer-${columns}x${rows}.txt`), `${lines.join('\n')}\n`)
    m.unmount()
    popup.closeSettingsPopup()
    await settle(80)
  }
}

await releaseScratchHome(home)
console.log(failures === 0 ? '\nprove-localsetup-tensorfold-row: ALL GREEN' : `\nprove-localsetup-tensorfold-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
