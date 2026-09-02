
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js'
import { hookSourceDescriptionDisplayString } from '../../utils/hooks/hooksSettings.js'
import { eventSupportsIfConditions } from '../../utils/hooks/matching.js'
import { Dialog } from '../design-system/Dialog.js'
import { ALL_MATCHER_MARKER } from './SelectMatcherMode.js'

function primaryPayload(config: IndividualHookConfig['config']): {
  label: string
  value: string
} {
  switch (config.type) {
    case 'command':
      return { label: 'Command', value: config.command }
    case 'prompt':
      return { label: 'Prompt', value: config.prompt }
    case 'agent':
      return { label: 'Prompt', value: config.prompt }
    case 'http':
      return { label: 'URL', value: config.url }
    default:
      return { label: 'Payload', value: '' }
  }
}

export function ViewHookMode({
  event,
  matcher,
  supportsMatchers,
  hook,
  onBack,
}: {
  event: HookEvent
  matcher: string
  supportsMatchers: boolean
  hook: IndividualHookConfig
  onBack: () => void
}): React.ReactNode {
  const payload = primaryPayload(hook.config)
  const statusMessage =
    'statusMessage' in hook.config ? hook.config.statusMessage : undefined
  return (
    <Dialog title="Hook detail" onCancel={onBack}>
      <Box flexDirection="column">
        <Text>
          <Text dimColor>Event: </Text>
          {event}
        </Text>
        {supportsMatchers ? (
          <Text>
            <Text dimColor>Matcher: </Text>
            {matcher === '' ? ALL_MATCHER_MARKER : matcher}
          </Text>
        ) : null}
        <Text>
          <Text dimColor>Type: </Text>
          {hook.config.type}
        </Text>
        <Text>
          <Text dimColor>Source: </Text>
          {hookSourceDescriptionDisplayString(hook.source)}
        </Text>
        {hook.extensionName ? (
          <Text>
            <Text dimColor>Extension: </Text>
            {hook.extensionName}
          </Text>
        ) : null}
        {
}
        {'if' in hook.config && hook.config.if ? (
          <Text>
            <Text dimColor>If: </Text>
            {String(hook.config.if)}
            {
}
            {eventSupportsIfConditions(event) ? (
              ''
            ) : (
              <Text color="yellow">
                {' '}
                — never evaluated: {event} has no tool input, so this hook
                will not run
              </Text>
            )}
          </Text>
        ) : null}
        {'timeout' in hook.config && hook.config.timeout !== undefined ? (
          <Text>
            <Text dimColor>Timeout: </Text>
            {String(hook.config.timeout)}s
          </Text>
        ) : null}
        {'shell' in hook.config && hook.config.shell ? (
          <Text>
            <Text dimColor>Shell: </Text>
            {String(hook.config.shell)}
          </Text>
        ) : null}
        {'async' in hook.config && hook.config.async ? (
          <Text>
            <Text dimColor>Async: </Text>
            yes — runs in the background, never holds the turn
          </Text>
        ) : null}
        {'once' in hook.config && hook.config.once ? (
          <Text>
            <Text dimColor>Once: </Text>
            yes — runs once, then its entry is removed
          </Text>
        ) : null}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderDimColor
          paddingX={1}
          marginTop={1}
        >
          <Text dimColor>{payload.label}</Text>
          <Text wrap="wrap">{payload.value}</Text>
        </Box>
        {statusMessage ? (
          <Text>
            <Text dimColor>Status message: </Text>
            {statusMessage}
          </Text>
        ) : null}
        <Box marginTop={1}>
          <Text dimColor>
            To change this hook, edit settings.json or ask Mercury.
          </Text>
        </Box>
      </Box>
    </Dialog>
  )
}
