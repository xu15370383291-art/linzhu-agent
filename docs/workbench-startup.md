# Workbench startup

Run `npm run workbench` from a normal Windows user terminal in the project directory.
Open `http://127.0.0.1:59160/live.html`.

This entry checks the real WSL sandbox before starting the preview server. It does
not disable isolation, approvals, or workspace path restrictions. If verification
fails, startup exits with the actual error instead of starting a misleadingly
healthy workbench.

Do not start the service inside a restricted coding-agent process. Child processes
inherit that process's token: Windows snapshot locking and restricted-token
creation may fail even when the installed WSL environment is healthy. An agent
must request approved normal-user execution for service startup. This does not
require running the application as administrator.

Static HTML, CSS, and browser JavaScript edits only require a page refresh.
Backend module edits require a service restart through this entry, followed by
checking `/api/diagnostics`: `worker.available` and `sandbox.available` must be
true and `failClosed` must be false. Never persist a fabricated verified flag.

The original CLI and preview commands remain available. Future WSL installation,
OS, or permission changes can still require repair; the startup check detects
these failures early rather than concealing them.
