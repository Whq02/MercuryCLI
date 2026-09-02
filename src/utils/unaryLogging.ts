/**
 * Inline-completion telemetry types; the emit function is an empty no-op.
 * The event record type is deliberately not exported — callers satisfy it
 * structurally.
 */

export type CompletionType =
  | 'str_replace_single'
  | 'str_replace_multi'
  | 'write_file_single'
  | 'tool_use_single'

type UnaryLogEvent = {
  completion_type: CompletionType
  event: 'accept' | 'reject' | 'response'
  metadata: {
    language_name: string | Promise<string>
    message_id: string
    platform: string
    userFacingImpact?: boolean
    hasFeedback?: boolean
  }
}

/** An awaitable no-op: the telemetry sink was removed; the call shape remains. */
export async function logUnaryEvent(event: UnaryLogEvent): Promise<void> {
  void event
}
