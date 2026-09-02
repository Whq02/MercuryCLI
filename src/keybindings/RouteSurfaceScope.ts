import { createContext } from 'react'
import type { SurfaceKind } from '../context/surfaceRoute.js'

export const RouteSurfaceScopeContext = createContext<SurfaceKind>('repl')
