
import React from 'react'
import { ListItem } from '../design-system/ListItem.js'

export type SelectOptionProps = {
  isFocused: boolean
  isSelected: boolean
  children?: React.ReactNode
  description?: string
  shouldShowDownArrow?: boolean
  shouldShowUpArrow?: boolean
  declareCursor?: boolean
}

export function SelectOption({
  isFocused,
  isSelected,
  children,
  description,
  shouldShowDownArrow = false,
  shouldShowUpArrow = false,
  declareCursor = true,
}: SelectOptionProps): React.ReactNode {
  return (
    <ListItem
      isFocused={isFocused}
      isSelected={isSelected}
      description={description}
      showScrollDown={shouldShowDownArrow}
      showScrollUp={shouldShowUpArrow}
      styled={false}
      declareCursor={declareCursor}
    >
      {children}
    </ListItem>
  )
}

export default SelectOption
