# Spec-first QA gate

1. One spec per feature, at `qa/specs/<feature>.md`, from `TEMPLATE.md`. Copy it, keep the headings, delete the guidance comments.
2. The spec links its PRD's section 6 and is reviewed by @grace.
3. The spec file must be **merged to `main`** before a branch review is requested. PRD merged is not enough.
4. A criterion that cannot be tested gets **rewritten, never waived**. `AC`/`EC` ids never get reused.
5. Merged specs are the regression corpus: once a spec is merged its test set runs on every release candidate.
6. Tiny-fix exemption (typo, one-line fix, config tweak) needs no spec.
7. Defects: repro steps, expected vs actual, severity S1/S2/S3 → @ada; S1/S2 also to @priya.
8. A spec change after code exists needs its own commit message naming the AC/EC it moves.
9. Owner and reviewer of this template: @grace. Changes to it go through a PR.
