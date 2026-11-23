import { expandPath } from '../../../platform/files/path.js'
import type { DapBreakpointSpec, DapDataBreakpointSpec, DapFunctionBreakpointSpec, DapSession } from '../../../integrations/debugger/dapClient.js'
import type { Input, InputWith, OpResult } from './schema.js'
import { instructionLabel, verdictText } from './shared.js'

export async function breakpointsOp(r: { session: DapSession }, input: InputWith<'file'>, requested: DapBreakpointSpec[]): Promise<OpResult> {
  const verified = await r.session.setBreakpointsTree(expandPath(input.file), requested)
  if (requested.length === 0) {
    return {
      result: `breakpoints on ${input.file}: 0 breakpoints — cleared on every session of the tree (a later child session inherits none)`,
      outcome: 'succeeded',
      details: { breakpoints: verified },
    }
  }
  const detail = verified
    .map(
      b =>
        `line ${b.line}: ${
          b.verified
            ? `verified${b.verifier && b.verifier !== r.session.label ? ` by ${b.verifier}` : ''}`
            : 'UNVERIFIED'
        }${b.message ? ` (${b.message})` : ''}`,
    )
    .join(', ')
  return {
    result: `breakpoints on ${input.file}: ${detail || '(none reported)'}`,
    outcome: 'succeeded',
    details: { breakpoints: verified },
  }
}

export async function functionBreakpointsOp(r: { session: DapSession }, specs: DapFunctionBreakpointSpec[]): Promise<OpResult> {
  const verified = await r.session.setFunctionBreakpointsTree(specs)
  if (specs.length === 0) {
    return {
      result: 'function breakpoints cleared on every session of the tree (a later child session inherits none)',
      outcome: 'succeeded',
      details: { functionBreakpoints: [] },
    }
  }
  const detail = specs
    .map((s, i) => {
      const v = verified[i]
      const spelled = `${s.name}${s.condition !== undefined ? ` if ${s.condition}` : ''}${s.hitCondition !== undefined ? ` hits ${s.hitCondition}` : ''}`
      return `${spelled}: ${
        v?.verified ? `verified${v.verifier && v.verifier !== r.session.label ? ` by ${v.verifier}` : ''}` : 'UNVERIFIED'
      }${v?.message ? ` (${v.message})` : ''}`
    })
    .join(', ')
  return {
    result: `function breakpoints: ${detail}`,
    outcome: 'succeeded',
    details: { functionBreakpoints: verified },
  }
}

export async function dataBreakpointsOp(r: { root: DapSession; target: DapSession }, input: InputWith<'dataBreakpoints'>): Promise<OpResult> {
  const resolved: Array<{ name: string; spec: DapDataBreakpointSpec }> = []
  const refused: string[] = []
  for (const want of input.dataBreakpoints) {
    const info = await r.target.dataBreakpointInfo({
      name: want.name,
      variablesReference: want.variablesReference,
      frameId: want.frameId,
    })
    if (info.dataId === null) {
      refused.push(`${want.name}: refused by adapter${info.description ? ` (${info.description})` : ''}`)
      continue
    }
    const accessType = want.accessType ?? 'write'
    if (info.accessTypes && info.accessTypes.length > 0 && !info.accessTypes.includes(accessType)) {
      refused.push(`${want.name} (${accessType}): refused — adapter allows ${info.accessTypes.join('/')} only`)
      continue
    }
    resolved.push({
      name: want.name,
      spec: {
        dataId: info.dataId,
        accessType,
        ...(want.condition !== undefined ? { condition: want.condition } : {}),
        ...(want.hitCondition !== undefined ? { hitCondition: want.hitCondition } : {}),
      },
    })
  }
  if (resolved.length === 0) {
    return { result: `data breakpoints: nothing armed — ${refused.join(', ')}`, outcome: 'failed' }
  }
  const verdicts = await r.target.setDataBreakpoints(resolved.map(x => x.spec))
  const detail = resolved.map((x, i) => `${x.name} (${x.spec.accessType}): ${verdictText(verdicts[i])}`)
  return {
    result: `data breakpoints: ${[...detail, ...refused].join(', ')}`,
    outcome: 'succeeded',
    details: {
      dataBreakpoints: resolved.map((x, i) => ({
        name: x.name,
        dataId: x.spec.dataId,
        accessType: x.spec.accessType,
        verified: verdicts[i]?.verified === true,
      })),
      refused,
    },
  }
}

export async function instructionBreakpointsOp(r: { root: DapSession; target: DapSession }, input: InputWith<'instructionBreakpoints'>): Promise<OpResult> {
  const verdicts = await r.target.setInstructionBreakpoints(input.instructionBreakpoints)
  const detail = input.instructionBreakpoints
    .map((b, i) => `${instructionLabel(b)}: ${verdictText(verdicts[i])}`)
    .join(', ')
  return {
    result: `instruction breakpoints: ${detail}`,
    outcome: 'succeeded',
    details: {
      instructionBreakpoints: input.instructionBreakpoints.map((b, i) => ({
        instructionReference: b.instructionReference,
        offset: b.offset ?? 0,
        verified: verdicts[i]?.verified === true,
      })),
    },
  }
}

export function exceptionBreakpointsOp(r: { root: DapSession; target: DapSession }, input: Input): OpResult | Promise<OpResult> {
  const available = Array.isArray(r.target.capabilities?.exceptionBreakpointFilters)
    ? (r.target.capabilities!.exceptionBreakpointFilters as Array<{
        filter?: string
        label?: string
        default?: boolean
      }>)
    : []
  if (!input.filters) {
    return {
      result: available.length
        ? 'available exception filters:\n' +
          available
            .map(f => `${f.filter}: ${f.label ?? ''}${f.default ? ' (default)' : ''}`)
            .join('\n') +
          '\n\nRe-run with filters: ["<id>", …] to arm (empty array disarms all).'
        : `adapter '${r.target.adapterKey}' advertises no exception filters`,
      outcome: 'no-change',
    }
  }
  const known = new Set(available.map(f => f.filter))
  const unknown = input.filters.filter(f => !known.has(f))
  if (unknown.length > 0 && available.length > 0) {
    return {
      result: `unknown exception filter(s): ${unknown.join(', ')} — available: ${[...known].join(', ')}`,
      outcome: 'failed',
    }
  }
  return armExceptionFilters(r, input as InputWith<'filters'>)
}

async function armExceptionFilters(r: { root: DapSession; target: DapSession }, input: InputWith<'filters'>): Promise<OpResult> {
  await r.target.request('setExceptionBreakpoints', { filters: input.filters })
  return {
    result: input.filters.length
      ? `exception breakpoints armed: ${input.filters.join(', ')}`
      : 'exception breakpoints disarmed',
    outcome: 'succeeded',
  }
}
