# Non-UI Functional Completion Plan

## Objective

Complete and verify the Personal Agent's non-App functional path while preserving the current CLI behavior, permission gates, approvals, audit, and fail-closed security boundaries. Each major module has a functional test gate before work proceeds.

## Execution Rules

- Work one module at a time; do not mark a module done from declarations or mocks alone.
- For each module run focused positive, denial, cancellation/error, persistence/recovery, and cleanup tests as applicable.
- After each module run its focused tests, then the serial full suite. Run `AGENT_TEST_WSL=1 npm test` for modules touching native sandbox/Windows/WSL paths.
- Live provider/channel tests require user credentials and are reported separately from deterministic tests; never invent successful live verification.
- Keep unsupported capabilities explicitly unavailable. Update this plan with evidence and test counts after each module.

## Module 1: Gateway Turn Lifecycle

Deliver live turn state, delta/tool/status events, cancellation, session transcript retrieval, and reconnectable bounded event history. Preserve one-time approval resource binding and resume. Validate authorization ownership, duplicate turn IDs, cancellation cleanup, terminal states, and restart behavior.

Status: complete. Focused Gateway/API/approval/event/contracts tests passed 18/18. Agent, query-engine, and CLI regression tests passed 36/36 outside the restricted sandbox. Full suite passed 296/302 with six expected platform skips; native `AGENT_TEST_WSL=1` full suite passed 302/302 with no skips. The native run verified WSL kernel isolation, Windows snapshot/broker/worker probes, writable sandbox, and Gateway lifecycle together.

## Module 2: Inbound Webhook Delivery

Wire the existing inbound store into Gateway; execute accepted messages in isolated sessions with read-only permissions by default. Add source allowlists, replay/idempotency, durable in-progress/completed/failed states, bounded retry/dead-letter handling, and delivery diagnostics. Test signed valid/invalid requests, replay, session separation, permission restrictions, retries, and restart recovery.

Status: complete. Focused inbound/Gateway/platform tests passed 28/28; extended Agent/security/factory/task/contracts gate passed 68/68. Normal full suite passed 301/307 with six platform-specific skips. Native `AGENT_TEST_WSL=1` full suite passed 307/307 with no skips, including real WSL isolation and Windows broker/worker probes. Signed ingress is narrowly exempt from Gateway Bearer auth and is protected by per-channel HMAC, timestamp, signed source allowlist, and exact signed-body field binding. Body text is encrypted in SecretStore while queued, omitted from delivery/event/diagnostic views, retained for bounded retries, and deleted after successful processing. Gateway runs only an explicit read-only workspace tool allowlist in isolated per-source/conversation sessions; scheduler recovery, retries/dead letters, manual recovery, diagnostics, and serialized same-session delivery are tested.

## Module 3: Persistent Semantic Memory

Persist embeddings with provider/model/dimension identity; add bounded re-embedding and stale-vector invalidation, explicit configuration, status diagnostics, and FTS fallback. Preserve scope and sensitivity policy. Test restart, provider/dimension changes, provider failure, scope isolation, and no sensitive external embedding without opt-in.

Status: complete for local Ollama embeddings. Vectors are persisted in SQLite with provider/model/dimension identity; startup/config is keyword-only unless local Ollama is explicitly configured. Sensitive records never enter embeddings or automatic prompt context. Rebuild is bounded to 100 records per call; model/dimension mismatch is surfaced as stale and vectors are not mixed. Provider, config, Gateway approval, fallback, lifecycle/close, scope, sensitivity, dimension-change, restart, and CLI discovery tests passed. Focused Memory/Gateway/CLI gate passed 24/24; latest current-code Memory/Gateway/commands gate passed 30/30; Gateway/service regression passed 37/37; Agent/CLI/context/security regression passed 60/60 outside the restricted sandbox. Current normal full suite: 309 passed, zero failed, six platform skips out of 315. Current native `AGENT_TEST_WSL=1` full suite: 315/315, zero skips. Remote/OpenAI-compatible embedding export is intentionally not implemented; adding it requires explicit authorization for external memory transmission.

## Module 4: Provider and OAuth Completion

Keep OpenAI-compatible and Ollama stable; finish OAuth callback, PKCE/state validation, token storage, refresh/expiry/revoke, and provider adapter wiring only for a real supported provider. Add explicit live capability verification for chat, streaming, tools, JSON, usage, cancellation, and error redaction. Never report untested capabilities as verified.

Status: partial, blocked on selecting and authorizing a concrete OAuth provider/token endpoint. Existing generic PKCE helper remains unintegrated. Sending authorization codes, refresh tokens, or client secrets to configurable endpoints requires the user's explicit provider/destination approval; no generic remote exchange will be enabled without it. Provider capability matrix and live service acceptance also require chosen provider credentials.

## Module 5: Multimodal File Input

Add bounded text/PDF extraction first, then image input for an explicitly Vision-capable provider; audio only with a concrete supported transcription path. Enforce type/size/page/duration/time limits, temporary-file cleanup, untrusted-content boundaries, capability errors, and user-visible source/partial-result handling. Test malformed and oversized inputs and normal text regression.

Status: complete for bounded local text and PDF input; image/audio subfeatures are explicitly unavailable. `/attach <workspace-relative-file>` supports UTF-8 text/source formats (512 KiB) and PDF (10 MiB, 100 pages, 80,000 extracted characters, 10-second parser timeout) through pdfjs-dist; contents require explicit confirmation, are marked untrusted, are included in context budgeting, and are not persisted in transcript (only attachment provenance is). Workspace policy blocks traversal/private paths/symlinks. Failed/cancelled turns retain the pending attachment for retry, and session switches clear it. Image input remains unavailable until Vision capability is verified for a chosen provider; audio transcription has no backend. Readiness reports these states. Focused attachment/Agent/CLI/session gate passed 71/71 outside sandbox; Gateway/provider/readiness gate passed 23/23; current ordinary suite passed 314/320 with six native skips; native `AGENT_TEST_WSL=1` passed 320/320 without skips.

## Module 6: Controlled Browser Sessions

Build beyond current static `web_fetch`/`web_search` in separately gated stages: isolated browser profile, no ambient cookies, guarded navigation, bounded rendered text, pagination, and only later narrowly approved page actions. Downloads and form submission are not part of the read-only stage.

Status: Stage 1 complete: read-only JavaScript rendering is wired through the same DNS-validated, pinned public HTTP transport in CLI and Gateway. Gateway initializes and closes the browser with its service lifecycle, readiness reports the actual Edge/Playwright engine, and `browser_open` is visible only for explicit web intents. Each page uses a fresh cookie-free context; rendered output is bounded and marked untrusted. Stage 2 complete: one exact same-origin anchor URL from the current page may be followed. The entire source/target pair is bound to a one-time approval tied to client, session, turn, input and tool; approval summaries show origins and bounded paths but not query strings. Cross-origin actions are rejected before browser launch, and a changed target terminates the turn immediately. Non-GET requests, forms, popups, WebSockets, downloads, third-party resources and cross-origin redirects remain blocked. Live Edge verifies JavaScript rendering and same-origin destination rendering. Focused browser/Gateway tests passed 11/11; Agent, approval, routing, security and contract regressions passed 51/51. Final ordinary full suite: 437 passed, zero failed, eight skipped out of 445. Final native `AGENT_TEST_WSL=1` suite: 443 passed, zero failed, two skipped out of 445. The skipped UI cases require starting an additional preview server, but the existing Workbench owns the preview lock. Authenticated profiles, arbitrary button actions, form entry/submission, downloads, and cross-origin action chains remain unavailable.

## Module 7: Message, MCP, Plugin, Process, and Automation Integration Audit

Verify the existing Webhook sender, MCP stdio, plugin Tool runtime, process tools, and Gateway scheduler as usable service paths rather than isolated modules. Fix lifecycle, retries, concurrency, permissions, diagnostics, and cleanup gaps found by real adapter tests. Explicitly document excluded transports and capabilities (for example MCP HTTP/OAuth, full channel SDKs, Windows Service installation, and arbitrary executable Skills/Hooks).

## Module 8: Security and Release Acceptance

Run normal and native Windows/WSL full suites; run manual provider, webhook, MCP, scheduled-task, approval, cancellation, restart, and recovery scenarios where credentials/services are available. Reconcile README, architecture, diagnostics, and plan status. Record remaining OS-level limitations and establish a clean version-control baseline without including secrets or runtime data.

## Progress

- Started: Gateway lifecycle implementation and focused tests.
- Remaining modules are gated on the prior module's focused test results.
