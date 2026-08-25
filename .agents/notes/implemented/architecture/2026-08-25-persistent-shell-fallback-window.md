# Agent Note: Bounded fallback window in the persistent shell tools

Status: implemented

English | [中文](2026-08-25-persistent-shell-fallback-window.zh.md)

## Problem

`tool-bash-persistent` and `tool-pwsh-persistent` accumulate a `fallback` string across every poll iteration of a command with no cap: each non-empty incremental delta is appended for the command's whole lifetime. A command streaming 200MB pinned at least 200MB of host heap even though the fallback serves exactly one purpose — letting `partialOutput` recover output-from-command-start once the start marker has scrolled out of the terminal's bounded scrollback — and rendering keeps only the first `maxOutputChars` (default 16000) characters past that marker. The retained megabytes bought nothing model-visible.

## Decision

Accumulation keeps the start marker plus `FALLBACK_WINDOW_BYTES` (65536) bytes past it, landing identically in both twins. Once the accumulated string grows past that window, it is sliced to `[markerStart, markerStart + marker.start.length + FALLBACK_WINDOW_BYTES]`, `fallbackTruncated` is set so `partialOutput` reports the result incomplete, and a separate `fallbackWindowed` flag stops appending further deltas for the command. A viewport replacement (an empty incremental delta) restarts accumulation from the viewport and clears both flags, matching the points where `fallback` itself resets today.

`fallbackWindowed` is separate from `fallbackTruncated` because the pre-existing flag also latches backend-reported output drops (`incremental.truncated || result.truncated`); stopping appends on that cause would change retained bytes for within-window commands. `partialOutput` itself is unchanged: within the window the end-marker search still hits everywhere it hit before, so verdicts are identical; past the window the search may now miss the end marker, and the already-set `fallbackTruncated` degrades the verdict to incomplete — degradation confined to outputs whose extra bytes were never rendered.

The window is a named module constant placed beside `SCROLLBACK_PAGE_LINES` and `POLL_INTERVAL_MS`, not a config field: nothing model- or wire-visible depends on it, and the sibling internal bounds in these files are constants (`maxOutputChars` is config precisely because it is model-visible).

## Alternatives considered

**Reuse `fallbackTruncated` alone as the stop-appending flag.** Rejected: that flag also latches backend truncation, and freezing the fallback on that cause would drop retained bytes for within-window commands — a model-visible change outside this fix's mandate.

**Cap inside `partialOutput` instead of at accumulation.** Rejected: the pinned memory is the accumulated string itself; capping at read time leaves the heap growth in place.

**Make the window a config field.** Rejected: no deployment can observe it except through memory use, and a validated knob with documentation costs more than the fixed bound it replaces.

**Clamp the window to at least the configured `maxOutputChars`.** Rejected: the bound would then vary by deployment and the fix's memory guarantee would depend on configuration. Deployments raising `maxOutputChars` far above the default accept the documented window cap on marker-scrolled-out recovery instead (both tools' Known Limitations record it).

## Consequences

Host memory for a streaming command is bounded at marker + 64KB on the fallback path; viewport replacements bound themselves by the viewport. Commands whose post-marker output stays within the window render byte-identically to before. Past the window, marker-scrolled-out partial results read as incomplete (lost-prefix plus clipping notices) instead of settled; at the default configuration the rendered output bytes are unchanged and only the verdict diagnostics differ. Mirrored polling-harness tests in both twins pin the within-window reference against an uncapped simulation, the past-window incomplete verdict with output still recovered from command start, and the viewport-replacement flag reset, at per-file 100% coverage. The mirror contract itself is owned by [pwsh-persistent-pty](../architecture/2026-08-11-pwsh-persistent-pty.md).
