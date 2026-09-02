import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { StatusIcon } from '../../design-system/StatusIcon.js'
import { useTabHeaderFocus } from '../../design-system/Tabs.js'
import {
  getAutoModeDenials,
  type AutoModeDenial,
} from '../../../utils/autoModeDenials.js'

export type RecentDenialsState = {
  approved: ReadonlySet<number>
  retryMarked: ReadonlySet<number>
  denials: readonly AutoModeDenial[]
}

/**
 * Commands the auto-mode classifier recently denied, with approve/retry
 * marking. The denial list is captured ONCE when the tab mounts. Enter
 * toggles approval; the raw `r` key marks retry and implies approval (it
 * never un-approves). In this build the recorder never stores, so the list is
 * always empty and the empty state renders; the behaviour here is what the
 * restored recorder gets for free.
 */
export function RecentDenialsTab({
  onHeaderFocusChange,
  onStateChange,
}: {
  onHeaderFocusChange?: (focused: boolean) => void
  onStateChange: (state: RecentDenialsState) => void
}): React.ReactNode {
  const [denials] = useState<readonly AutoModeDenial[]>(() => getAutoModeDenials())
  const [approved, setApproved] = useState<ReadonlySet<number>>(new Set())
  const [retryMarked, setRetryMarked] = useState<ReadonlySet<number>>(new Set())
  const [focusedIndex, setFocusedIndex] = useState(0)
  const { headerFocused, focusHeader } = useTabHeaderFocus()

  useEffect(() => {
    onStateChange({ approved, retryMarked, denials })
  }, [approved, retryMarked, denials, onStateChange])

  const toggleApproval = useCallback((index: number) => {
    setApproved(current => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  // The raw `r` handler (interaction-registry class: modal-form). Inactive
  // when there are no denials.
  useInput(
    (input, _key) => {
      if (input !== 'r') return
      setRetryMarked(current => {
        const next = new Set(current)
        if (next.has(focusedIndex)) next.delete(focusedIndex)
        else next.add(focusedIndex)
        return next
      })
      // Retry implies approval; it never un-approves.
      setApproved(current =>
        current.has(focusedIndex) ? current : new Set(current).add(focusedIndex),
      )
    },
    { isActive: denials.length > 0 },
  )

  if (denials.length === 0) {
    return (
      <Text dimColor>
        No recent denials. Commands denied by the auto-mode classifier will appear here.
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>Commands recently denied by the auto-mode classifier:</Text>
      <Select
        options={denials.map((denial, index) => ({
          label: (
            <Text>
              <StatusIcon status={approved.has(index) ? 'success' : 'error'} />{' '}
              {denial.display}
              {retryMarked.has(index) ? <Text dimColor> (retry)</Text> : null}
            </Text>
          ),
          value: String(index),
        }))}
        visibleOptionCount={Math.min(10, denials.length)}
        isDisabled={headerFocused}
        onChange={value => toggleApproval(Number(value))}
        onFocus={value => setFocusedIndex(Number(value))}
        onUpFromFirstItem={() => {
          focusHeader()
          onHeaderFocusChange?.(true)
        }}
      />
    </Box>
  )
}
