#!/usr/bin/env bun
import { mock } from 'bun:test'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', '..', 'src')
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
const HINT = 'check launchChat in src/boot/chatLauncher.tsx and surfaceRoute subscription for warmSessionRunner asks on boot-settings and concourse transitions'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${[detail, HINT].filter(Boolean).join('; ')}` : ''}`)
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

const asks: string[] = []
const ensurePath = join(SRC, 'daemon/switchboard/ensureDaemon.ts')
const ensure = await import(ensurePath)
mock.module(ensurePath, () => ({
  ...ensure,
  ensureOwnedDaemon: async () => true,
  warmSessionRunner: async (dir: string) => {
    asks.push(dir)
    return true
  },
}))

const { launchChat } = await import(join(SRC, 'boot/chatLauncher.tsx'))
const route = await import(join(SRC, 'screen/routes/surfaceRoute.ts'))
const { getCwd } = await import(join(SRC, 'platform/files/cwd.ts'))

type Step = { did: string; from: string; to: string; kind: string; asked: number }
const steps: Step[] = []
let atRender = -1
const step = async (did: string, move: () => unknown): Promise<void> => {
  const from = route.surfaceRouteId(route.currentSurfaceRoute())
  const before = asks.length
  move()
  await settle()
  const now = route.currentSurfaceRoute()
  steps.push({ did, from, to: route.surfaceRouteId(now), kind: now.kind, asked: asks.length - before })
}
const fakeRender = async (): Promise<void> => {
  await settle()
  atRender = asks.length
  await step('to the chat', () => route.enterRootChat())
  await step('the boot face', () => route.enterBootSettings())
  await step('the boot face while it stands', () => route.enterBootSettings())
  await step('Session Manager', () => route.enterConcourse())
  await step('Session Manager while it stands', () => route.enterConcourse())
  await step('to the chat', () => route.enterRootChat())
  await step('the boot face a second time', () => route.enterBootSettings())
  await step('leave it', () => route.leaveCurrentSurface())
  await step('the boot face a third time', () => route.enterBootSettings())
  await step('Session Manager a second time', () => route.enterConcourse())
}

await launchChat({ probe: true } as never, { getFpsMetrics: () => undefined, initialState: {} as never }, {} as never, fakeRender as never)
await settle()
const afterLaunch = asks.length
route.leaveCurrentSurface()
route.enterBootSettings()
route.enterConcourse()
await settle()

console.log('the launcher asks for a warm runner at its start, and again each time the boot face or Session Manager is shown')
check('one ask before the first frame, for the launch folder', atRender === 1 && asks[0] === getCwd(), `${atRender} ${asks[0]}`)
for (const s of steps) {
  const moved = s.from !== s.to
  const wanted = moved && (s.kind === 'boot-settings' || s.kind === 'concourse') ? 1 : 0
  check(`${s.did}: ${s.from} → ${s.to}: ${wanted === 1 ? 'one ask' : 'no ask'}`, s.asked === wanted, `asked ${s.asked}`)
}
check('the walk showed the boot face at least twice and Session Manager at least twice', steps.filter(s => s.from !== s.to && s.kind === 'boot-settings').length >= 2 && steps.filter(s => s.from !== s.to && s.kind === 'concourse').length >= 2, JSON.stringify(steps.map(s => s.to)))
check('every ask names the launch folder', asks.every(dir => dir === getCwd()), JSON.stringify(asks))
check('after the screen has ended the launcher asks no more', asks.length === afterLaunch, `${afterLaunch} → ${asks.length}`)

console.log(failures === 0 ? '\nprove-warm-ask-at-new-session-doors: green' : `\nprove-warm-ask-at-new-session-doors: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
