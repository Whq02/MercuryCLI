
import type { Tool } from '../../Tool.js'
import { isToolDefaultFn } from '../../Tool.js'
import { isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type FailClosedAction = {
  content: ReadonlyArray<{ type: string; name?: string }>
}
export type FailClosedLookup = { get(name: string): Tool | undefined }

export function classifierFailClosedEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_CLASSIFIER_FAIL_CLOSED'))
}

export const FAIL_CLOSED_REASON =
  'Tool declares no classifier-relevant input and did not override the security projection — blocking for safety (set toAutoClassifierInput, or unset MERCURY_CLASSIFIER_FAIL_CLOSED)'

export function isDefaultProjectorTool(tool: Tool | null | undefined): boolean {
  return tool != null && isToolDefaultFn(tool.toAutoClassifierInput)
}

export function shouldFailClosedOnEmptyProjection(
  tool: Tool | null | undefined,
): boolean {
  return classifierFailClosedEnabled() && isDefaultProjectorTool(tool)
}

export function actionToolFor(
  action: FailClosedAction,
  lookup: FailClosedLookup,
): Tool | null {
  if (action.content.length !== 1) return null
  const block = action.content[0]
  if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') {
    return null
  }
  return lookup.get(block.name) ?? null
}

export function emptyProjectionFailClosedVerdict(
  action: FailClosedAction,
  lookup: FailClosedLookup,
): { shouldBlock: true; reason: string } | null {
  const tool = actionToolFor(action, lookup)
  if (shouldFailClosedOnEmptyProjection(tool)) {
    return { shouldBlock: true, reason: FAIL_CLOSED_REASON }
  }
  return null
}
