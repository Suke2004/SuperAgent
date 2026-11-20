# Spec — <feature>

**PRD:** <link to PRD> · **Spec owner:** @grace · **Status:** draft / in review / merged · **Feature slug:** `qa/specs/<feature>.md`
**Spec merged:** ____ (link/date) · **Gates a branch review after this file is on `main`**

> Copy this file to `qa/specs/<feature>.md`, keep the headings, replace the guidance comments. Mirror the PRD's section 6 block exactly: the ids line up one for one. Nothing here is waived — an untestable criterion is rewritten until it is testable.

## Acceptance criteria — `AC-1 … AC-n`

One assertion per criterion, form `Given <state>, when <action>, then <observable outcome>`. Every AC maps to a PRD success metric or in-scope bullet, named after it.

- **AC-1** — Given <state>, when <action>, then <observable outcome>. → PRD §3 metric "<metric>"
- **AC-2** — Given <state>, when <action>, then <observable outcome>. → PRD §4 bullet "<in-scope item>"

<!-- Testable check: could two people run it and agree on pass or fail? If not, rewrite it. -->

## Happy path

The one sequence that satisfies every AC end to end. Where only one path exists, say so and stop.

## Edge cases — `EC-n`

Expected result on each, not just the input. Boundaries, empty and maximum sets, repeated or concurrent actions, permission boundaries. `EC` ids never get reused.

| Id | Condition | Expected result |
|---|---|---|
| EC-1 | <boundary> | <expected> |
| EC-2 | <empty set / maximum set> | <expected> |
| EC-3 | <repeated or concurrent action> | <expected> |
| EC-4 | <permission boundary> | <expected> |

## Negative paths

Invalid input, missing prerequisites, dependency down or slow, unauthorized actor. For each: expected error, no data corruption, no partial write.

| Id | Failure | Expected error | Data guarantee |
|---|---|---|---|
| NP-1 | <invalid input> | <error shown> | <nothing written / row unchanged> |
| NP-2 | <dependency down or slow> | <error shown> | <no partial write> |
| NP-3 | <unauthorized actor> | <error shown> | <no data touched> |

## Data states

Seed state and post-state per scenario, including what must remain unchanged for untouched records. Name the fixture or seed script.

| Scenario | Seed state | Post-state expected | Records that must be untouched |
|---|---|---|---|
| <AC-n> | <seed> | <post> | <untouched records> |

---

Below is the full spec. The PRD carries only the short block; all of this lives here.

## Scope trace

Every AC and EC traced to its PRD section and metric, so a reviewer can see nothing landed untraced and the PRD cannot drift from the spec.

| Id | PRD section | Success metric | Notes |
|---|---|---|---|

## Test data plan

Accounts, fixtures, seed scripts, reset between runs. Reference secrets by Vault name — never the value.

## Environments and access

Where each level of the matrix runs (local, CI, preview, device), the build or SHA under test, and any access the runner needs that it does not have.

## Exit criteria

What "go" means in counts, not adjectives: every AC and EC run and passing, zero open S1/S2, S3 triaged with an owner. State anything that would block sign-off here.

## Defect reporting

Repro steps, expected vs actual, severity. **S1/S2/S3 → @ada, with S1/S2 also to @priya.** S1 blocks unconditionally, S2 blocks until fixed, S3/S4 tracked. Every defect names the AC or EC it breaks.

## History

A post-code change to this spec needs its own commit message naming the AC/EC it moves: `spec: AC-3 → <what moved>`. Merged specs become regression corpus for every release candidate.
