# Browser

Browser drives a separate browser session for each agent, with as many named tabs as the agent opens. An approval belongs to that agent and lasts only while its session remains open.

## Sessions

Child browsers are not counted by default: every crewmate that opens a page gets its own, and the machine is the limit. Setting `MERCURY_BROWSER_MAX_SESSIONS` to a positive number caps the child browsers of one parent session at that number, with an additional slot reserved for the lead. Children cannot consume the lead's slot, and separate parent sessions have separate allowances.

A browser closes after five minutes without an operation. This leaves time to read and reason between acts while releasing unused browsers. Running operations keep their browser alive; the five-minute lease starts again when the last operation finishes. Closing or expiry clears origin approvals and secret-fill approvals. Use `op:"open"` to start another browser, or `op:"close"` to release one immediately.

`persist: true` on `open` keeps that tab, and the browser that holds it, past the lease until it is closed or the agent ends. The lease then closes the other tabs, and the session goes on with the kept ones and its approvals. `persist: false` gives the tab back to the lease.

## Tabs

Every operation on a page takes `tab`, the name of the page it addresses; without it the page is `main`. `open` with a new name opens another page beside those already open. With a name and no `url` it opens a blank page, on which emulation can be set before the first address loads. Names belong to the agent: two agents can each have a `main` and a `docs`, and neither sees, lists or closes the other's.

A tab lives in the browser of the origin it was opened to, and every origin keeps its own browser and stored profile. Tabs opened to one origin share that browser, its cookies and its storage. A tab opened to another origin starts a second browser and the first stays. `open` to another origin on a tab that already exists moves the tab: its old page is closed and a new page starts in the other browser, with the tab's emulation.

Each tab keeps its own page, history, console ring, viewport, emulation and cursor. An approval for an origin holds across the agent's tabs, and a secret keeps its separate secret-and-origin approval. A permission check belongs to the page and frame it was made for: if the tab holds another page by the time the act runs, the act is refused and can be issued again.

A tab that the agent's own act opens (a click, a key, a submitted form, a page it opened) is kept as a tab named `popup`, then `popup-2` and so on, and the act's answer names it and the address it landed on. It keeps what only that window holds: its opener, and the answer to a form that was posted into it. It starts with the identity its opener presents, emulation included, and its first request already carries it. No approval comes with it: an origin the agent has not approved asks at the first act there. A tab that no act opened is closed, and a new tab that turns out to be a download is reported as a download.

A tab whose page crashed says so at once: a call on it answers that the page crashed, and a wait that was running on it ends with the same words. `reload` or `open` loads the page again and says what the fresh load lost, form values and script state, and what stayed, history, cookies and stored data. The tabs beside it are not touched.

`status` lists the tabs when there is more than `main`: name, address, title, page number, viewport and whether the tab is kept past the lease. The page number changes when a tab gets a new page. A long list continues with `offset`.

`close` with `tab` closes that tab alone, and closing the last tab ends the session; `close` without `tab` ends the session with every tab. The number of tabs has no limit, and tabs do not count against `MERCURY_BROWSER_MAX_SESSIONS`.

## Emulation

`viewport` takes an `emulation` object that changes what a page reports about its device and surroundings. `device` names a profile from the bundled driver's catalogue, which `op:"devices"` lists. The other fields are `userAgent`, `mobile`, `touch`, `landscape`, `timezone`, `locale`, `cpuSlowdown` (a factor), `network` (`slow3g`, `fast3g`, `slow4g`, `fast4g`, or `download` and `upload` in bytes per second with `latency` in milliseconds), `offline`, `geolocation` (`latitude`, `longitude`, `accuracy`), `colorScheme` (`dark`, `light`, `no-preference`), `reducedMotion`, `headers` and `credentials`.

A field left out keeps its value, `null` clears it, and `reset: true` returns the page to the state it launched in. Explicit fields win over the device, and choosing a device replaces an earlier explicit size and user agent. Sizes given together with `emulation` are used as written. A plain `viewport` call keeps its range of 320 to 3840 by 240 to 2160; while a device is active it changes the size and the page stays that device. The answer lists what is in force, names any field the browser refused and leaves the earlier value of that field in place.

An emulated identity is one identity: the user agent, the platform, the client hints and the languages that a site reads and receives agree with the device or locale that was asked for. A changed user agent applies to the requests that follow, so a document fetched before the change needs a `reload` to be served again; switching `mobile` or `touch` reloads the page by itself. The engine stays Chromium, so a phone profile is not that phone's browser.

`headers` adds request headers to every request the page makes, and `credentials` answers a site's basic authentication with a `username` and either a `password` or a `secret` that names a registered secret. Both send something to a site, so they need the approval of the page's origin, as an act there does, and a secret needs its own secret-and-origin approval. Credentials answer the challenges of that one origin and no other. A site that asks for credentials fails to open: open it, set the credentials, then `reload`. Clearing or replacing them stops answering new challenges; what the browser has already answered stays answered until that browser closes. A password is never shown in an answer.

Emulation belongs to the page. It survives navigation, it comes along when opening another origin moves the page into another browser, and it ends with `reset`, with `close` or with the browser. After a browser was lost, the next `open` says which settings went with it. A geolocation override grants the browser's own location permission to the origins the page visits; it approves nothing for Mercury.

## Frames

`extract` lists child-frame indices and URLs. Pass `frame: 1` for the first child frame, `frame: 0` for the main frame, or a unique URL substring such as `frame: "/embedded-form"`. Use this with click, type, scroll, waitFor, select, hover, extract or an element screenshot. CSS, accessible-name, text, XPath and `>>>` shadow selectors resolve inside the selected frame. A missing or ambiguous frame fails the act; the main page is never targeted by mistake.

Frame acts require approval for the frame's own origin. The embedding page's approval does not cover a different origin; secret fills keep their separate secret-origin approval. An opaque sandboxed frame cannot borrow the embedding page's origin for a secret fill.

## Covered targets

A selector click checks for overlays in the frame and its embedding frames. When another element covers the target, the result names it and suggests clicking it to dismiss it or scrolling the target into view.

After reading the overlay, `force: true` with a selector dispatches a DOM click directly to the covered target. This is not a pointer click through the overlay. The default actionability check remains in place, and disabled controls still refuse.
