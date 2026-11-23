import { backspaceAt, deleteAt, editorMotionOp, insertAt, singleLine } from '../../lineDraft.js'
import type { InputEvent, Key } from '../../../themedRenderer.js'
import type { KeysArgs } from '../state.js'

export function tabFilterKeys(input: string, key: Key, event: InputEvent, { editFilter, filtering, regionsInOrder, setFilter, setFiltering, setRegion }: KeysArgs): boolean {
  if (key.tab && !filtering) {
    event.stopImmediatePropagation()
    const dir = key.shift ? -1 : 1
    setRegion(prev => {
      const at = regionsInOrder.indexOf(prev)
      return regionsInOrder[(at + dir + regionsInOrder.length) % regionsInOrder.length]!
    })
    return true
  }
  if (filtering) {
    if (key.escape) {
      event.stopImmediatePropagation()
      setFiltering(false)
      setFilter({ text: '', caret: 0 })
      return true
    }
    if (key.return || key.tab) {
      event.stopImmediatePropagation()
      setFiltering(false)
      return true
    }
    if (key.backspace) {
      event.stopImmediatePropagation()
      editFilter(backspaceAt)
      return true
    }
    if (key.delete) {
      event.stopImmediatePropagation()
      editFilter(deleteAt)
      return true
    }
    const filterMotion = editorMotionOp(key)
    if (filterMotion !== null) {
      event.stopImmediatePropagation()
      editFilter(filterMotion)
      return true
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      event.stopImmediatePropagation()
      editFilter(d => insertAt(d, singleLine(input)))
      return true
    }
    return true
  }
  return false
}
