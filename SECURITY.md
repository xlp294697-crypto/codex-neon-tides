# Security policy

## Read this before installing

Neon Tides is an experimental runtime compatibility layer, not an official
Codex extension. It starts the Microsoft Store Codex desktop app with a
Chromium DevTools Protocol (CDP) endpoint bound to a randomized port on
`127.0.0.1`.

CDP has no authentication. While themed Codex is running, another process on
the same computer may be able to connect to that endpoint, inspect rendered UI
content, or execute JavaScript in the renderer. Randomizing the port prevents
ordinary collisions; it is not an access-control mechanism.

Use this project only on a trusted, single-user computer. Do not use it on a
shared workstation, kiosk, untrusted remote host, or a machine that runs
untrusted local software. Never change the debug address to `0.0.0.0`, expose
the port through a firewall/router, or tunnel it to another machine.

The launcher refuses to inject unless all of the following hold:

- the installed package is the Store-signed `OpenAI.Codex` package;
- the main executable has a valid Authenticode signature;
- the debug listener exists only on loopback;
- the listener owner belongs to the validated Codex package;
- the returned HTTP and WebSocket endpoints point to the expected loopback
  port;
- Node.js is version 22 or newer, identifies itself as Node.js, and carries a
  valid OpenJS Foundation signature;
- the DOM fingerprint matches the expected primary Codex window.

## Process restart behavior

Applying or removing the theme restarts the Codex package. Close all Codex
windows and wait for active local tasks to finish before installation,
reconfiguration, or uninstallation. The recovery watchdog may force-close
package processes after a graceful-close timeout to avoid leaving a failed
debug instance running.

## Local data

The selected background is copied to
`%LOCALAPPDATA%\NeonTidesForCodex\background.mp4`. It is not encrypted. The
injector performs no non-loopback network request and transfers the file only
to the local Codex renderer.

Runtime JSON can contain local install paths, package versions, PIDs, and
timestamps. Redact those fields, user names, task names, chat text, and all
credentials before posting diagnostics publicly. Never attach your background
video to an issue unless you intentionally want to publish it and have the
right to do so.

## Supported versions

Security fixes are provided only for the latest repository revision. Because
the project relies on undocumented desktop-app internals, a Codex update may
break compatibility at any time.

## Reporting a vulnerability

Do not publish secrets, private chat content, exploit payloads, or personally
identifying logs in a public issue. Open a minimal issue that says a private
security report is needed, without including sensitive details, so a maintainer
can arrange a private channel. For non-sensitive hardening suggestions, open a
normal GitHub issue with sanitized reproduction steps.
