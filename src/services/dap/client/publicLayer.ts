import type { DapSession } from '../dapClient.js'
import {
  dataBreakpointInfo,
  setBreakpoints,
  setDataBreakpoints,
  setFunctionBreakpoints,
  setInstructionBreakpoints,
  writeMemory,
} from './breakpoints.js'
import { disconnectArguments } from './life.js'
import type {
  DapBreakpointSpec,
  DapBreakpointVerdict,
  DapDataBreakpointInfo,
  DapDataBreakpointSpec,
  DapFunctionBreakpointSpec,
  DapInstructionBreakpointSpec,
  DapWriteMemoryReceipt,
} from './shared.js'
import {
  debuggeeEndDetail,
  debugTarget,
  root,
  treeExitDetail,
  treeNewestStopStamp,
  treeSessions,
  treeStopped,
  treeVerifiedBreakpoints,
  treeVerifiedFunctionBreakpoints,
} from './tree.js'

export abstract class DapSessionPublicLayer {
  root(this: DapSession): DapSession {
    return root(this)
  }

  treeSessions(this: DapSession): DapSession[] {
    return treeSessions(this)
  }

  treeSize(this: DapSession): number {
    return this.treeSessions().length
  }

  treeStopped(this: DapSession, sinceStamp = 0): DapSession | null {
    return treeStopped(this, sinceStamp)
  }

  treeNewestStopStamp(this: DapSession): number {
    return treeNewestStopStamp(this)
  }

  treeVerifiedBreakpoints(this: DapSession): Map<
    string,
    Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>
  > {
    return treeVerifiedBreakpoints(this)
  }

  acceptsFunctionBreakpoints(this: DapSession): boolean {
    return this.capabilities === null || this.capabilities.supportsFunctionBreakpoints === true
  }

  treeVerifiedFunctionBreakpoints(this: DapSession): Array<{ name: string; verified: boolean; message?: string; id?: number; verifier?: string }> {
    return treeVerifiedFunctionBreakpoints(this)
  }

  treeExitDetail(this: DapSession): string {
    return treeExitDetail(this)
  }

  debuggeeEndDetail(this: DapSession): string {
    return debuggeeEndDetail(this)
  }

  debugTarget(this: DapSession): { session: DapSession } | { ambiguousDetail: string } {
    return debugTarget(this)
  }

  setBreakpoints(
    this: DapSession,
    path: string,
    breakpoints: Array<number | DapBreakpointSpec>,
  ): Promise<Array<{ line: number; verified: boolean; message?: string; id?: number }>> {
    return setBreakpoints(this, path, breakpoints)
  }

  setFunctionBreakpoints(this: DapSession, specs: DapFunctionBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
    return setFunctionBreakpoints(this, specs)
  }

  dataBreakpointInfo(this: DapSession, args: {
    name: string
    variablesReference?: number
    frameId?: number
  }): Promise<DapDataBreakpointInfo> {
    return dataBreakpointInfo(this, args)
  }

  setDataBreakpoints(this: DapSession, specs: DapDataBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
    return setDataBreakpoints(this, specs)
  }

  setInstructionBreakpoints(this: DapSession, specs: DapInstructionBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
    return setInstructionBreakpoints(this, specs)
  }

  writeMemory(this: DapSession, args: {
    memoryReference: string
    data: string
    offset?: number
    allowPartial?: boolean
  }): Promise<DapWriteMemoryReceipt> {
    return writeMemory(this, args)
  }

  disconnectArguments(this: DapSession): Record<string, unknown> {
    return disconnectArguments(this)
  }
}
