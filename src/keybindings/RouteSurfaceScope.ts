// ============================================================================
//  keybindings/RouteSurfaceScope — WHICH route surface a keybinding hook is
//  mounted inside. The dispatcher's covered-REPL gate (useKeybinding) inerts
//  bindings that live OUTSIDE the surface owning the frame: the parked root
//  REPL's bindings (scope 'repl') stay dead while the Concourse covers it —
//  the seat fold's key-leak law — while a binding mounted INSIDE the covering
//  surface (a standard consent card inline in the coordinator pane, its
//  Select's ↑↓/↵/esc) is live, because that surface IS the frame's owner.
//  SurfaceRouter provides the value around each route surface's render; the
//  always-mounted REPL tree sits under the default.
// ============================================================================
import { createContext } from 'react'
import type { SurfaceKind } from '../context/surfaceRoute.js'

export const RouteSurfaceScopeContext = createContext<SurfaceKind>('repl')
