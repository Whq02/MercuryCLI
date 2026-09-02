
import { createContext } from 'react'

export type Props = {
  readonly exit: (error?: Error) => void
}

const AppContext = createContext<Props>({
  exit() {},
})

AppContext.displayName = 'InternalAppContext'

export default AppContext
