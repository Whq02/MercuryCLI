// ============================================================================
//  InkInstanceContext — T6: the render tree's own Ink
//  instance, provided by Ink.render().
//
//  In-tree consumers (AlternateScreen, the selection/search hooks) used to
//  reach their instance via the HARDWIRED `instances.get(process.stdout)` —
//  an instance keyed to any other stream (an embedded/SDK render, every
//  contract-law rig) silently got `undefined`, so alt-screen composition
//  never engaged and selection APIs no-opped (the T6 characterization
//  finding). The context always names the instance that actually rendered
//  the tree. Out-of-tree consumers (gracefulShutdown, editor handoffs,
//  commands) legitimately keep the instances map — they hold a real stream
//  reference.
// ============================================================================
import { createContext } from 'react'
import type Ink from '../ink.js'

export const InkInstanceContext = createContext<Ink | undefined>(undefined)
