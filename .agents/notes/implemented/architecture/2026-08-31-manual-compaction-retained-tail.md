# Agent Note: Policy retention for manual compaction and a tail-aware summary instruction

Status: implemented

English | [中文](2026-08-31-manual-compaction-retained-tail.zh.md)

## Problem

`compactNow` selected its compaction range with `retainTokens = 0`, so a manual `/compact` lossy-summarized everything up to the final surface node — including the newest user turns. Both READMEs promised otherwise ("the recent tail stays verbatim", "the recent history is untouched"), and the zero-retention rationale on record was written for the context-overflow path, where forcing a maximal reduction is the point. Compounding the mismatch, `COMPACTION_INSTRUCTION` never told the summarizer that a verbatim recent tail survives the checkpoint, so the summary could duplicate or contradict what the model reads immediately after, exactly when a manual compaction's checkpoint is freshest.

## Decision

`compactNow` now resolves the same retained tail the pressure trigger uses: the routed target's policy (`resolveTargetPolicy`) scaled by its adapter context window (`resolveCompactSpec(...).retainTokens`). One retention knob governs both triggers, and the documented contract holds for each. A session with no routed request keeps `0` — there is no policy to price retention against, and the summarizer's own fallback chain decides whether a summary is possible at all. The capacity guard moved into a shared `requireContextWindow` used by both paths, so a route without declared capacity fails loud with the same target-specific error from either trigger.

The summarization instruction gained one rule: the most recent conversation continues verbatim after the checkpoint, is not part of the condensed span, must not be restated, and detail should bias toward the end of the span so the checkpoint hands off cleanly to the verbatim tail. The constant stays byte-stable across compactions, preserving the auxiliary call's prefix-cache reuse.

## Alternatives considered

**A separate smaller manual retention budget.** Rejected: a second knob for the same fact invites drift, and sessions smaller than either budget have nothing useful to condense — the command reports that honestly instead.

**Retain the last closed turn boundary instead of the policy budget.** Rejected: turn-boundary retention is a second retention notion requiring new surface machinery, while the policy budget already exists, is configured per model, and is what users of the automatic path experience.

**Leave retention at zero and fix the READMEs.** Rejected: the READMEs state the intended product behavior; zero retention discards the freshest instructions at the moment users most rely on them.

## Consequences

Manual `/compact` now condenses only history older than the resolved retention budget; a session whose conversation fits inside that budget yields `null` and the command reports nothing condensed. Test harnesses configure explicit small `retainTokens` so seeded histories stay compactable, and a new real-loop test pins the contract: the older exchange collapses into the checkpoint while the newer exchange survives verbatim. The overflow path's zero retention is unchanged and remains the documented exception. The instruction change updates the README-quoted prompt text in both languages; no keyless snapshot pins it. Manual compaction now resolves model capacity before opening its bracket, so tests that assumed single-microtask settlement before `compaction/start` settle on a timer instead.
