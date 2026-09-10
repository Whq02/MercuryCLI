# Computer use

Computer use is the Computer tool: the model takes a screenshot of your
screen, decides, then clicks, types, presses keys, scrolls or drags in the
application in front, and sees a fresh screenshot after every act. Nothing
runs without your consent: the first act in each application asks you by
the application's name. It is off by default, and the rest of Mercury does
not depend on it.

## Turning it on

Set `MERCURY_COMPUTER_USE=1` in the environment before the session starts,
or turn it on in the Boot Menu's environment rows. A session already
running keeps the tool list it started with until the next compaction or
`/clear`, so set the switch before you boot. Off is the default: without the
switch the Computer tool is not in the catalog at all. `mercury doctor` and
`/health` carry a `Computer use` row that names what is missing — the
driver, a grant, the kind of session — with the fix beside it.

## The asks

Screenshots and the other reads — the cursor, the displays, the application
in front, a timed wait — never ask. The first act in each application — a
click, a drag, a scroll, typed text, a key — asks by the application's name
and identity, and the card names the act. Three answers:

- **Yes** allows this act and every later act in this application for the
  rest of the session.
- **Yes, and don't ask again for this application in this project** allows
  it and writes the allowlist rule below into the project's local settings,
  so the next session does not ask for this application either.
- **No, and tell Mercury what to do differently** refuses the act and hands
  the composer back to you.

An act that lands in another application asks for that one before the next
act there. An application that moved in front between the ask and the act
is not driven: the act is refused and the model takes a new screenshot. No
permission mode skips this ask and no classifier answers it: the screen,
not you, chose the application, so the consent is yours alone.

## The allowlist

A grant that outlives the session is a permission rule in the
`permissions.allow` list of your settings: `Computer(app:<identity>)`,
where the identity is the one the application's row shows beside its name
— a bundle identifier on macOS (`com.apple.Safari`), an executable name on
Windows (`chrome.exe`), a window class on Linux (`firefox`). The second
answer on the card writes the rule into `.mercury/settings.local.json` in
the project. A rule in `permissions.deny` refuses that application before
any ask. A rule written on one platform matches only that platform's
identities.

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
applications, and a click must land outside the terminal's window.

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

Sub-agents, teammates, headless runs and clients of the MCP serve surface
never carry the Computer tool; the main session of an interactive
conversation drives, and nothing else does.
