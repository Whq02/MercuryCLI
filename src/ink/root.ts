// The public mount API: the synchronous mount, the default async mount
// (which preserves the historical microtask boundary), and the root
// factory that separates instance creation from rendering.

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
}

export type Root = {
  render: (node: ReactNode) => void
  unmount: (error?: Error | number | null) => void
  waitUntilExit: () => Promise<void>
}

function resolveOptions(options: NodeJS.WriteStream | RenderOptions = {}): InkOptions {
  // A stream as the second argument is the output stream with the
  // process's input.
  if (isStream(options)) {
    return {
      stdout: options,
      stdin: process.stdin,
      stderr: process.stderr,
      exitOnCtrlC: true,
      patchConsole: true,
    }
  }
  const resolved: InkOptions = {
    stdout: options.stdout ?? process.stdout,
    stdin: options.stdin ?? process.stdin,
    stderr: options.stderr ?? process.stderr,
    exitOnCtrlC: options.exitOnCtrlC ?? true,
    patchConsole: options.patchConsole ?? true,
  }
  if (options.onFrame) resolved.onFrame = options.onFrame
  return resolved
}

function isStream(value: unknown): value is NodeJS.WriteStream {
  return typeof value === 'object' && value !== null && 'write' in value
}

function getInstance(stdout: NodeJS.WriteStream, create: () => Ink): Ink {
  let instance = instances.get(stdout)
  if (!instance) {
    instance = create()
    instances.set(stdout, instance)
  }
  return instance
}

export function renderSync(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Instance {
  const inkOptions = resolveOptions(options)
  const instance = getInstance(inkOptions.stdout, () => new Ink(inkOptions))
  instance.render(node)
  return {
    rerender: instance.render.bind(instance),
    unmount: instance.unmount,
    waitUntilExit: instance.waitUntilExit.bind(instance),
    cleanup: () => instances.delete(inkOptions.stdout),
  }
}

/** The microtask boundary the former asynchronous layout-engine load
 *  provided: without it the first render fires before asynchronous startup
 *  work settles and the scrollback write overwrites instead of appending. */
export default async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  await Promise.resolve()
  const instance = renderSync(node, options)
  logForDebugging(`ink render mounted ${Math.round(process.uptime() * 1000)}ms after process start`)
  return instance
}

export async function createRoot(options?: RenderOptions): Promise<Root> {
  await Promise.resolve()
  const inkOptions = resolveOptions(options)
  const instance = new Ink(inkOptions)
  instances.set(inkOptions.stdout, instance)
  return {
    render: instance.render.bind(instance),
    unmount: instance.unmount,
    waitUntilExit: instance.waitUntilExit.bind(instance),
  }
}
