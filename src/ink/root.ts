import type { ReactNode } from 'react'
import { logForDebugging } from '../utils/debug.js'
import type { FrameEvent } from './frame.js'
import Ink, { type Options as InkOptions } from './ink.js'
import instances from './instances.js'

export type RenderOptions = {
  stdout?: NodeJS.WriteStream
  stdin?: NodeJS.ReadStream
  stderr?: NodeJS.WriteStream
  exitOnCtrlC?: boolean
  patchConsole?: boolean
  onFrame?: (event: FrameEvent) => void
}

export type Instance = {
  rerender: (node: ReactNode) => void
  unmount: (error?: Error | number | null) => void
  waitUntilExit: () => Promise<void>
  cleanup: () => void
  lastFrame: () => string
}

export type Root = {
  render: (node: ReactNode) => void
  unmount: (error?: Error | number | null) => void
  waitUntilExit: () => Promise<void>
}

const isStream = (value: unknown): value is NodeJS.WriteStream => typeof value === 'object' && value !== null && 'write' in value

const onProcessStreams = (stdout: NodeJS.WriteStream): InkOptions => ({
  stdout,
  stdin: process.stdin,
  stderr: process.stderr,
  exitOnCtrlC: true,
  patchConsole: true,
})

const givenKnobs = (options: RenderOptions): Partial<InkOptions> =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value != null)) as Partial<InkOptions>

function resolveOptions(options: NodeJS.WriteStream | RenderOptions = {}): InkOptions {
  return isStream(options) ? onProcessStreams(options) : { ...onProcessStreams(process.stdout), ...givenKnobs(options) }
}

function registered(stdout: NodeJS.WriteStream, instance: Ink): Ink {
  instances.set(stdout, instance)
  return instance
}

const doorsOf = (instance: Ink): Pick<Instance, 'unmount' | 'waitUntilExit'> => ({
  unmount: instance.unmount,
  waitUntilExit: instance.waitUntilExit.bind(instance),
})

export function renderSync(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Instance {
  const resolved = resolveOptions(options)
  const instance = instances.get(resolved.stdout) ?? registered(resolved.stdout, new Ink(resolved))
  instance.render(node)
  return {
    rerender: instance.render.bind(instance),
    ...doorsOf(instance),
    cleanup: () => void instances.delete(resolved.stdout),
    lastFrame: instance.lastFrameText.bind(instance),
  }
}

const sinceProcessStartMs = (): number => Math.round(process.uptime() * 1000)

export default async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  await Promise.resolve()
  const instance = renderSync(node, options)
  logForDebugging(`ink render mounted ${sinceProcessStartMs()}ms after process start`)
  return instance
}

export async function createRoot(options?: RenderOptions): Promise<Root> {
  await Promise.resolve()
  const resolved = resolveOptions(options)
  const instance = registered(resolved.stdout, new Ink(resolved))
  return { render: instance.render.bind(instance), ...doorsOf(instance) }
}
