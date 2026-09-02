// The shared registry of live Ink instances, keyed by write stream: a second
// render() against the same stream must find and reuse the first instance
// instead of constructing another.
//
// It sits in its own module because two peers reach it from opposite sides —
// render.js inserts on create, instance.js deletes itself on unmount — and
// either one importing the other would form a cycle.

import type Ink from './ink.js'

const instances = new Map<NodeJS.WriteStream, Ink>()
export default instances
