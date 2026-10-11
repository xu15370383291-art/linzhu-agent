# Sandbox Implementation Plan

## Current Product Scope

The user narrowed this project to a practical personal-agent sandbox. Keep the
existing read-only/offline WSL execution, per-action approvals, file broker,
limits and audit. Do not pursue enterprise isolation, dedicated Windows accounts,
firewall provisioning, multiple platform backends or writable/network commands
as part of this release. The older full-system roadmap below is historical,
not the current delivery checklist.

Personal release checklist:

- [x] Preserve file reads/searches, approved writes and approved offline commands.
- [x] Prepare file snapshots by operation: reads target one file, listing copies
  only immediate names, find copies names recursively, search skips bodies above
  its existing 100 KB limit. File metadata retains original size/mtime.
- [x] Use an independent temporary directory for startup probes; also check the
  native file broker. A large project does not disable every tool on startup.
- [x] Show readiness and dependency guidance after the conversation screen opens.
- [x] Remove redundant mask traversal after trusted snapshot generation.
- [x] Final real WSL/native and full regression verification.
- [x] Add external single-file write/edit tools with per-call approval, path restrictions and target revalidation.

Personal release verification (2026-09-30): ordinary suite 145 tests,
140 passed and five opt-in native/kernel tests skipped; combined real suite
with AGENT_TEST_WSL=1 passed all 145 with no skips. Large-file directories,
scoped paths, metadata, small-file reads, search and independent startup
verification included. Existing approval/cancellation/session/context tests
also passed. No new software, accounts or firewall rules were installed.

External writes remain limited to one regular UTF-8 file per call. They reuse
the workspace preview ticket and Windows commit broker; directory-level writes,
delete/move/permission changes and writable sandbox commands remain disabled.

Limits retained: 5,000 snapshot entries, depth 32, 32 MB copied content,
2 MB/readable file, per-tool output/time/resource limits. Commands still require
a complete bounded workspace snapshot; large projects can exceed command limits.
This release limits model tool effects, not a compromised host application.

## Scope and Threat Model

The current supported backend is Windows + WSL2 Ubuntu + Bubblewrap.
The host application, model transport, session storage and approval UI are trusted.
Model-generated shell commands and file arguments are untrusted. Commands must
remain offline and workspace-read-only. Approved writes use a trusted host broker.
This is not isolation of a compromised host Node process or protection against a
malicious administrator concurrently changing Windows mount paths.

## Execution Order

1. [x] Fail-closed permission boundary: require verified isolation in the CLI;
   enforce it at tool dispatch, including writes and external reads. Keep explicit
   application-only policy support for unit tests, not an automatic CLI fallback.
2. [x] Executor hardening: one launcher for commands and read workers; Linux
   resource limits, process-group cleanup, validation and already-aborted requests.
3. [x] Approval integrity: single-use, expiring, workspace-bound write tickets;
   do not permit approval callbacks to change approved content or command details;
   revalidate external targets before and after isolated reads.
4. [x] Sensitive-safe audit: record dispatch outcomes without commands, file
   contents, query text or API keys; require audit availability in strict CLI mode.
5. [x] Acceptance: regression tests after each module, actual WSL kernel tests,
   usage documentation and precise disclosure of unsupported guarantees.

## Module Acceptance

- Module 1: failed verification cannot call host read/write/approval functions;
  tool discovery and dispatch agree; existing model/session/context tests pass.
- Module 2: reads and commands still work, timeout/output/resource limits and
  cancellation fail predictably, descendants cannot escape the PID namespace.
- Module 3: mutated/replayed/expired write tickets fail; ordinary edits still work;
  denied or changed external reads never return content.
- Module 4: success, denial and failures are logged with correlation IDs; logging
  failures prevent new strict-mode operations; no sensitive payload is logged.
- Module 5: run the full test suite and opt-in WSL tests; distinguish skipped,
  mock-tested and kernel-verified behavior.

## Full-System Roadmap (Not Claimed by This Release)

6. Atomic external-read boundary: trusted Windows handle-based broker or bounded
   immutable snapshot, reparse-point handling and quotas. Path checks plus bwrap
   mounts still have a mount-time race; before/after checks do not eliminate it.
7. Transactional writes: atomic replacement/recovery, directory-handle-relative
   Windows operations, add/move/delete contracts; prevent concurrent adversarial
   parent replacement. Current host writes must not be described as OS-isolated.
8. Writable command sandbox: disposable Linux working copy, diff-only export,
   brokered approval and conflict-checked commit. Never mount user disk writable.
9. Controlled network: separate egress proxy, destination/port/method policy,
   DNS and redirect enforcement, quotas, credentials outside command environment.
10. Native Windows boundary: dedicated low-privilege identity, ACL provisioning,
    firewall lifecycle, privileged narrow broker, install/uninstall recovery.
11. Additional backends: Linux namespaces/seccomp and macOS backend, explicit
    capability negotiation; unsupported platforms fail closed.
12. Release security gate: adversarial race, fork/CPU/memory/disk, crash recovery,
    leaked handles, syscall and egress tests on every supported platform.

Steps 6-12 require separate platform design and validation. They are not silently
enabled by command approval and are not considered completed by unit tests.

## Verification Log

Results are added after each module is actually tested.

- Baseline: 129 tests, 128 passed, one opt-in WSL test skipped.
- Module 1: 131 tests, 130 passed, one skipped. Fail-closed changes required
  updating CLI expectations and preventing evidence retries with no tools.
- Module 2: 131 tests, 130 passed, one skipped; real WSL suite 2/2 passed,
  including memory, output, cancellation, background child and limit checks.
- Module 3: 133 tests, 132 passed, one skipped. Ticket replay/mutation and
  approval callback integrity covered; real WSL/CLI suite later passed 5/5.
- Module 4: 135 tests, 134 passed, one skipped. Audit success/denial/error and
  pre/post-operation logging failures covered.
- Final acceptance (2026-09-30): ordinary suite 139 tests, 138 passed and one
  opt-in kernel test skipped; full elevated suite with AGENT_TEST_WSL=1 passed
  all 139 tests with zero skips. Shared launcher, terminal cancellation,
  hard-link rejection, audit rotation, expired tickets and post-read identity
  checks included. Real CLI write tests require successful verification in
  opt-in WSL mode rather than counting fallback/denial as write success.
- No aggregate quotas, atomic Windows path broker, seccomp profile or native
  Windows isolation claimed. Steps 6-12 remain open; the complete roadmap is
  not the same as a completed full-system sandbox.

## Continuation: Windows Handle Broker and Kernel Hardening

Implemented on 2026-09-30:

- Windows C# file broker compiled using the installed .NET Framework compiler
  in a fresh temporary build directory. It is a trusted host helper, not a
  low-privilege Windows service.
- Snapshot source ancestors are pinned with handles that deny delete sharing;
  files are opened without reparse traversal and deny concurrent write/delete
  sharing while their bytes are copied. Hard links, alternate streams, reparse
  points and private names are rejected. WSL mounts the resulting snapshot,
  not the user's live target path. Workspaces also use this snapshot mechanism.
- Snapshot quotas: 5,000 entries, depth 32, 2 MB/file, 32 MB total. Operations
  that exceed these bounds fail closed. This currently limits large-workspace
  reads and commands; it is not lazy snapshotting or a global tree snapshot.
- Windows strict CLI commits use pinned parent paths, bounded content, durable
  temporary file preparation and File.Replace/File.Move publication. Library
  writes use staged rename/exclusive creation. Original files are not truncated
  before replacement. Leaf replacement after the hash check is still not CAS;
  approved writes are not a complete adversarial transaction.
- Each WSL execution runs in a transient systemd user service with cgroup v2:
  MemoryMax=384M, MemorySwapMax=0, TasksMax=64, CPUQuota=100%, RuntimeMaxSec=20,
  KillMode=control-group. Existing wall-time and per-process limits also apply.
  Unavailable user systemd/cgroup configuration fails closed.
- Child processes inherit no_new_privs and a libseccomp deny filter for mount,
  namespace manipulation, ptrace, process_vm_*, kernel modules, BPF, keyring,
  perf, io_uring_setup and other unnecessary privileged operations. This is a
  deny-list defense, not a minimal audited syscall allowlist.

Verification:

- Snapshot module: real full suite 141/141 passed.
- cgroup and staged atomic writes: real full suite 143/143 passed.
- Windows commit broker, seccomp and aggregate memory exhaustion: real full
  suite 144/144 passed with no skips. Native-only tests require
  AGENT_TEST_NATIVE=1; the combined suite uses AGENT_TEST_WSL=1.

Remaining before claiming full-system isolation:

1. Bind authorization to Windows handle identity across the entire approval
   lifecycle, not only copy-time locking and pre/post identity checks.
2. Eliminate leaf commit races, preserve Windows ACL/security metadata under
   all replacement conditions, and test crash/restart recovery and orphan stages.
3. Add disposable writable execution with bounded diff export and brokered
   commits; commands remain read-only/offline for now.
4. Implement separately approved egress proxy with destination, DNS, redirects,
   methods, credential boundaries and quotas. No direct sandbox networking.
5. Provision a dedicated Windows low-privilege identity and narrow trusted
   service, restrictive ACLs and firewall rules, lifecycle recovery and uninstall.
   The host Node process and this helper still have the current user's rights.
6. Add platform backends and adversarial release tests. macOS/Linux native
   deployments have not been implemented or verified on this Windows machine.

No Windows account, firewall policy, system service or third-party software was
installed by this continuation. Existing WSL/systemd/libseccomp were reused.
