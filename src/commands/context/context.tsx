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
