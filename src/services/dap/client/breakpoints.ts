import type { DapSession } from '../dapClient.js'
import {
  BREAKPOINT_REQUEST_TIMEOUT_MS,
  type DapBreakpointSpec,
  type DapBreakpointVerdict,
  type DapDataAccessType,
  type DapDataBreakpointInfo,
  type DapDataBreakpointSpec,
  type DapFunctionBreakpointSpec,
  type DapInstructionBreakpointSpec,
  type DapWriteMemoryReceipt,
} from './shared.js'

export async function setBreakpoints(
  session: DapSession,
  path: string,
  breakpoints: Array<number | DapBreakpointSpec>,
): Promise<Array<{ line: number; verified: boolean; message?: string; id?: number }>> {
  const specs: DapBreakpointSpec[] = breakpoints.map(b =>
    typeof b === 'number' ? { line: b } : b,
  )
  const body = await session.request(
    'setBreakpoints',
    {
      source: { path },
      breakpoints: specs.map(s => ({
        line: s.line,
        ...(s.column !== undefined ? { column: s.column } : {}),
        ...(s.condition !== undefined ? { condition: s.condition } : {}),
        ...(s.hitCondition !== undefined ? { hitCondition: s.hitCondition } : {}),
        ...(s.logMessage !== undefined ? { logMessage: s.logMessage } : {}),
      })),
      sourceModified: false,
    },
    BREAKPOINT_REQUEST_TIMEOUT_MS,
  )
  const reported = Array.isArray(body.breakpoints)
    ? (body.breakpoints as Array<{ verified?: boolean; line?: number; message?: string; id?: number }>)
    : []
  const verified = specs.map((s, i) => ({
    line: reported[i]?.line ?? s.line,
    verified: reported[i]?.verified === true,
    ...(typeof reported[i]?.id === 'number' ? { id: reported[i]?.id } : {}),
    ...(typeof reported[i]?.message === 'string' ? { message: reported[i]?.message } : {}),
  }))
  if (verified.length === 0) session.breakpoints.delete(path)
  else session.breakpoints.set(path, verified)
  return verified
}

export async function setFunctionBreakpoints(session: DapSession, specs: DapFunctionBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
  const body = await session.request(
    'setFunctionBreakpoints',
    {
      breakpoints: specs.map(s => ({
        name: s.name,
        ...(s.condition !== undefined ? { condition: s.condition } : {}),
        ...(s.hitCondition !== undefined ? { hitCondition: s.hitCondition } : {}),
      })),
    },
    BREAKPOINT_REQUEST_TIMEOUT_MS,
  )
  const verdicts = breakpointVerdicts(body, specs.length)
  session.functionBreakpoints = specs.map((s, i) => ({
    name: s.name,
    verified: verdicts[i]?.verified === true,
    ...(typeof verdicts[i]?.id === 'number' ? { id: verdicts[i]?.id } : {}),
    ...(typeof verdicts[i]?.message === 'string' ? { message: verdicts[i]?.message } : {}),
  }))
  return verdicts
}

function breakpointVerdicts(body: Record<string, unknown>, count: number): DapBreakpointVerdict[] {
  const reported = Array.isArray(body.breakpoints)
    ? (body.breakpoints as Array<{ verified?: boolean; message?: string; id?: number }>)
    : []
  return Array.from({ length: count }, (_, i) => ({
    verified: reported[i]?.verified === true,
    ...(typeof reported[i]?.id === 'number' ? { id: reported[i]?.id } : {}),
    ...(typeof reported[i]?.message === 'string' ? { message: reported[i]?.message } : {}),
  }))
}

export async function dataBreakpointInfo(
  session: DapSession,
  args: {
    name: string
    variablesReference?: number
    frameId?: number
  },
): Promise<DapDataBreakpointInfo> {
  const body = await session.request('dataBreakpointInfo', {
    name: args.name,
    ...(args.variablesReference !== undefined ? { variablesReference: args.variablesReference } : {}),
    ...(args.frameId !== undefined ? { frameId: args.frameId } : {}),
  })
  const accessTypes = Array.isArray(body.accessTypes)
    ? (body.accessTypes as unknown[]).filter(
        (t): t is DapDataAccessType => t === 'read' || t === 'write' || t === 'readWrite',
      )
    : undefined
  return {
    dataId: typeof body.dataId === 'string' && body.dataId.length > 0 ? body.dataId : null,
    description: typeof body.description === 'string' ? body.description : '',
    ...(accessTypes !== undefined ? { accessTypes } : {}),
    ...(typeof body.canPersist === 'boolean' ? { canPersist: body.canPersist } : {}),
  }
}

export async function setDataBreakpoints(session: DapSession, specs: DapDataBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
  const body = await session.request(
    'setDataBreakpoints',
    {
      breakpoints: specs.map(s => ({
        dataId: s.dataId,
        ...(s.accessType !== undefined ? { accessType: s.accessType } : {}),
        ...(s.condition !== undefined ? { condition: s.condition } : {}),
        ...(s.hitCondition !== undefined ? { hitCondition: s.hitCondition } : {}),
      })),
    },
    BREAKPOINT_REQUEST_TIMEOUT_MS,
  )
  return breakpointVerdicts(body, specs.length)
}

export async function setInstructionBreakpoints(session: DapSession, specs: DapInstructionBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
  const body = await session.request(
    'setInstructionBreakpoints',
    {
      breakpoints: specs.map(s => ({
        instructionReference: s.instructionReference,
        ...(s.offset !== undefined ? { offset: s.offset } : {}),
        ...(s.condition !== undefined ? { condition: s.condition } : {}),
        ...(s.hitCondition !== undefined ? { hitCondition: s.hitCondition } : {}),
      })),
    },
    BREAKPOINT_REQUEST_TIMEOUT_MS,
  )
  return breakpointVerdicts(body, specs.length)
}

export async function writeMemory(
  session: DapSession,
  args: {
    memoryReference: string
    data: string
    offset?: number
    allowPartial?: boolean
  },
): Promise<DapWriteMemoryReceipt> {
  const body = await session.request('writeMemory', {
    memoryReference: args.memoryReference,
    data: args.data,
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
    ...(args.allowPartial !== undefined ? { allowPartial: args.allowPartial } : {}),
  })
  return {
    ...(typeof body.offset === 'number' ? { offset: body.offset } : {}),
    ...(typeof body.bytesWritten === 'number' ? { bytesWritten: body.bytesWritten } : {}),
  }
}

export function applyBreakpointEvent(session: DapSession, body: Record<string, unknown>): void {
  const bp =
    (body.breakpoint as { id?: number; line?: number; verified?: boolean; message?: string } | undefined) ?? {}
  for (const rows of session.breakpoints.values()) {
    for (const row of rows) {
      const idMatch = typeof bp.id === 'number' && row.id === bp.id
      const lineMatch = typeof bp.id !== 'number' && typeof bp.line === 'number' && row.line === bp.line
      if (idMatch || lineMatch) {
        if (bp.verified === true) row.verified = true
        if (typeof bp.line === 'number') row.line = bp.line
        if (typeof bp.message === 'string') row.message = bp.message
      }
    }
  }
  for (const row of session.functionBreakpoints) {
    if (typeof bp.id === 'number' && row.id === bp.id) {
      if (bp.verified === true) row.verified = true
      if (typeof bp.message === 'string') row.message = bp.message
    }
  }
}
