import * as React from 'react'
import { BugReport } from './BugReport.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../catalogue/command.js'
import type { IssueKind } from './issueForms.js'

export type BugReportBackgroundTasks = {
  [taskId: string]: { type: string; identity?: { agentId: string }; messages?: Message[] }
}

function renderBugReport(
  onDone: LocalJSXCommandOnDone,
  abortSignal: AbortSignal,
  messages: Message[],
  initialDescription: string = '',
  backgroundTasks: BugReportBackgroundTasks = {},
  kind?: IssueKind,
): React.ReactNode {
  return (
    <BugReport
      abortSignal={abortSignal}
      messages={messages}
      onDone={(result, options) => onDone(result, options)}
      initialDescription={initialDescription}
      backgroundTasks={backgroundTasks}
      {...(kind !== undefined ? { kind } : {})}
    />
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
  invokedAs?: string,
): Promise<React.ReactNode> {
  const short = /^--short(?:\s|$)/.test(args.trimStart())
  return renderBugReport(
    onDone,
    context.abortController.signal,
    context.messages,
    short ? args.trimStart().replace(/^--short(?:\s+|$)/, '') : args || '',
    {},
    short ? 'tester' : invokedAs?.toLowerCase() === 'bug' ? 'bug' : undefined,
  )
}
