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

There are five. CI runs the first four on every push and pull request; the fifth is a
device pass, which no runner can do for you.

```bash
pnpm gates
```

That is typecheck + lint + tests with coverage thresholds — three of the four. CI adds
the bundle:

```bash
pnpm expo export --platform android --output-dir .expo-export
```

A full Metro bundle whose output is discarded. It is the only gate that can see a
broken screen: `jest.config.js` matches `*.test.ts` only, so no component is ever
imported by the suite. Run it yourself whenever imports or assets moved — a `require`
cycle, a missing asset or a native-only import pulled into a shared module fails here
and nowhere else. `.expo-export/` is gitignored, so there is nothing to clean up.

The fifth gate is the device protocol in [docs/GUIDELINES.md](docs/GUIDELINES.md) §13.
It matters more than it sounds: the app now depends on well over a dozen native
modules, and a feature that needs one simply does not exist on a build made before it.
It is also the only gate that can hear a screen reader, so every accessibility label,
role and focus trap in the app is unverified until someone walks it — steps 76–79 of the
full protocol ([docs/07_Deployment.md](docs/07_Deployment.md) §7).

Rules about the gates:

- Do not lower a `coverageThreshold` to make a red run green. The floors are a
  ratchet; the reasoning is in `jest.config.js`.
- Do not add an eslint-disable or a `@ts-expect-error` without a comment saying what
  is true that the tool cannot see.
- New pure logic ships with tests in the same change. Logic in a component is logic
  no test can reach — put it in `src/chat/`, `src/lib/` or `src/db/` and test it there.
- **A tested module's whole import graph has to stay off `react-native`.** The suite
  runs under `testEnvironment: 'node'` with no setup file, so one transitive import of
  `react-native` or `expo-file-system/legacy` anywhere in the graph takes the suite
  down rather than the module. This is the constraint behind the house pattern of a
  pure `.ts` module paired with a `.tsx` view that renders it.

## Pull requests

- One concern per PR. Keep the diff reviewable.
- Explain *why* in the description; the diff already says what.
- Note anything you could not verify. This app talks to a gateway that currently
  rejects every request ([docs/flaws.md](docs/flaws.md) §1), and native changes cannot
  be verified without a build — "unverified on device" is a useful thing to write down
  and a bad thing to leave implied.
- If your change touches native config (`app.json`, `intentFilters`, a config plugin, a
  dependency with native code), say so, and tick the second box under **Native impact**.
  JavaScript can reach an installed build over the `expo-updates` channel; native config
  cannot, at any version — it needs `pnpm build:preview` and a device pass, and reviewers
  need to know which of the two your change is.

## Commit messages

Plain imperative subject lines. Conventional Commits are welcome but not enforced.

## Code of conduct

By participating you agree to [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Contributions are accepted under the MIT license in [LICENSE](LICENSE).
