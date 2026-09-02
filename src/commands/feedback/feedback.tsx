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

/**
 * The shared mount for the feedback component. Exported with the
 * background-task map as a parameter so other surfaces can raise the same
 * component with task context; the slash command itself passes none.
 */
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
