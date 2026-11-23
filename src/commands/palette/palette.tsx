import { PaletteView } from '../../screen/widgets/PaletteView.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return (
    <PaletteView
      onClose={() => onDone()}
      onPick={name =>
        onDone(undefined, {
          nextInput: `/${name} `,
          submitNextInput: true,
        })
      }
    />
  )
}
