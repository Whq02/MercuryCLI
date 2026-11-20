
import { useRef } from 'react'
import { useDerivedState, usePublish } from '../../hooks/effects.js'
import type { PastedContent } from '../../utils/config.js'
import { maybeTruncateInput } from './inputPaste.js'

export function useMaybeTruncateInput({
  input,
  pastedContents,
  onInputChange,
  setCursorOffset,
  setPastedContents,
}: {
  input: string
  pastedContents: Record<number, PastedContent>
  onInputChange: (value: string) => void
  setCursorOffset: (offset: number) => void
  setPastedContents: (
    updater: (previous: Record<number, PastedContent>) => Record<number, PastedContent>,
  ) => void
}): void {
  const appliedRef = useRef(false)

  useDerivedState(() => {
    if (appliedRef.current) return
    const { newInput, newPastedContents } = maybeTruncateInput(
      input,
      pastedContents,
    )
    if (newInput === input) return
    appliedRef.current = true
    setPastedContents(() => newPastedContents)
    onInputChange(newInput)
    setCursorOffset(newInput.length)
  }, [input, pastedContents, onInputChange, setCursorOffset, setPastedContents])

  usePublish(() => {
    if (input === '') appliedRef.current = false
  }, [input])
}
