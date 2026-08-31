# Agent Note: Head-and-tail clipping in the persistent shell tools

Status: implemented

English | [中文](2026-08-31-persistent-shell-head-tail-clip.zh.md)

## Problem

Both persistent shell tools clipped a command's output to a prefix of `maxOutputChars` characters and appended a notice telling the model to "search inside the file with `grep -n`" (Select-String in the pwsh twin). For arbitrary command output — a build, a test run — there is no file to search, and the notice's advice was false; worse, the clip destroyed the end of the output, which is where error summaries and exit verdicts live. Every other output-bounded surface in the harness keeps the tail or head-and-tail (one-shot `tool-bash`, `terminal_read`, the spill policy's `headTail` preview); the deployed caps (`maxInlineBytes` 50000 over `maxOutputChars` 16000 in `dsh-base`) meant the spill policy never re-bounded bash output, so the prefix clip was the final model-visible text and the tail was unrecoverable anywhere. The tools' own source carried a `TODO` acknowledging the notice was wrong.

## Decision

`maybeTruncate` now splits the budget into equal head and tail halves (`ceil`/`floor` of `maxOutputChars`) and places the notice in the gap, naming the exact number of omitted characters and the honest recovery action: re-run the command with output redirected to a file and search that file. Both twins land identically apart from the search-tool name. The `incomplete` parameter is gone from `maybeTruncate`: a start lost to the scrollback limit is `LOST_PREFIX_MESSAGE`'s fact, and one fact gets one notice — the old code appended the clipping notice to incomplete-but-within-budget output, duplicating the lost-prefix explanation.

The budget stays counted in characters because `maxOutputChars` is a character contract validated at load; the shared `TextRetainer` is byte-oriented and would silently change the config's meaning. The split ratio is fixed halves, not a knob: nothing deployment-varying depends on where the middle falls.

## Alternatives considered

**Keep the prefix clip and fix only the notice wording.** Rejected: the tail loss is the defect; error text at the end of `npm test` output is exactly what the model needs to react to.

**Route through the spill policy instead of clipping locally.** Rejected as a fix for this defect: the deployed `maxInlineBytes` exceeds `maxOutputChars`, so policy spill never triggers for these results, and wiring a session-owned spill into the persistent twins is a separate feature.

**Byte budgets via `TextRetainer`.** Rejected for unit mismatch: it would bound by UTF-8 bytes while the config, its validation, and every test speak characters.

## Consequences

A long command now renders its first and last `maxOutputChars/2` characters with an honest middle-omission count between them, followed by any `[exit code: N]` marker; results within the budget are unchanged, and incomplete results carry only the lost-prefix notice. The `<response clipped>` marker is preserved, so downstream consumers that anchor on it keep working. Tests in both twins pin the head fragment, the exact omitted count, and the tail fragment across the mega-scenario, the within-window stream reference, and the past-window freeze; no keyless snapshot pinned the old notice text (the phrase in tool-schema snapshots belongs to the `edit` tool's description). The 64KB fallback-window contract is untouched: it bounds host memory during accumulation, while this change governs only the render path.
