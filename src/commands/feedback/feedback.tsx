import * as React from 'react'
import { Feedback } from '../../components/Feedback.js'
import type { Message } from '../../types/message.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

export type FeedbackBackgroundTasks = {
  [taskId: string]: { type: string; identity?: { agentId: string }; messages?: Message[] }
}

export function renderFeedbackComponent(
  onDone: LocalJSXCommandOnDone,
  abortSignal: AbortSignal,
  messages: Message[],
  initialDescription: string = '',
  backgroundTasks: FeedbackBackgroundTasks = {},
): React.ReactNode {
  return (
    <Feedback
      abortSignal={abortSignal}
      messages={messages}
      onDone={(result, options) => onDone(result, options)}
      initialDescription={initialDescription}
      backgroundTasks={backgroundTasks}
    />
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  return renderFeedbackComponent(
    onDone,
    context.abortController.signal,
    context.messages,
    args || '',
  )
}
