# Computer use

Computer use is the Computer tool: the model takes a screenshot of your
screen, decides, then clicks, types, presses keys, scrolls or drags in the
application in front, and sees a fresh screenshot after every act. Nothing
runs without your consent: the first act in each application asks you by
the application's name. It is on by default on a machine that has the
desktop driver, and the rest of Mercury does not depend on it.

## Turning it off

Turn the Boot Menu's `Computer use` row off — it is on by default, and the
change reaches new sessions — or set `MERCURY_COMPUTER_USE=0` in the
environment before the session starts. A session already running keeps the
tool list it started with until the next compaction or `/clear`, so set
the switch before you boot. With the
switch off the Computer tool is not in the catalog at all and no desktop
driver is touched. On a machine without the desktop driver the tool is
absent from the catalog as well: the catalog decides when it is built,
never when the model calls, so the model is never offered a tool that
cannot work. `mercury doctor` and `/health` carry a `Computer use` row that
names what is missing — the driver, a grant, the kind of session — with
the fix beside it.

## The asks

Screenshots and the other reads — the cursor, the displays, the application
in front, a timed wait — never ask. The first act in each application — a
click, a drag, a scroll, typed text, a key — asks by the application's name
and identity, the card names the act, and it asks how long you want to
allow. Five answers, in this order:

- **Yes** allows this act and every later act in this application for the
  rest of the session.
- **No, and tell Mercury what to do differently** refuses the act and hands
  the composer back to you.
- **Yes, for 1 hour — every application** allows every act in every
  application for one hour from now.
- **Yes, for 24 hours — every application** does the same for twenty-four
  hours.
- **Enable sovereign mode to avoid further permissions by default** turns
  sovereign mode on for this session and saves the Boot Menu's `Sovereign
  mode` row, so no later session asks either — for anything — until you
  turn the row off.

A timed grant lives with the session: a resume inside its span keeps it, a
new session never inherits it, and it is never written into your settings.
When it runs out, the next first act asks again — nothing timed is
permanent, and acts made under it leave no per-application grant behind.
An act that lands in another application asks for that one before the next
act there. An application that moved in front between the ask and the act
is not driven: the act is refused and the model takes a new screenshot. No
classifier answers this ask: the screen, not you, chose the application, so
the consent is yours alone — and sovereign mode is the one posture that
answers it, because sovereign mode answers every permission question.

## Sovereign mode

Sovereign mode is Mercury's one bypass, and computer use is under it like
everything else: with sovereign mode on, no permission question is asked —
not for files, not for commands, not for computer use — and the crimson
band says so. The Boot Menu's `Sovereign mode` row (in the trust combo)
turns it on for new sessions; the ask card's last answer turns it on for
the running session and saves the same row; `shift+tab` reaches it in a
session launched with the bypass flag. What stays under sovereign mode is
what was never a question: a `permissions.deny` rule refuses its
application before any act, the terminal running Mercury is never typed
into, and an application that moved in front between the check and the act
is not driven. `mercury doctor` and `/health` carry a `Sovereign mode` row
that names the one setting and what armed it.

## The allowlist

A grant that outlives the session is a permission rule in the
`permissions.allow` list of your settings: `Computer(app:<identity>)`,
where the identity is the one the application's row shows beside its name
— a bundle identifier on macOS (`com.apple.Safari`), an executable name on
Windows (`chrome.exe`), a window class on Linux (`firefox`). You write the
rule yourself; the card writes none. A rule in `permissions.deny` refuses
that application before any ask, in every mode; a rule in `permissions.ask`
asks for it in every mode that asks and, like every other ask rule, stands
down under sovereign mode. A rule written on one platform matches only that
platform's identities.

## The stop key

`esc` or `ctrl+c` ends the act in flight, releases every key and button the
model was holding, and ends the turn. The key reaches Mercury only while
its terminal has keyboard focus: when another application is in front,
click the terminal first. While a turn drives, the footer says
`● hands off — Mercury is driving <application> · esc stops it`. Your own
mouse and keyboard keep working throughout; a drag the model is stepping
ends where the last hand left it.

## What the model sees and what is kept

Every screenshot is written to `<config home>/desktop-shots/`, the newest
200 kept, and sent to the model at the image budget of its route (a large
or high-density screen is downscaled for the wire; the file on disk keeps
its full size). The conversation file never carries the image: it keeps a
line naming the file, so a saved conversation stays small and a resumed
one takes a new screenshot before acting. On the wire the model sees the
newest few screenshots; older ones leave its context as newer ones arrive,
each leaving its text line behind. After a compaction or a resume the model
takes a new screenshot before acting, because its coordinates are pixels of
the last screenshot it received.

## Keyboard rules

Text is typed as given: a newline presses Enter and a tab presses Tab, so a
newline at the end of typed text submits whatever field it lands in. Key
chords are spelled `cmd+shift+s`: `cmd`, `ctrl`, `alt` and `shift` joined
by `+` with a named key (Enter, Escape, Tab, Space, Backspace, Delete, Home,
End, PageUp, PageDown, the arrows, F1 to F12) or one character. The model
never types into the terminal running Mercury: with that terminal in front,
typed text and held keys are refused, a key chord is allowed only to switch
applications, and a click must land outside the terminal's window. A worker
uses the terminal identity supplied by the attached cockpit, not the daemon
that spawned it. If that identity cannot be read, typing, holding keys and
ordinary key chords refuse rather than guessing; the application-switch
chord remains available.

## Models and routes

The tool works with a model that receives images. On a route that carries
text only it refuses and names the route; `/model` switches to a model that
sees. A model that refuses images on its own route is refused for the rest
of the session on that model, with the provider's words, until you switch
models.

## One session at a time

One session drives the desktop at a time. A second session that tries to
act is refused naming the first — its process id and how long it has been
driving. A session that stops driving frees the desktop within half a
minute of its last act, the moment its turn is interrupted, and when it
exits.

## Not in this release

Sub-agents, teammates and clients of the MCP serve surface never carry the
Computer tool. A bare headless run without an approval channel cannot
drive. The interactive cockpit runs its turn in a background worker whose
approval channel sends the consent card back to the cockpit. A non-interactive
caller needs that approval channel, and keystrokes still refuse when the
terminal running the session cannot be identified.

## The driver

Computer use runs through Mercury's own desktop driver: a native module over
the platform's screen and input layers (CoreGraphics on macOS, GDI and
SendInput on Windows, X11 with the XTEST extension on Linux), built from the
repository's `native/desktop` sources with cargo by
`bun run scripts/vendor/build-desktop.ts`, which `bun run setup` runs last.
It is built rather than fetched: a machine without a Rust toolchain builds
and runs Mercury without it, the build says so, and the Computer tool stays
out of the catalog until the pack is built — the doctor's row names the
build command. Release archives carry the driver for their platform when
the packaging host could build it. Nothing else is installed on your machine. Every screenshot,
including the default capture after an act, is kept under `desktop-shots`
with the retention limit described above.

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
is information with the fix beside it, never a fault: the rest of Mercury
does not depend on computer use. The doctor never opens a system dialog;
the first capture or act does.

A held mouse button or key is released when you interrupt, when the turn
ends, and when Mercury exits. If Mercury is killed in the middle of a
press, the platform keeps the button down until your next physical click.
The environment variables are listed in `src/substrate/flagRegistry.ts`.
