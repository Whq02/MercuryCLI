import { useRef } from 'react'
import { usePublish } from '../../hooks/effects.js'
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
  const truncatedRef = useRef(false)

  usePublish(() => {
    if (input === '') {
      truncatedRef.current = false
      return
    }
    if (truncatedRef.current) return
    const { newInput, newPastedContents } = maybeTruncateInput(input, pastedContents)
    if (newInput === input) return
    truncatedRef.current = true
    setPastedContents(() => newPastedContents)
    onInputChange(newInput)
    setCursorOffset(newInput.length)
  }, [input, pastedContents, onInputChange, setCursorOffset, setPastedContents])
}
