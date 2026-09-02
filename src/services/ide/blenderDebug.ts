// ============================================================================
//  ide/blenderDebug — the debugpy-attach-INTO-Blender recipe (MERCURY_BLENDER
//  estate; a RECIPE riding the LANDED attach road — deliberately zero new
//  debug machinery).
//
//  Blender's Python debugs over debugpy exactly like the community road
//  (AlansCodeLog/blender-debugger-for-vscode + hextantstudios docs, read
//  2026-08-29): make debugpy importable inside Blender's Python, call
//  debugpy.listen((host, port)) there, then attach a DAP client to that
//  port. Mercury's half of that already EXISTS: the Debug tool's python
//  adapter speaks the debugpy attach contract ({connect:{host,port}} —
//  attachShape 'connect' in dapClient), so the ONLY Blender-specific piece
//  is the listen side — a one-line --python-expr the OPERATOR launches
//  Blender with (or pastes into its Python console). The bundled debugpy
//  serves when the artifact carries it (sys.path.insert of the vendored
//  tree — dist/vendor/debugpy rides the build); a box without the vendor
//  tree uses Blender's own `pip install debugpy` road. Port 5678 is the
//  community default.
//
//  THE KNOWN UPSTREAM WEDGE: `python -m debugpy --listen … --wait-for-client`
//  wedged at
//  debugpyWaitingForServer on that box class with a clean pip debugpy
//  1.8.21 over a raw socket and ZERO Mercury code (three controls;
//  adapter-launch mode drill-proven green). If an attach stalls waiting,
//  suspect that wedge before Mercury: re-test on the next debugpy release.
//  The steps text carries the citation so the operator sees it at use.
//
//  Proof: scripts/ide/prove-blender-debug.ts (pure: expr shape both roads,
//  the steps contract, profile gating).
// ============================================================================

import { debugpyVendorRoot } from '../dap/debugpyResolver.js'

export const BLENDER_DEBUG_DEFAULT_PORT = 5678

/** The one-line listen expression the operator hands to
 *  `blender --python-expr` (or pastes into Blender's Python console).
 *  vendorRoot present ⇒ the BUNDLED debugpy serves; null ⇒ the pip road
 *  (debugpy importable in Blender's own Python). */
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
  /** Which debugpy serves: the bundled vendor tree or Blender's own pip. */
  debugpySource: 'bundled' | 'pip'
  expr: string
  /** The numbered operator steps (the drill text; every teaching surface
   *  prints these verbatim). */
  steps: string[]
}

/** The whole recipe, pure. `blenderSpelling` is the located binary when
 *  the caller has one (else the placeholder teaching spelling). */
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
