# Browser

Browser drives a separate browser for each agent. An approval belongs to that agent and lasts only while its browser remains open.

## Sessions

Child browsers are not counted by default: every crewmate that opens a page gets its own, and the machine is the limit. Setting `MERCURY_BROWSER_MAX_SESSIONS` to a positive number caps the child browsers of one parent session at that number, with an additional slot reserved for the lead. Children cannot consume the lead's slot, and separate parent sessions have separate allowances.

A browser closes after five minutes without an operation. This leaves time to read and reason between acts while releasing unused browsers. Running operations keep their browser alive; the five-minute lease starts again when the last operation finishes. Closing or expiry clears origin approvals and secret-fill approvals. Use `op:"open"` to start another browser, or `op:"close"` to release one immediately.

## Emulation

`viewport` takes an `emulation` object that changes what a page reports about its device and surroundings. `device` names a profile from the bundled driver's catalogue, which `op:"devices"` lists. The other fields are `userAgent`, `mobile`, `touch`, `landscape`, `timezone`, `locale`, `cpuSlowdown` (a factor), `network` (`slow3g`, `fast3g`, `slow4g`, `fast4g`, or `download` and `upload` in bytes per second with `latency` in milliseconds), `offline`, `geolocation` (`latitude`, `longitude`, `accuracy`), `colorScheme` (`dark`, `light`, `no-preference`) and `reducedMotion`.

A field left out keeps its value, `null` clears it, and `reset: true` returns the page to the state it launched in. Explicit fields win over the device, and choosing a device replaces an earlier explicit size and user agent. Sizes given together with `emulation` are used as written. A plain `viewport` call keeps its range of 320 to 3840 by 240 to 2160; while a device is active it changes the size and the page stays that device. The answer lists what is in force, names any field the browser refused and leaves the earlier value of that field in place.

An emulated identity is one identity: the user agent, the platform, the client hints and the languages that a site reads and receives agree with the device or locale that was asked for. A changed user agent applies to the requests that follow, so a document fetched before the change needs a `reload` to be served again; switching `mobile` or `touch` reloads the page by itself. The engine stays Chromium, so a phone profile is not that phone's browser.

Emulation belongs to the page. It survives navigation, it comes along when opening another origin moves the page into another browser, and it ends with `reset`, with `close` or with the browser. After a browser was lost, the next `open` says which settings went with it. A geolocation override grants the browser's own location permission to the origins the page visits; it approves nothing for Mercury.

## Frames

`extract` lists child-frame indices and URLs. Pass `frame: 1` for the first child frame, `frame: 0` for the main frame, or a unique URL substring such as `frame: "/embedded-form"`. Use this with click, type, scroll, waitFor, select, hover, extract or an element screenshot. CSS, accessible-name, text, XPath and `>>>` shadow selectors resolve inside the selected frame. A missing or ambiguous frame fails the act; the main page is never targeted by mistake.

Frame acts require approval for the frame's own origin. The embedding page's approval does not cover a different origin; secret fills keep their separate secret-origin approval. An opaque sandboxed frame cannot borrow the embedding page's origin for a secret fill.

## Covered targets

A selector click checks for overlays in the frame and its embedding frames. When another element covers the target, the result names it and suggests clicking it to dismiss it or scrolling the target into view.

After reading the overlay, `force: true` with a selector dispatches a DOM click directly to the covered target. This is not a pointer click through the overlay. The default actionability check remains in place, and disabled controls still refuse.
