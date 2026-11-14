# Files on another machine

Read, Edit, Write, Grep and Glob take a path on another machine wherever they take a path on this one:

```
ssh://web1/srv/app/config.yml
ssh://deploy@web1:2222/var/log/app.log
ssh://web1/~/notes.md
```

`web1` is whatever `ssh web1` accepts: a `Host` of your ssh configuration, a name, an address. Nothing is set up in Mercury. Your ssh configuration, your keys and your agent are used as they are, and a host whose key is not known is refused in ssh's own words: Mercury never answers a host-key question for you, and never asks for a password inside a file call.

## The path

- `ssh://host/abs/path` is an absolute path on that machine.
- `ssh://host/~/x` is under the home of the account that signs in; `ssh://host/~name/x` is under another account's home; `ssh://host` alone is the home folder.
- `ssh://user@host:port/path` names the account and the port. An IPv6 address is written in brackets: `ssh://[2001:db8::7]:2222/etc/hosts`. A path written with a password is refused: ssh signs in with your keys and agent.
- A character with a meaning in a path is written with a percent sign: `%20` for a space is accepted, `%25` is a percent sign, `%7E` is a literal tilde. A space may also be written as a space.
- `ssh://host/path/file.log:120-180` is Read's line selector, as on a local path. A file whose own name ends in a colon and a number is read as that file.
- Read of `ssh://` alone lists the hosts of your ssh configuration: the names with no wildcard, from `~/.ssh/config`, the files it includes and the system file. Any destination ssh accepts is a path too, listed or not.

## What each tool does

- **Read** pages a remote file as it pages a local one: only the page asked for travels, whatever the file's size, and a folder is listed. Images, PDFs, notebooks, office documents, databases, archives and their entries are read as they are locally, from a private copy that is removed when the answer is built.
- **Write** creates the file and its folders, or replaces a file that was read. Line endings, a byte-order mark and UTF-16 are kept; the file's mode is kept; a link is written through.
- **Edit** works in all four ways (old and new text, hunks, append, section) on the file as the remote machine holds it at that moment.
- **Glob** and **Grep** search a remote folder with the patterns, ignore files, types and output of a local search. The remote machine lists the names; Mercury's own ripgrep does the selecting and the searching, over the files it selected, in a private folder that is removed when the call ends. A Grep answer closes with what was read to find it, for example `(read 214 files, 3.1 MB, from web1)`.

Found and written files are named as `ssh://` paths in the spelling the path was written in, so each can be handed to the next tool as it stands.

The first prompt of a conversation that holds an `ssh://` path tells the model, once, that such a path is a file on another machine. A prompt without one sends nothing about any of this, and starts nothing.

## Changes are checked

An Edit or a Write of a file that is there needs the file to have been read in the session, as on this machine. Mercury keeps the file's time, size and checksum from that read; a file that another writer changed since is not edited or replaced, and the answer says so. The bytes are written beside the file and renamed over it only if the file still holds what was read, and the result is read back before the answer says the file was written. The check and the rename are one request to the remote machine; they are not one atomic step of its file system.

Read a remote file before an Edit: the lines a search shows do not count as read.

A rewind does not reach another machine. The rewind page says which files stay as written there.

## Permissions

A rule whose pattern begins `ssh://` is a rule for a remote path, in the same lists as every other rule:

```json
{ "guardrails": { "allow": ["Read(ssh://web1/**)"], "deny": ["Read(ssh://*/**/.env)", "Edit(ssh://web1/etc/**)"] } }
```

- A rule that names a host covers every account and port on it; `user@` and `:port` narrow it. A `Host` name of your ssh configuration and its `HostName` are one host. Two names for one machine that your ssh configuration does not relate, such as a DNS alias, are two hosts to a rule.
- A rule for a local path never matches a remote path, and the reverse: a deny of `**/.env` on this machine does not cover a remote `.env`, which `Read(ssh://*/**/.env)` does.
- `Read(ssh://*/**)` covers every host. `Read(ssh://**)` covers none: write the host part, even as `*`.
- A deny is read against the path as written before anything connects, and against the path the remote machine resolves it to (a link, a `..`) before a byte is read or written. Search answers leave out what a deny covers.
- In the default mode the first use of a host asks, as any path outside the project does, and one of its answers allows the host for the session. In sovereign mode nothing is asked; a deny still refuses.
- When the host is this machine, Mercury's own store and runtime are refused through it as they are directly.

## What stays on this machine

Checkpoints, language servers, project instructions and skills are not looked for on the remote machine. NotebookEdit, ChangeSet, AstSearch and AstEdit work on this machine's files.

## Limits

- The remote machine needs a POSIX shell (`sh`, `bash` or `zsh`) and its ordinary utilities. A machine with none is said to have none.
- A search of a folder brings the files it selects through the connection, so a large tree is slower to search than a local one. It applies this machine's global git ignore file; the remote account's is not read.
- A name that holds a line break is not found by a search.
- One connection per host is kept open while the session lasts and closed when it ends. A host that stops answering is said to have stopped after a minute of silence; a long command on a live connection is not cut short.
