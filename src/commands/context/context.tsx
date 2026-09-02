import * as React from 'react'
import { ContextVisualization } from '../../components/ContextVisualization.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { analyzeContextUsage } from '../../utils/analyzeContext.js'
import { renderToAnsiString, staticPrintColumns } from '../../utils/staticRender.js'
import { buildContextInspectionPlan } from './context-noninteractive.js'

/**
 * Interactive `/context`: plan in inspect mode exactly as the outgoing
 * request path would, analyse with the REAL terminal width, the app state's
 * agent definitions and the full tool-use context (the shared collector
 * passes none of those), then hand the coloured visualisation to the
 * completion callback as a static ANSI string — the command prints like a
 * local command instead of staying mounted.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<null> {
  const { options } = context
  const plan = await buildContextInspectionPlan({
    messages: context.messages,
    owner: ownerFromToolUseContext(context),
    mainLoopModel: options.mainLoopModel,
    effortValue: context.getAppState().effortValue,
    tools: options.tools,
    contentReplacementState: context.contentReplacementState,
    ...(options.querySource !== undefined ? { querySource: options.querySource } : {}),
  })
  const data = await analyzeContextUsage(
    plan.messages,
    options.mainLoopModel,
    async () => context.getAppState().toolPermissionContext,
    options.tools,
    context.getAppState().agentDefinitions,
    staticPrintColumns(),
    context,
    undefined,
    plan.messages,
  )
  const rendered = await renderToAnsiString(
    <ContextVisualization data={data} plan={plan} />,
    staticPrintColumns(),
  )
  onDone(rendered)
  return null
}
