import { createContext } from 'react'
import type Ink from '../ink.js'

export const InkInstanceContext = createContext<Ink | undefined>(undefined)
