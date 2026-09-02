import { createContext } from 'react'

// ============================================================================
//  MotionParkContext — "invisible surfaces do no animation work".
//
//  True inside a subtree whose painted cells are FULLY COVERED by an opaque
//  layer (FullscreenLayout's screen-claiming modal). The animation hooks
//  (use-animation-value / use-animation-frame) treat parked exactly like
//  offscreen: the clock subscription drops — and when no keep-alive
//  subscriber remains, the shared Clock's setInterval stops entirely.
//
//  Safe by the primitives' own contract: every motion primitive's degraded
//  state IS its settled/frame-0 cell, so a parked cell renders the exact
//  static form it would have painted anyway (which nobody sees — it's
//  covered); unpark resamples the absolute-time lattice, so nothing desyncs.
//
//  Provider law (FullscreenLayout M3): the provider stays MOUNTED and only
//  its VALUE switches — mounting/unmounting a provider around the transcript
//  would remount it. The modal slot re-provides `false` so the covering
//  surface's own primitives never park themselves.
// ============================================================================
export const MotionParkContext = createContext(false)
