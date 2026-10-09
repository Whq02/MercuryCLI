import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { HookEvent } from '../../utils/hooks/contract.js'
import { HOOK_TIMEOUT_DEFAULT_S } from '../../utils/hooks/contract.js'
import { hookKindOf } from '../../schemas/hooks.js'
import { answerWords, type HookEventCard } from '../../utils/hooks/hooksConfigManager.js'
import { hookRowName, hookSourceWords, type HookRow } from '../../utils/hooks/hooksSettings.js'
import { Dialog } from '../design-system/Dialog.js'
import { ALL_MATCHER_MARKER } from './SelectMatcherMode.js'

function textLabel(kind: string): string {
  switch (kind) {
    case 'run':
      return 'Command'
    case 'question':
      return 'Question'
    default:
      return 'Check'
  }
}

export function ViewHookMode({
  event,
  card,
  hook,
  onBack,
}: {
  event: HookEvent
  card: HookEventCard
  hook: HookRow
  onBack: () => void
}): React.ReactNode {
  const { entry } = hook
  const kind = hookKindOf(entry)
  const text = entry.run ?? entry.question ?? entry.crewmate ?? ''
  const timeout = entry.timeout ?? HOOK_TIMEOUT_DEFAULT_S[kind]
  const answers = card.answers.length > 0 ? card.answers.map(answerWords).join(', ') : 'nothing — the hook is a record'
  return (
    <Dialog title="Hook detail" onCancel={onBack}>
      <Box flexDirection="column">
        <Text>
          <Text dimColor>Event: </Text>
          {event}
          <Text dimColor> — {card.moment}</Text>
        </Text>
        {card.match !== undefined ? (
          <Text>
            <Text dimColor>Match: </Text>
            {hook.match === '' ? ALL_MATCHER_MARKER : hook.match}
            <Text dimColor> (the event's {card.match})</Text>
          </Text>
        ) : null}
        <Text>
          <Text dimColor>Kind: </Text>
          {kind}
        </Text>
        <Text>
          <Text dimColor>Name: </Text>
          {hookRowName(hook)}
        </Text>
        <Text>
          <Text dimColor>Source: </Text>
          {hookSourceWords(hook.source)}
        </Text>
        <Text>
          <Text dimColor>Timeout: </Text>
          {timeout}s{entry.timeout === undefined ? <Text dimColor> (the default)</Text> : null}
        </Text>
        {entry.shell !== undefined ? (
          <Text>
            <Text dimColor>Shell: </Text>
            {entry.shell}
          </Text>
        ) : null}
        {entry.model !== undefined ? (
          <Text>
            <Text dimColor>Model: </Text>
            {entry.model}
          </Text>
        ) : null}
        {entry.background === true || entry.wake === true ? (
          <Text>
            <Text dimColor>Background: </Text>
            yes — never holds the moment; its answer arrives at the next turn{entry.wake === true ? '; a block wakes the model' : ''}
          </Text>
        ) : null}
        {entry.once === true ? (
          <Text>
            <Text dimColor>Once: </Text>
            yes — runs once in this session, then stands down
          </Text>
        ) : null}
        {entry.watch !== undefined ? (
          <Text>
            <Text dimColor>Watch: </Text>
            {entry.watch.join(', ')}
          </Text>
        ) : null}
        <Text>
          <Text dimColor>An answer may: </Text>
          {answers}
        </Text>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
          <Text dimColor>{textLabel(kind)}</Text>
          <Text wrap="wrap">{text}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>To change this hook, edit settings.json or ask Mercury.</Text>
        </Box>
      </Box>
    </Dialog>
  )
}
