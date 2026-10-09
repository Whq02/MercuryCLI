import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { ContextVisualization } from '../../components/ContextVisualization.js'
import { Wordmark } from '../../components/mercury-ui/assets.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { analyzeContextUsage } from '../../utils/analyzeContext.js'
import { errorMessage } from '../../utils/errors.js'
import { renderToAnsiString, staticPrintColumns } from '../../utils/staticRender.js'
import { buildContextInspectionPlan } from './context-noninteractive.js'

export const CONTEXT_CARD_WORDS = {
  counting: 'counting the context window… · esc closes',
  closedWhileCounting: '/context closed — the chart was not counted',
  failed: (reason: string): string => `the chart could not be built — ${reason}`,
  closeHint: 'esc closes',
} as const

async function renderContextChart(context: LocalJSXCommandContext): Promise<string> {
  const { options } = context
  const plan = await buildContextInspectionPlan({
    messages: context.messages,
    owner: ownerFromToolUseContext(context),
    engineModel: options.engineModel,
    effortValue: context.getAppState().effortValue,
    tools: options.tools,
    contentReplacementState: context.contentReplacementState,
    ...(options.querySource !== undefined ? { querySource: options.querySource } : {}),
  })
  const data = await analyzeContextUsage(
    plan.messages,
    options.engineModel,
    async () => context.getAppState().toolPermissionContext,
    options.tools,
    context.getAppState().agentDefinitions,
    staticPrintColumns(),
    context,
    undefined,
    plan.messages,
  )
  return renderToAnsiString(<ContextVisualization data={data} plan={plan} />, staticPrintColumns())
}

function ContextCommandCard({ context, onDone }: { context: LocalJSXCommandContext; onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const tokens = useMercuryTokens()
  const [failure, setFailure] = useState<string | null>(null)
  const settled = useRef(false)
  useEffect(() => {
    let mounted = true
    void renderContextChart(context).then(
      rendered => {
        if (!mounted || settled.current) return
        settled.current = true
        onDone(rendered)
      },
      (err: unknown) => {
        if (!mounted || settled.current) return
        setFailure(errorMessage(err))
      },
    )
    return () => {
      mounted = false
    }
  }, [])
  useInput((_input, key) => {
    if (!key.escape || settled.current) return
    settled.current = true
    onDone(failure === null ? CONTEXT_CARD_WORDS.closedWhileCounting : `/context — ${CONTEXT_CARD_WORDS.failed(failure)}`)
  })
  return (
    <Box flexDirection="column">
      <Box>
        <Wordmark />
        <Text dimColor> — context</Text>
      </Box>
      {failure === null ? (
        <Text dimColor>{CONTEXT_CARD_WORDS.counting}</Text>
      ) : (
        <Box flexDirection="column">
          <Text color={tokens.warning}>{CONTEXT_CARD_WORDS.failed(failure)}</Text>
          <Text dimColor>{CONTEXT_CARD_WORDS.closeHint}</Text>
        </Box>
      )}
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <ContextCommandCard context={context} onDone={onDone} />
}
