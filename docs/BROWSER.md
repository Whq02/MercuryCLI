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

A tab that the agent's own act opens (a click, a key, a submitted form, a page it opened) is kept as a tab named `popup`, then `popup-2` and so on, and the act's answer names it and the address it landed on. It keeps what only that window holds: its opener, and the answer to a form that was posted into it. It starts with the identity its opener presents, emulation included, and its first request already carries it. No approval comes with it: an origin the agent has not approved asks at the first act there. A tab that no act opened is closed, and a new tab that turns out to be a download is saved as a download of the act that opened it.

A tab whose page crashed says so at once: a call on it answers that the page crashed, and a wait that was running on it ends with the same words. `reload` or `open` loads the page again and says what the fresh load lost, form values and script state, and what stayed, history, cookies and stored data. The tabs beside it are not touched.

`status` lists the tabs when there is more than `main`: name, address, title, page number, viewport and whether the tab is kept past the lease. The page number changes when a tab gets a new page. A long list continues with `offset`.

`close` with `tab` closes that tab alone, and closing the last tab ends the session; `close` without `tab` ends the session with every tab. The number of tabs has no limit, and tabs do not count against `MERCURY_BROWSER_MAX_SESSIONS`.

## Emulation

`viewport` takes an `emulation` object that changes what a page reports about its device and surroundings. `device` names a profile from the bundled driver's catalogue, which `op:"devices"` lists. The other fields are `userAgent`, `mobile`, `touch`, `landscape`, `timezone`, `locale`, `cpuSlowdown` (a factor), `network` (`slow3g`, `fast3g`, `slow4g`, `fast4g`, or `download` and `upload` in bytes per second with `latency` in milliseconds), `offline`, `geolocation` (`latitude`, `longitude`, `accuracy`), `colorScheme` (`dark`, `light`, `no-preference`), `reducedMotion`, `headers` and `credentials`.

A field left out keeps its value, `null` clears it, and `reset: true` returns the page to the state it launched in. Explicit fields win over the device, and choosing a device replaces an earlier explicit size and user agent. Sizes given together with `emulation` are used as written. A plain `viewport` call keeps its range of 320 to 3840 by 240 to 2160; while a device is active it changes the size and the page stays that device. The answer lists what is in force, names any field the browser refused and leaves the earlier value of that field in place.

An emulated identity is one identity: the user agent, the platform, the client hints and the languages that a site reads and receives agree with the device or locale that was asked for. A changed user agent applies to the requests that follow, so a document fetched before the change needs a `reload` to be served again; switching `mobile` or `touch` reloads the page by itself. The engine stays Chromium, so a phone profile is not that phone's browser.

`headers` adds request headers to every request the page makes, and `credentials` answers a site's basic authentication with a `username` and either a `password` or a `secret` that names a registered secret. Both send something to a site, so they need the approval of the page's origin, as an act there does, and a secret needs its own secret-and-origin approval. Credentials answer the challenges of that one origin and no other. A site that asks for credentials fails to open: open it, set the credentials, then `reload`. Clearing or replacing them stops answering new challenges; what the browser has already answered stays answered until that browser closes. A password is never shown in an answer.

Emulation belongs to the page. It survives navigation, it comes along when opening another origin moves the page into another browser, and it ends with `reset`, with `close` or with the browser. After a browser was lost, the next `open` says which settings went with it. A geolocation override grants the browser's own location permission to the origins the page visits; it approves nothing for Mercury.

## Downloads

A download that one of the agent's acts starts is saved: a click, a key, a submitted form, or an `open` whose address is a file. The answer to that act says where the file is, its size, the type the server declared or that none was declared, the name the site suggested, the address it came from and the SHA-256 of the saved bytes. Each file gets a folder of its own under the session scratchpad, `browser-downloads/d1`, then `d2` and so on, so two files with one name never meet and a suggested name with a path in it stays in its folder. The scratchpad belongs to the session and goes with it; a file that should stay is copied or moved with the ordinary file tools, under their rules.

A page often starts the file after the act has returned: an export that is prepared first, or a page that says the download begins in a few seconds. Such a download is saved when the agent has clicked, typed, selected or pressed a key on that tab since its last `open`, and the next answer on that tab names it once. A tab that was only opened and read saves nothing that a page pushes by itself: its next answer and its console say that a file was offered and not saved, and name the road. That road is `download` with `url` or `selector`: it opens the address or clicks the control, waits `timeoutMs` for a file to begin, and the tab is followed from then on.

A file that is still arriving when the answer is written is reported with an id and how much of it has come. `download` with `downloadId` waits for it, ten seconds by default and `timeoutMs` up to thirty, and answers that it is saved, that it failed, or that it is still arriving; calling again goes on waiting for the same transfer, and nothing is clicked or requested a second time. A transfer has no size limit and no time limit, and one that has stopped receiving says for how long. `download` alone lists the agent's transfers in the order they began, each with its tab, and a long list continues with `offset`.

A transfer belongs to the agent that started it, and no other agent's list shows it. A browser stays for a download that is still arriving in it: the idle lease waits while bytes keep coming, and a tab that moves to another origin leaves its old browser running until the transfer has ended. Closing the tab or the session ends the transfers still arriving there, which are then reported as failed, and leaves the saved files in place. `download` with `downloadId` or alone only reads and asks nothing; with `url` or `selector` it is the open or the click it performs and meets the same approval. Nothing is written for downloads until one begins.

## Uploads

`upload` takes a `selector` and `files`, a list of local paths, absolute or relative to the session's working folder. The selector names a file input, a control that opens a file chooser when clicked, or a zone that takes dropped files, and `frame` names the frame it is in. A file input receives the files directly, whether or not it is visible, with the `input` and `change` events a person's choice gives; an empty list clears it. A control that opens a chooser is clicked and the files go to the input the chooser belongs to. A drop zone receives the drag and the drop. A folder is sent to a folder input (`webkitdirectory`) with the relative paths of its files.

Two existing decisions stand before any byte moves. Every file, and every file inside a folder, meets the decision `Read` has for it: a deny rule denies the upload in every mode, a file `Read` would ask about asks in the same words, and a link is judged by where it leads. The page or frame that receives the files meets the act approval of its own origin, as a click there does. An upload gives no read coverage of the file. What was judged is what is sent: a link that leads elsewhere, a folder that gained a file, or a frame that went to another origin between the check and the upload is refused, and the upload can be issued again.

The browser reads copies that are made in the session scratchpad when the upload runs, so the page still has the whole file if the original changes or is removed afterwards, with its name, size, type and modification time. The copies are removed when the agent's last browser closes. No size limit applies.

The answer says what the page holds: the files an input has after the call, or that the page took a drop. That is the page's side only. Nothing reaches the site until the page sends it, and whether the site accepted a file is for the page to show. A refusal names its reason and sends nothing: a path that does not exist, several files for an input that takes one, a folder for an input that is not a folder input, a zone that accepted the drag and did not take the drop, a control that opened no chooser (its click went through), or the page's own file picker (`showOpenFilePicker`), which cannot be filled.

## Frames

`extract` lists child-frame indices and URLs. Pass `frame: 1` for the first child frame, `frame: 0` for the main frame, or a unique URL substring such as `frame: "/embedded-form"`. Use this with click, type, scroll, waitFor, select, hover, extract or an element screenshot. CSS, accessible-name, text, XPath and `>>>` shadow selectors resolve inside the selected frame. A missing or ambiguous frame fails the act; the main page is never targeted by mistake.

Frame acts require approval for the frame's own origin. The embedding page's approval does not cover a different origin; secret fills keep their separate secret-origin approval. An opaque sandboxed frame cannot borrow the embedding page's origin for a secret fill.

## Covered targets

A selector click checks for overlays in the frame and its embedding frames. When another element covers the target, the result names it and suggests clicking it to dismiss it or scrolling the target into view.

After reading the overlay, `force: true` with a selector dispatches a DOM click directly to the covered target. This is not a pointer click through the overlay. The default actionability check remains in place, and disabled controls still refuse.
