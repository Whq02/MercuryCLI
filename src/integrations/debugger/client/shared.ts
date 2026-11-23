import type { Socket } from 'node:net'

export type DapLaunchOptions = {
  program: string
  args?: string[]
  cwd: string
  stopOnEntry?: boolean
}

export type DapBreakpointSpec = {
  line: number
  column?: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

export type DapFunctionBreakpointSpec = {
  name: string
  condition?: string
  hitCondition?: string
}

export type DapDataAccessType = 'read' | 'write' | 'readWrite'

export type DapDataBreakpointSpec = {
  dataId: string
  accessType?: DapDataAccessType
  condition?: string
  hitCondition?: string
}

export type DapInstructionBreakpointSpec = {
  instructionReference: string
  offset?: number
  condition?: string
  hitCondition?: string
}

export type DapBreakpointVerdict = {
  verified: boolean
  message?: string
  id?: number
}

export type DapDataBreakpointInfo = {
  dataId: string | null
  description: string
  accessTypes?: DapDataAccessType[]
  canPersist?: boolean
}

export type DapWriteMemoryReceipt = {
  offset?: number
  bytesWritten?: number
}

export type DapListenerTarget = { host: string; port: number }

export type DapListenerDial = { socket: Socket } | { refused: string }

export type DapAdapterSpec = {
  command: string
  args: string[]
  installHint?: string
  buildLaunchArgs?: (options: DapLaunchOptions) => Record<string, unknown>
  preflightError?: string
  buildAttachArgs?: (options: {
    program: string
    cwd: string
    host?: string
    port?: number
    pid?: number
  }) => Record<string, unknown>
  connect?: 'stdio' | 'tcp'
  fileTypes?: string[]
  rootMarkers?: string[]
  launchDefaults?: Record<string, unknown>
  attachDefaults?: Record<string, unknown>
  attachShape?: 'connect' | 'flat'
  startRequest?: 'launch' | 'attach'
  envShape?: 'object' | 'pairs'
}

export type Pending = {
  resolve: (body: Record<string, unknown>) => void
  reject: (err: Error) => void
  cancelDeadline: () => void
  command: string
}

export const CLIENT_INIT_ARGS = {
  clientID: 'mercury',
  linesStartAt1: true,
  columnsStartAt1: true,
  pathFormat: 'path',
  supportsRunInTerminalRequest: true,
  supportsStartDebuggingRequest: true,
} as const

export type StoppedInfo = {
  reason: string
  threadId: number | undefined
  description?: string
}

export const REQUEST_TIMEOUT_MS = 8_000
export const BREAKPOINT_REQUEST_TIMEOUT_MS = 30_000
export const OUTPUT_RING_MAX = 200
