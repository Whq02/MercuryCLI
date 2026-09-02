import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'

const LOCAL_DELIVERY_METHODS = new Set<string>([
  'iterm2',
  'iterm2_with_bell',
  'kitty',
  'ghostty',
  'terminal_bell',
])

const DESCRIPTION = `Send a notification to the user via their terminal and, when Remote Control is connected, also push to their mobile device.

This tool sends a desktop notification in the user's terminal. If Remote Control is connected, it also pushes to their phone. Either way, it pulls their attention from whatever they're doing — a meeting, another task, dinner — to this session. That's the cost. The benefit is they learn something now that they'd want to know now: a long task finished while they were away, a build is ready, you've hit something that needs their decision before you can continue.

Because a notification they didn't need is annoying in a way that accumulates, err toward not sending one. Don't notify for routine progress, or to announce you've answered something they asked seconds ago and are clearly still watching, or when a quick task completes. Notify when there's a real chance they've walked away and there's something worth coming back for — or when they've explicitly asked you to notify them.

Keep the message under 200 characters, one line, no markdown. Lead with what they'd act on — "build failed: 2 auth tests" tells them more than "task done".`

const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z
      .string()
      .min(1)
      .describe(
        'The notification body. Keep it under 200 characters; mobile OSes truncate.',
      ),
    status: z.literal('proactive'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string(),
    pushSent: z.boolean().optional(),
    localSent: z.boolean().optional(),
    disabledReason: z
      .enum(['config_off', 'user_present', 'no_transport'])
      .optional(),
    idleSec: z.number().optional(),
    hasFocus: z.boolean().optional(),
    sentAt: z
      .string()
      .optional()
      .describe(
        'ISO timestamp captured at tool execution on the emitting process. Optional — resumed sessions replay pre-sentAt outputs verbatim.',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  searchHint: 'send a notification to the user via terminal and optionally mobile',
  maxResultSizeChars: 1000,
  userFacingName() {
    return 'PushNotification'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.message
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return ''
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    let content: string
    if (output.disabledReason === 'config_off') {
      content = 'Push not sent — mobile push is disabled in /config.'
    } else if (output.disabledReason === 'user_present') {
      content =
        output.hasFocus === true
          ? 'Not sent — terminal has focus. Terminal + mobile suppressed.'
          : `Not sent — user active (last keystroke ${output.idleSec ?? 0}s ago).`
    } else if (output.disabledReason === 'no_transport') {
      content = 'Not sent — no notification transport available.'
    } else if (output.localSent && output.pushSent) {
      content = 'Terminal and mobile notification sent.'
    } else if (output.pushSent) {
      content = 'Mobile notification sent.'
    } else {
      content = 'Terminal notification sent.'
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
  renderToolUseMessage(input) {
    return `PushNotification: ${input.message ?? ''}`
  },
  async call({ message, status }, context) {
    const sentAt = new Date().toISOString()

    const canSendLocal = typeof context.sendOSNotification === 'function'
    let methodUsed: string | undefined
    if (canSendLocal) {
      const result = await context.sendOSNotification?.({
        message,
        notificationType: status,
      })
      methodUsed = typeof result === 'string' ? result : undefined
    }

    const localSent =
      canSendLocal &&
      methodUsed !== undefined &&
      LOCAL_DELIVERY_METHODS.has(methodUsed)

    const pushSent = false

    const data: Output = {
      message,
      localSent,
      pushSent,
      sentAt,
    }
    if (!localSent && !pushSent) {
      data.disabledReason = 'no_transport'
    }
    return { data }
  },
} satisfies ToolDef<InputSchema, Output>)
