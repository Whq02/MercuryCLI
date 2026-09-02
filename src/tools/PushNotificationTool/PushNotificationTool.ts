import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'

// The notifier (services/notifier.ts → sendNotification) resolves to the method
// it actually dispatched on. These are the ones that DELIVERED a notification;
// every other return ('no_method_available'/'none'/'disabled'/'error') means the
// message was dropped silently. localSent must reflect ACTUAL delivery, not mere
// channel presence — a session whose terminal has no notify method (Apple
// Terminal with the bell off, an unknown terminal) returns 'no_method_available'
// and must NOT be reported as "Terminal notification sent."
const LOCAL_DELIVERY_METHODS = new Set<string>([
  'iterm2',
  'iterm2_with_bell',
  'kitty',
  'ghostty',
  'terminal_bell',
])

// The behavioral contract — schema, OS-notification dispatch, and result
// shape — is frozen; there is no separate mobile-push transport (mobile
// delivery rides Remote Control when connected, documented inline).
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

// pushSent/localSent/disabledReason MUST remain optional — resumed sessions
// replay pre-existing outputs verbatim, and a required field would crash the
// UI renderer on resume (same invariant as BriefTool's attachments).
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
  // Deferred (loaded via ToolSearch); never on turn 1.
  shouldDefer: true,
  // Always-on: Mercury never hides this tool behind a remote gate.
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

    // Local/terminal notification goes through the session's OS-notification
    // channel (wired in REPL.tsx → sendNotification, which resolves to the
    // method it dispatched on). When absent (SDK / non-interactive contexts),
    // there's no transport to deliver on.
    const canSendLocal = typeof context.sendOSNotification === 'function'
    let methodUsed: string | undefined
    if (canSendLocal) {
      // The channel returns the dispatched method (or a non-delivery sentinel).
      // A channel wired as `void` (older contexts) yields undefined here — we
      // then treat delivery as unknown and do NOT claim a send (fail-honest).
      const result = await context.sendOSNotification?.({
        message,
        notificationType: status,
      })
      methodUsed = typeof result === 'string' ? result : undefined
    }

    // localSent reflects ACTUAL delivery, not mere channel presence: a channel
    // that resolved to no_method_available / none / disabled / error (or returned
    // nothing) dropped the message silently, so we must not claim a terminal
    // send happened.
    const localSent =
      canSendLocal &&
      methodUsed !== undefined &&
      LOCAL_DELIVERY_METHODS.has(methodUsed)

    // Mercury has no Remote Control mobile-push transport wired, so the
    // mobile leg is never delivered. Report honestly via the output schema
    // rather than claiming a push that didn't happen.
    const pushSent = false

    const data: Output = {
      message,
      localSent,
      pushSent,
      sentAt,
    }
    // Nothing actually went out (no channel, or the channel dropped it) — say so
    // so mapToolResult does NOT fall through to "Terminal notification sent."
    if (!localSent && !pushSent) {
      data.disabledReason = 'no_transport'
    }
    return { data }
  },
} satisfies ToolDef<InputSchema, Output>)
