# Computer use

Computer use is the Computer tool: the model takes a screenshot of your
screen, decides, then clicks, types, presses keys, scrolls or drags in the
application in front, and sees a fresh screenshot after every act. Mercury
checks the application's identity and your permission rules, grants and
access setting before acting. When approval is needed, it asks by the
application's name. It is on by default when the desktop driver is available;
the rest of Mercury does not depend on it.

## Targeting controls and taking fewer screenshots

Read `tree` when a control's name answers the question; use a screenshot when
pixels matter. Mouse actions accept `target: { role, name, text }` instead of
`x` and `y`: role and name match exactly, ignoring case and repeated whitespace;
text matches a substring of the title or value. Supply only the fields needed
to identify one element. A missing, ambiguous or truncated match, or an element
without bounds, refuses with a remedy. Targets are resolved afresh before the
act. `find` accepts the same target and returns matching bounds without an image.

For example, `click` with `target: { role: "AXButton", name: "Save" }` clicks
that control's centre. `move` hovers over a target; `scroll` scrolls at it;
`drag` accepts a start target and a `toTarget` destination. Pixel coordinates
remain available. `click` also accepts `count: 3` for a triple-click.

`settleMs` caps post-action settling time instead of sleeping for a fixed
duration: once two consecutive captures match, settling finishes early. Its
default is 300 ms and its cap is 5000 ms. The result reports whether the screen
stabilized or reached the cap. Intermediate frames are neither saved nor sent to
the model. `capture: false` skips both capture and settling when the next step
does not need pixels.

`wait` accepts `until: { role, name, text }` to poll the application's tree
until a matching element appears, bounded by `durationMs` (default 1000 ms,
cap 10000 ms). If the deadline passes or the front window changes, the call
reports that failure instead of succeeding. `capture: false` makes this an
image-free check.

A screenshot, or the screenshot after an act, can take
`region: { x, y, width, height }` in pixels of the last screenshot. The saved
and transmitted image contains only that rectangle; its top-left becomes
`(0, 0)` for subsequent pixel actions. Mercury captures the full display locally
and crops the image before saving and sending it, which reduces image size
without changing display capture time.

`sequence` takes `steps`, an ordered array of ordinary act inputs. For example:

```json
{
  "action": "sequence",
  "steps": [
    { "action": "click", "target": { "role": "AXTextField", "name": "Search" } },
    { "action": "type", "text": "release notes" },
    { "action": "key", "key": "Enter" }
  ]
}
```

Each step goes through the same permission and safety checks as an individual
call. A refusal or interruption stops the sequence and reports how many acts
completed; completed acts are not undone. One screenshot follows the final act.
Set `capture`, `region` and `settleMs` on the top-level `sequence` call instead
of individual steps. `steps` accepts input actions only (no reads or nested
sequences).

`find` and `wait` with `until` read the tree and therefore ask like `tree`.
A timed wait without `until` remains a never-ask read. Targeted mouse actions
keep their existing act permission class. The access types and sovereign mode
work identically for individual acts and sequences.

## Operator typing and human verification

Before acting, Mercury waits for 1400 ms without recent keyboard activity,
for at most 3000 ms. Continued typing refuses the act with
“the operator is typing — nothing done; try again in a moment”. A final check
also refuses if typing resumes while the target is being checked. This typing
pause is a safety check that applies in every access type, including sovereign
mode, and is separate from permission prompts. It checks composer activity in
the current process and, on macOS, HID keyboard activity reported by the desktop
driver. Other platforms and older packs without the optional idle read use the
local composer signal; they do not claim to detect typing in another process or
application.

Mercury never solves a captcha. Named reCAPTCHA, hCaptcha, Turnstile and human
verification challenges in the accessibility tree stop input and hand the step
to you. When a challenge is visible only in screenshot pixels, the model is
instructed to report `captcha: true`; the tool refuses that input too. Mercury
does not run OCR on screenshots, so a purely visual challenge is caught only
when the model reports it. Complete the challenge yourself, then let Mercury
read the screen again.

## Turning it off

Turn the Boot Menu's `Computer use` row off (it is on by default, and the
change reaches new sessions) or set `MERCURY_COMPUTER_USE=0` in the
environment before the session starts. A session already running keeps the
tool list it started with until the next compaction or `/clear`, so set
the switch before you boot. With the
switch off the Computer tool is not in the catalog at all and no desktop
driver is touched. On a machine without the desktop driver the tool is
absent from the catalog as well: the catalog decides when it is built,
never when the model calls, so the model is never given a tool that
cannot work. `mercury health` and `/health` carry a `Computer use` row that
names what is missing (the driver, a grant, or the kind of session) with
the fix beside it.

## The asks

Screenshots and the other reads (the cursor, the displays, the application
in front, a timed wait) never ask. With the access type at `asks` (the
default), the first act in each application (a click, a drag, a scroll,
typed text, a key) asks by the application's name and identity, the card
names the act, and it asks how long you want to allow. Five answers, in
this order:

- **Yes** allows this act and every later act in this application for the
  rest of the session.
- **No, and tell Mercury what to do differently** refuses the act and hands
  the composer back to you.
- **Yes, for 1 hour (every application)** allows every act in every
  application for one hour from now.
- **Yes, for 24 hours (every application)** does the same for twenty-four
  hours.
- **Enable sovereign mode to avoid further permissions by default** turns
  sovereign mode on for this session and saves the Boot Menu's `Sovereign
  mode` row, so no later session asks either, for anything, until you
  turn the row off. Under sovereign mode the card never appears.

A timed grant lives with the session: a resume inside its span keeps it, a
new session never inherits it, and it is never written into your settings.
When it runs out, the next first act asks again; nothing timed is
permanent, and acts made under it leave no per-application grant behind.
An act that lands in another application asks for that one before the next
act there. An application that moved in front between the ask and the act
is not driven: the act is refused and the model takes a new screenshot. No
classifier answers this ask: because the foreground window determines the target application,
the consent is yours alone, and sovereign mode is the one posture that
answers it automatically, whatever the access type below saves.

One read asks like an act: `tree`, the accessibility tree of the
application in front. It answers one line per element, indented by depth,
with the element's role, title, value and frame in screen points (and the
centre in pixels of the last screenshot, so the model can click it), bounded
by a depth and a count the model may set; when the tree goes on past them
the result says so. It is read on macOS through the Accessibility API, under
the same Accessibility grant as the keyboard; it sends no input and reads no
clipboard. Because it reads what an application shows (its controls and
their text), the first tree in an application asks by the application's
name like a first act, and the grant it leaves is the same one: later trees
and acts in that application ride it. On Windows and Linux the action says
plainly that this release reads the tree on macOS only.

## The access type

Under the Boot Menu's `Computer use` row sits `Access type`, with three
values. `asks`, the default, is the card above: the first act in each
application asks, a Yes covers that application for the session, and the
timed grants cover every application for their span. `permissive` takes
the application in front at the turn's first Computer call (the
screenshot the model takes before it acts counts, because that is the
moment the task began, before the model could have moved anything) as
the turn's home application: acts in it never ask, and an act that lands
in any other application asks once, with the same card, a Yes covering
that application for the session. A new turn records a new home
application, and an act in the home application leaves no grant behind, so
an application that was home in one turn asks in the next unless you said
Yes to it. If the home application is the terminal running Mercury, the
terminal refusal stands and the first act elsewhere asks. `full` never
asks.

Unset, the row follows sovereign mode: with the `Sovereign mode` row on the
default is `full`, and the row's value reads `default (full · sovereign
mode)`; with it off the default is `asks`, and it reads `default (asks)`.
Sovereign mode writes nothing into the row. With sovereign mode on nothing
asks, whatever the row saves; the saved value applies with sovereign mode
off (`full` saved then makes computer use never ask while files and
commands ask as the permission mode says). Whatever the value, a
`guardrails.deny` rule refuses its application before any act, the
terminal running Mercury is never typed into, an application that moved in
front between the check and the act is not driven, and one session drives
at a time. The row is saved where the Boot Menu keeps its other choices and
reaches new sessions; `MERCURY_COMPUTER_ACCESS=asks`, `=permissive` or
`=full` in the environment sets it for one session. Any other value produces
a diagnostic note and the default applies. `mercury health` and `/health`
name the access beside the switch: `computer use on · access asks`,
`access permissive`, `access full (by sovereign mode)` or `access full
(saved)`.

## Sovereign mode

Sovereign mode is Mercury's one bypass, and computer use is under it like
everything else: with sovereign mode on, no permission card of any
kind is shown (for files, commands, or computer use)
and the crimson band says so; you accept every risk, and Flow mode is where
the guardrails live. The Boot Menu's `Sovereign mode` row (in the trust
combo) turns it on for new sessions and shows a small amber warning line
under it while it is on; the ask card's last answer turns it on for the
running session and saves the same row; `shift+tab` reaches it in a
session launched with the bypass flag. Computer use follows it whatever the
`Access type` row saves: under sovereign mode the first act in an
application never asks, and the row's saved value applies when sovereign
mode is off. What stays under sovereign mode is what was never a question: a
`guardrails.deny` rule refuses its application before any act, the
terminal running Mercury is never typed into, and an application that
moved in front between the check and the act is not driven. `mercury
health` and `/health` carry a `Sovereign mode` row that names the one
setting and what armed it.

## The allowlist

A grant that outlives the session is a permission rule in the
`guardrails.allow` list of your settings: `Computer(app:<identity>)`,
where the identity is the one the application's row shows beside its name:
a bundle identifier on macOS (`com.apple.Safari`), an executable name on
Windows (`chrome.exe`), or a window class on Linux (`firefox`). You write the
rule yourself; the card writes none. A rule in `guardrails.deny` refuses
that application before any ask, in every mode; a rule in `guardrails.ask`
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
or high-density screen is downscaled before sending; the file on disk keeps
its full size). The conversation file never carries the image: it keeps a
line naming the file, so a saved conversation stays small and a resumed
one takes a new screenshot before acting. In the request the model sees the
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
applications, and a click must land outside the terminal's window. Another
window of the same application can be driven when both window identities
are known. On macOS, Apple Terminal and iTerm2 map the terminal UI's tty to its
window through their scripting bridge; titles and window positions are not
ownership evidence. A worker uses the tty supplied by the attached terminal UI
(the daemon that spawned it has none). Each guard check resolves that tty afresh,
so moving a tab between windows does not leave stale ownership behind.
The lookup runs only when the terminal application is in front, in a
separate helper with a 1000 ms deadline. `MERCURY_DESKTOP_OWNER_TIMEOUT_MS`
accepts 1–5000 ms; an invalid value keeps the default. A failed or timed-out
lookup keeps the application-wide guard and does not block the event loop.

On macOS, each front-application check runs in a fresh native helper, so a
long-lived worker does not reuse an application cached before you switched
apps. A failed query refuses instead of reusing the previous answer.

The front window comes from the Accessibility API (as opposed to the first window in
the screen list, which may be a fullscreen title panel). Mercury resolves
the private `_AXUIElementGetWindow` symbol at runtime. If it is unavailable,
exact position and size must identify one on-screen window of that process;
ambiguous matches stay unknown. When both mappings answer, they must agree.
This path checks the existing Accessibility grant without opening a dialog.

When either window identity is unknown, the guard still protects every
window of the terminal application and states that it is comparing the
application as a whole. Windows, Linux, terminal multiplexers and
terminals without a supported scripting bridge take that conservative
road. If the application itself cannot be identified, typing, holding keys
and ordinary key chords refuse without guessing; the application-switch
chord remains available.

## Models and routes

The tool works with a model that receives images. On a route that carries
text only it refuses and names the route; `/model` switches to a model that
sees. A model that refuses images on its own route is refused for the rest
of the session on that model, with the provider's words, until you switch
models.

## One session at a time

One session drives the desktop at a time. A second session that tries to
act is refused naming the first (its process id and how long it has been
driving). A session that stops driving frees the desktop within half a
minute of its last act, the moment its turn is interrupted, and when it
exits.

## Scope

Crewmates and clients of the MCP serve surface never carry the
Computer tool. A bare `mercury run` cannot drive. A hosted session runs in a
`mercury runner` child whose host answers permission asks; the interactive
terminal UI presents those asks as consent cards. A non-interactive caller needs
a host that can answer them, and keystrokes still refuse when the terminal
running the session cannot be identified.

## The driver

Computer use runs through Mercury's own desktop driver: a native module over
the platform's screen and input layers (CoreGraphics on macOS, GDI and
SendInput on Windows, X11 with the XTEST extension on Linux), built from the
repository's `native/desktop` sources with cargo by
`bun run scripts/vendor/build-desktop.ts`, which `bun run setup` runs last.
It is built from source: a machine without a Rust toolchain builds
and runs Mercury without it, the build says so, and the Computer tool stays
out of the catalog until the pack is built (the health check's row names the
build command). Release archives carry the driver for their platform when
the packaging host could build it. Nothing else is installed on your machine. Every screenshot,
including the default capture after an act, is kept under `desktop-shots`
with the retention limit described above.

## What each platform needs

- **macOS**: two grants for your terminal application (Terminal, iTerm2,
  WezTerm, or whichever runs Mercury), under System Settings → Privacy &
  Security: **Screen Recording**, so the driver can see the screen, and
  **Accessibility**, so it can move the mouse and type. The first capture
  or act asks the system to register the terminal in both lists; after you
  allow, restart the terminal application. Without Screen Recording, macOS
  hands out a picture of the wallpaper with every other window blanked;
  Mercury refuses to work from that and names the grant instead. Without
  Accessibility, macOS silently drops synthetic input; Mercury refuses the
  act and names the grant. Recent macOS versions ask now and then whether
  the terminal application may keep recording the screen; allow it and the
  captures continue.
- **Windows**: an interactive desktop session (a locked desktop, a background
  service, and a disconnected remote session are refused). No grant dialog
  exists. Windows drops input into a window that runs elevated when Mercury
  does not; run Mercury elevated if you need to drive such a window.
- **Linux**: an X11 session with `DISPLAY` set. The XTEST and RandR
  extensions every X server carries are all the driver needs. A Wayland
  session is refused by name: the driver could see only part of such a
  desktop and refuses instead of returning partial captures.

Keyboard shortcuts on a non-US layout land on the US key positions on
macOS in this release; typed text is always layout-correct.

## The health check

`mercury health` and `/health` carry a `Computer use` row in the INTERFACE
section. Its line names the pack (its version and platform, and whether it
was found beside the bundle, in the checkout, or through
`MERCURY_DESKTOP_PACK_DIR`), the screen and input grants, the kind of
session Mercury runs in, whether computer use is on, and the access type in
words (`access asks`, `access permissive`, `access full (by sovereign
mode)`, `access full (saved)`). The detail lists
the displays with their sizes and scales, the frontmost application, the
permission words for your platform, and which session is driving the
desktop right now, if any (one session drives at a time). A missing grant
is information with the fix beside it, never a fault: the rest of Mercury
does not depend on computer use. The health check never opens a system dialog;
the first capture or act does.

A held mouse button or key is released when you interrupt, when the turn
ends, and when Mercury exits. If Mercury is killed in the middle of a
press, the platform keeps the button down until your next physical click.
The environment variables are listed in `src/substrate/flagRegistry.ts`.
