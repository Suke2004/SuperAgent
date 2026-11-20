# Spec-first QA gate

1. One spec per feature at `qa/specs/<feature>.md`, copied from `TEMPLATE.md`; it links its PRD's section 6.
2. The spec file must be **merged to `main`** before a branch review is requested. A merged PRD is not enough.
3. A criterion that cannot be tested is **rewritten, never waived**. `AC`/`EC` ids are never reused.
4. Merged specs are the regression corpus and run on every release candidate.
5. A post-code spec change needs a commit naming the AC/EC it moves: `spec: AC-3 → …`.
6. Tiny fixes (typo, one line, config) need no spec.
7. Defects carry repro steps, expected vs actual and severity S1/S2/S3 → @ada, S1/S2 also to @priya.
8. Owner @grace; changes to this gate go through a PR.