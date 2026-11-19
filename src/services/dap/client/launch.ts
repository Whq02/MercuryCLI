import type { DapAdapterSpec, DapBreakpointSpec } from './shared.js'

export type DapStartOptions = {
  program: string
  args?: string[]
  runtimeArgs?: string[]
  launchExtras?: Record<string, unknown>
  env?: Record<string, string>
  module?: string
  stopOnEntry?: boolean
  breakpoints?: Map<string, Array<number | DapBreakpointSpec>>
  mode?: 'launch' | 'attach'
  pid?: number
  port?: number
  host?: string
  noDebug?: boolean
}

export function startBodyOf(spec: DapAdapterSpec, cwd: string, options: DapStartOptions, attach: boolean): Record<string, unknown> {
  let startBody: Record<string, unknown>
  if (attach) {
    const host = options.host ?? '127.0.0.1'
    if (spec.buildAttachArgs) {
      startBody = spec.buildAttachArgs({
        program: options.program,
        cwd: cwd,
        ...(options.host !== undefined ? { host: options.host } : {}),
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.pid !== undefined ? { pid: options.pid } : {}),
      })
    } else if (spec.attachShape === 'connect' && options.port !== undefined) {
      startBody = { ...(spec.attachDefaults ?? {}), connect: { host, port: options.port } }
    } else {
      startBody = {
        ...(spec.attachDefaults ?? {}),
        ...(options.pid !== undefined ? { pid: options.pid } : {}),
        ...(options.port !== undefined ? { port: options.port, host } : {}),
        ...(options.program && options.pid === undefined && options.port === undefined
          ? { program: options.program }
          : {}),
      }
    }
  } else {
    startBody = spec.buildLaunchArgs?.({
      program: options.program,
      args: options.args,
      cwd: cwd,
      stopOnEntry: options.stopOnEntry,
    }) ?? {
      ...(spec.launchDefaults ?? {}),
      ...(options.launchExtras ?? {}),
      ...(options.module !== undefined ? { module: options.module } : { program: options.program }),
      args: options.args ?? [],
      ...(options.runtimeArgs !== undefined ? { runtimeArgs: options.runtimeArgs } : {}),
      ...(options.env !== undefined
        ? { env: spec.envShape === 'pairs' ? Object.entries(options.env).map(([key, value]) => `${key}=${value}`) : options.env }
        : {}),
      cwd: cwd,
      stopOnEntry: options.stopOnEntry ?? false,
      noDebug: options.noDebug ?? false,
      console: 'internalConsole',
    }
  }
  return startBody
}
