# Contributing

Thanks for looking. This is a small, opinionated Android app with a strict set of
boundaries, and the fastest way to get a change merged is to know them first.

**Read [docs/GUIDELINES.md](docs/GUIDELINES.md) before writing code.** It is the real
contributor document: where code goes, the three storage tiers and the rule for each,
the secret and logging boundaries, how to change the database, and the list of
decisions that must not be silently undone. This file only covers process.

## Before you start

- **Bugs** — open an issue with the version, the Android version, and what the Debug
  screen shows. Never paste an API key or an unredacted export; the app redacts both
  export formats for exactly this reason.
- **Features** — open an issue first. The roadmap is [docs/06_Eng_Plan.md](docs/06_Eng_Plan.md)
  §2 and the known-open list is [docs/flaws.md](docs/flaws.md) §3; a change that
  contradicts either needs the reasoning, not just the code.
- **Security** — do not open an issue. See [SECURITY.md](SECURITY.md).

## Setup

```bash
pnpm install
```

pnpm only. `pnpm-lock.yaml` is the committed lockfile, `package-lock.json` is
gitignored, and CI installs with `--frozen-lockfile` — a change that silently edits
the lockfile fails there rather than producing a build nobody can reproduce.

## The gates

Run all of them before pushing. CI runs the same four on every push and pull request.

```bash
pnpm gates
```

That is typecheck + lint + tests with coverage thresholds. CI adds the fourth:

```bash
pnpm expo export --platform android --output-dir .expo-export
```

A full Metro bundle whose output is discarded. It is the only gate that can see a
broken screen: `jest.config.js` matches `*.test.ts` only, so no component is ever
imported by the suite.

Rules about the gates:

- Do not lower a `coverageThreshold` to make a red run green. The floors are a
  ratchet; the reasoning is in `jest.config.js`.
- Do not add an eslint-disable or a `@ts-expect-error` without a comment saying what
  is true that the tool cannot see.
- New pure logic ships with tests in the same change. Logic in a component is logic
  no test can reach — put it in `src/chat/`, `src/lib/` or `src/db/` and test it there.

## Pull requests

- One concern per PR. Keep the diff reviewable.
- Explain *why* in the description; the diff already says what.
- Note anything you could not verify. This app talks to a gateway that currently
  rejects every request ([docs/flaws.md](docs/flaws.md) §1), and native changes cannot
  be verified without a build — "unverified on device" is a useful thing to write down
  and a bad thing to leave implied.
- If your change touches native config (`app.json`, a config plugin, a dependency with
  native code), say so: it means a new APK rather than a JS change, and reviewers need
  to know that.

## Commit messages

Plain imperative subject lines. Conventional Commits are welcome but not enforced.

## Code of conduct

By participating you agree to [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Contributions are accepted under the MIT license in [LICENSE](LICENSE).
