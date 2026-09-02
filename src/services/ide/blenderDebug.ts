
import { debugpyVendorRoot } from '../dap/debugpyResolver.js'

export const BLENDER_DEBUG_DEFAULT_PORT = 5678

export function blenderDebugListenExpr(
  port: number = BLENDER_DEBUG_DEFAULT_PORT,
  vendorRoot: string | null = debugpyVendorRoot(),
): string {
  const pathArm = vendorRoot
    ? `import sys; sys.path.insert(0, ${JSON.stringify(vendorRoot)}); `
    : ''
  return (
    `${pathArm}import debugpy; debugpy.listen(('127.0.0.1', ${port})); ` +
    `print('debugpy: listening on 127.0.0.1:${port}')`
  )
}

export interface BlenderDebugRecipe {
  port: number
  debugpySource: 'bundled' | 'pip'
  expr: string
  steps: string[]
}

export function blenderDebugRecipe(
  blenderSpelling: string = '<blender>',
  port: number = BLENDER_DEBUG_DEFAULT_PORT,
  vendorRoot: string | null = debugpyVendorRoot(),
): BlenderDebugRecipe {
  const expr = blenderDebugListenExpr(port, vendorRoot)
  return {
    port,
    debugpySource: vendorRoot ? 'bundled' : 'pip',
    expr,
    steps: [
      `1. start Blender with the listener (or paste the expression into Blender's Python console): ${blenderSpelling} --python-expr "${expr.replace(/"/g, '\\"')}"`,
      ...(vendorRoot
        ? [`   (the bundled debugpy at ${vendorRoot} serves — nothing to install)`]
        : [
            `   (no bundled debugpy beside this build — first make debugpy importable in Blender's own Python: its pip, \`pip install debugpy\`)`,
          ]),
      `2. attach Mercury's debugger: Debug op:"attach" adapter:"python" port:${port} (the landed debugpy attach contract — {connect:{host,port}})`,
      `3. breakpoints in your addon/script files bind normally; add debugpy.wait_for_client() after listen when you must catch startup code`,
      `note: if the attach stalls waiting, the KNOWN upstream debugpy --listen wedge may apply (observed: wedged at debugpyWaitingForServer with zero Mercury code on that box class) — re-test on the next debugpy release before suspecting this road`,
    ],
  }
}
