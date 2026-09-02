// The app context: a single `exit` key (the value key is contract data —
// the hook slices read it by name).

import { createContext } from 'react'

export type Props = {
  readonly exit: (error?: Error) => void
}

const AppContext = createContext<Props>({
  exit() {},
})

AppContext.displayName = 'InternalAppContext'

export default AppContext
