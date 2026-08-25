# Agent Note: Hot-path cost reductions from the performance review

Status: implemented

English | [中文](2026-08-25-hot-path-cost-reductions.zh.md)

## Problem

A five-facet performance review over the turn path, persistence plane, boot, and execution polling found four costs that grow with work the product already does, not with any new feature:

- Every persistent-shell command paid full process-table inspections on each readiness poll: `inspectForeground` swept descendants it did not use (~2 `/bin/ps` execs per poll on macOS at the 50 ms cadence; three `/proc` sweeps per poll on Linux), for thousands of sweeps across one build.
- Terminal scrollback appends were quadratic: every PTY data event re-split the whole retained text (`split('\n')`) and, once at the 4 MB cap, walked a multi-million-element code-point array to find the UTF-8 tail — O(output²/cap) CPU delivered as repeated event-loop stalls.
- The token meter subscribed eagerly to `session/event` and folded through the session's snapshot getter, which every append invalidates — so after the first measure, each streamed assistant chunk re-materialized a frozen copy of the entire log: O(chunks × log length) allocations per streaming turn.
- Persistence write-behind deep-cloned every event on enqueue although Session.append already snapshotted and recursively froze it — a second full copy of identical immutable data per streamed chunk.
- Every launch of every profile ran `healProfilesModuleFallback`: a synchronous BFS parsing ~200–260 workspace manifests (cold cache or Windows AV: plausibly 100 ms–2 s) before profile validation.

## Decision

Polling does process-table work only when a send settles. `SubprocessTerminalHandle` gains `noteSendSettled()`; the local provider runs its (fence-preserving) descendant adoption there instead of in `inspectForeground`, and teardown keeps its own scan. E2B implements it as a no-op with rationale. Linux `inputWaiting` stays eager deliberately: readiness consumes it statefully on every poll, and no equivalent cheaper probe exists — after the fix macOS polls do one exec, Linux one sweep. Scrollback retention moved to a chunked buffer with cumulative byte/newline counters and head-consumption cursors; eviction order (lines then bytes), flag stickiness, and returned bytes are pinned against a naive-reference oracle test; `read()` slices by an incrementally maintained line index.

Metering folds lazily: the eager subscription is gone, reads advance a cursor over events consumed so far, and catch-up is O(events since last read) amortized; all consumers call `measure()` synchronously before reading totals, so nothing can observe stale counts. Write-behind retains an enqueued event by reference when `Object.isFrozen(event)` holds (Session's append-time freeze is the ownership boundary) and clones only unfrozen input.

Profile healing gained a fail-open stamp: the reconcile loop over existing links still runs every launch, but the discovery BFS is skipped when `$DSH_HOME/profiles/node_modules/.dsh-heal.json` records unchanged anchor-manifest and root-lockfile mtime/size facts plus the last link map (transitive deps are not resolvable from the anchor alone). Any read/shape/stat error, stale link target, or anchor/lockfile change falls through to today's full heal; a failed stamp write is swallowed with named cause and never fails boot.

## Alternatives considered

**Teardown-only descendant discovery.** Rejected by test: a disowned child reparents away while the shell is alive and is invisible to a post-exit scan under the PID-recycling fence — settlement-time adoption is the latest point that preserves the leak-freedom guarantee.

**Lazy Linux `inputWaiting`.** Rejected: `pollReadiness` and the pre-write wait consume it on every poll, so laziness only moves the sweep; group membership has no cheaper equivalent probe.

**Indexed event accessor on Session for the meter.** Unnecessary once folding went lazy — the cursor makes catch-up linear in new events, and no consumer needs per-append updates.

**Unconditional heal with faster manifest parsing.** Rejected: parse speed cannot fix ~2000 cold synchronous fs ops; the stamp removes the walk while keeping healing reachable on every signal pnpm-driven graph changes can touch.

## Consequences

A long persistent-shell command now performs zero mid-command process-table sweeps and one scan per settled send; scrollback cost is linear in output. Streaming turns stop allocating a log-sized array per chunk in both the meter and persistence queue. Boot skips ~443 manifest parses per launch once stamped (measured warm 41.5 ms → 6.1 ms; the win grows cold). Residual holes are documented where they exist: the stamp trusts anchor+lockfile fingerprints (a hand-edited mid-tree manifest heals late but loudly at Loader resolution), and byte accounting in the chunked buffer assumes no surrogate pair split across append boundaries, guaranteed by the streaming decoder upstream. Related fixes from the same review live in [the persistent-shell fallback window](2026-08-25-persistent-shell-fallback-window.md) and [the revision-probe cwd hint](2026-08-25-revision-probe-cwd-hint.md).
