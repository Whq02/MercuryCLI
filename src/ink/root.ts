import type { ReactNode } from 'react'
import { logForDebugging } from '../utils/debug.js'
import type { FrameEvent } from './frame.js'
import Ink, { type Options as InkOptions } from './ink.js'
import instances from './instances.js'
import { nextMicrotask } from '../utils/timers.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type RenderOptions = Unbuilt

export type Instance = Unbuilt

export type Root = Unbuilt

const isStream = (value: unknown): value is NodeJS.WriteStream => typeof value === 'object' && value !== null && 'write' in value

const processKnobs = (stdout: NodeJS.WriteStream): InkOptions => ({ stdout, stdin: process.stdin, stderr: process.stderr, exitOnCtrlC: true, patchConsole: true })

function knobsFor(options: NodeJS.WriteStream | RenderOptions = {}): InkOptions {
  if (isStream(options)) return processKnobs(options)
  const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value != null)) as Partial<InkOptions>
  return { ...processKnobs(process.stdout), ...given }
}

type Seat = 'reuse' | 'fresh'

function mount(options: NodeJS.WriteStream | RenderOptions | undefined, seat: Seat): { engine: Ink; stdout: NodeJS.WriteStream } {
  const knobs = knobsFor(options)
  const engine = (seat === 'reuse' ? instances.get(knobs.stdout) : undefined) ?? new Ink(knobs)
  instances.set(knobs.stdout, engine)
  return { engine, stdout: knobs.stdout }
}

const rootDoors = (engine: Ink): Root => ({ render: engine.render.bind(engine), unmount: engine.unmount, waitUntilExit: engine.waitUntilExit.bind(engine) })

export function renderSync(node: ReactNode, options?: NodeJS.WriteStream | RenderOptions): Instance {
  const { engine, stdout } = mount(options, 'reuse')
  engine.render(node)
  const { render, unmount, waitUntilExit } = rootDoors(engine)
  const forgetOwnSeat = (): void => {
    if (instances.get(stdout) === engine) instances.delete(stdout)
  }
  return { rerender: render, unmount, waitUntilExit, cleanup: forgetOwnSeat, lastFrame: engine.lastFrameText.bind(engine) }
}

const sinceProcessStartMs = (): number => Math.round(process.uptime() * 1000)

export default async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  return notBuilt('src/ink/root.ts:64')
}

export async function createRoot(options?: RenderOptions): Promise<Root> {
  await nextMicrotask()
  return rootDoors(mount(options, 'fresh').engine)
}
