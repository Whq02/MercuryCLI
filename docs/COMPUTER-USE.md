# Computer use

## The driver

Computer use runs through Mercury's own desktop driver: a native module over
the platform's screen and input layers (CoreGraphics on macOS, GDI and
SendInput on Windows, X11 with the XTEST extension on Linux), built from the
repository's `native/desktop` sources with cargo by
`bun run scripts/vendor/build-desktop.ts`, which `bun run setup` runs last.
It is built rather than fetched: a machine without a Rust toolchain builds
and runs Mercury without it, the build says so, and the Computer tool
answers "no desktop driver on this install" until the pack is built. Release
archives carry the driver for their platform when the packaging host could
build it. Nothing else is installed on your machine, and no screenshot is
written to disk unless you ask for one.

## What each platform needs

- **macOS**: two grants for your terminal application (Terminal, iTerm2,
  WezTerm — whichever runs Mercury), under System Settings → Privacy &
  Security: **Screen Recording**, so the driver can see the screen, and
  **Accessibility**, so it can move the mouse and type. The first capture
  or act asks the system to register the terminal in both lists; after you
  allow, restart the terminal application. Without Screen Recording, macOS
  hands out a picture of the wallpaper with every other window blanked —
  Mercury refuses to work from that and names the grant instead. Without
  Accessibility, macOS silently drops synthetic input; Mercury refuses the
  act and names the grant. Recent macOS versions ask now and then whether
  the terminal application may keep recording the screen; allow it and the
  captures continue.
- **Windows**: an interactive desktop session — not a service, not a locked
  desktop, not a remote session that has disconnected. No grant dialog
  exists. Windows drops input into a window that runs elevated when Mercury
  does not; run Mercury elevated if you need to drive such a window.
- **Linux**: an X11 session with `DISPLAY` set. The XTEST and RandR
  extensions every X server carries are all the driver needs. A Wayland
  session is refused by name: the driver could see only part of such a
  desktop and would not pretend otherwise.

Keyboard shortcuts on a non-US layout land on the US key positions on
macOS in this release; typed text is always layout-correct.

## The doctor

`mercury doctor` and `/health` carry a `Computer use` row in the INTERFACE
section. Its line names the pack (its version and platform, and whether it
was found beside the bundle, in the checkout, or through
`MERCURY_DESKTOP_PACK_DIR`), the screen and input grants, the kind of
session Mercury runs in, and whether computer use is on. The detail lists
the displays with their sizes and scales, the frontmost application, the
permission words for your platform, and which session is driving the
desktop right now, if any — one session drives at a time. A missing grant
is information with the fix beside it, never a fault: computer use is off
by default and the rest of Mercury does not depend on it. The doctor never
opens a system dialog; the first capture or act does.

A held mouse button or key is released when you interrupt, when the turn
ends, and when Mercury exits. If Mercury is killed in the middle of a
press, the platform keeps the button down until your next physical click.
The environment variables are listed in `src/substrate/flagRegistry.ts`.
