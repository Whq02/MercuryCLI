import { createContext } from 'react'
import type Ink from '../screenInstance.js'

export const InkInstanceContext = createContext<Ink | undefined>(undefined)
