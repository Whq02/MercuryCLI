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

  useInput(
    (input, _key) => {
      if (input !== 'r') return
      setRetryMarked(current => {
        const next = new Set(current)
        if (next.has(focusedIndex)) next.delete(focusedIndex)
        else next.add(focusedIndex)
        return next
      })
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
