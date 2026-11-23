import { createContext } from 'react'
import type { SurfaceKind } from '../routes/surfaceRoute.js'

export const RouteSurfaceScopeContext = createContext<SurfaceKind>('repl')
