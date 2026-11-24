import { createContext } from 'react'
import type ScreenInstance from '../screenInstance.js'

export const ScreenInstanceContext = createContext<ScreenInstance | undefined>(undefined)
