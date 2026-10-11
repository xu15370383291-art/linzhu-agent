# Controlled web tools

## Delivery plan

1. Implement HTTP/HTTPS fetching with public-address validation, DNS-pinned
   connections, redirect revalidation, cancellation, bounded output and readable
   text extraction. No cookies, local files, JavaScript or browser automation.
2. Add Brave Search API support, once/session-origin approvals, network tool
   groups, evidence routing, audit integration and CLI wiring. Keep offline WSL
   commands offline. Search credentials come from BRAVE_SEARCH_API_KEY.
3. Test address denial, redirects, oversized/unsupported responses, timeouts,
   cancellation, approval denial, search parsing and model-tool integration;
   run the full regression suite and opt-in native/WSL suite.

## Boundary

The trusted Node application owns a separate restricted web transport; this is
not a network-enabled shell or isolation of a compromised Node process.
Every connection uses a validated DNS result, pinned in the HTTP lookup callback.
Redirects get new validation and approval. Only HTTP/HTTPS on their default ports
are supported. Credentials in URLs and nonpublic addresses are rejected.
No proxy environment variables, cookies or user-supplied request headers are used.
Brave credentials are sent only to its fixed HTTPS API, with redirects disabled.

Fetched text and search snippets are untrusted evidence, never instructions.
HTML extraction is deliberately static, not a browser: JS-only pages, PDFs and
authenticated pages need future dedicated tools. Character paging refetches the
page; it is not an immutable snapshot. Limits: 20 seconds per operation, five
redirects, 1 MiB download, 12,000 characters per page, five search results.
The 20-second budget counts DNS/download time across redirects, not time spent
waiting for approval. Approval remains cancellable via keys or the parent signal.
Only per-origin session permissions are remembered, not persistent permissions.

## Verification (2026-09-30)

- All three implementation stages delivered; web-specific tests include real
  local HTTP transport and terminal input-lease restoration.
- Full suite with AGENT_TEST_WSL=1: 154 passed, zero failed, zero skipped.
- Real public HTTPS fetch of https://example.com returned Example Domain and
  readable body through the production DNS-pinned transport.
- Brave parsing, credential confinement, denial, malformed responses and
  redirects tested with injected fixtures. Live Brave search not verified:
  requires the user's own API key and provider account.
- Existing model settings, session/context, terminal and native sandbox tests
  all passed. Tests do not establish security against a compromised host app.
