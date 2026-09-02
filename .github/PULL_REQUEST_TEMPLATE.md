## What and why

<!-- The diff says what changed. Say why it needed to. -->

## How it was verified

<!-- Which gates you ran, and anything you could *not* verify — a native change
     cannot be confirmed without a build, and the gateway currently rejects every
     request, so "unverified on device" is a useful thing to write down. -->

- [ ] `pnpm gates` (typecheck + lint + tests with coverage floors)
- [ ] `pnpm expo export --platform android --output-dir .expo-export`
- [ ] Exercised on a physical device
- [ ] Not applicable / verified another way (explain below)

## Checklist

- [ ] One concern. If this does two things, it should be two pull requests.
- [ ] New pure logic ships with tests in the same change.
- [ ] No `coverageThreshold` was lowered.
- [ ] Any `eslint-disable` or `@ts-expect-error` says what is true that the tool cannot see.
- [ ] No secret, key, token or unredacted export in the diff or the description.
- [ ] Nothing in [docs/GUIDELINES.md](../blob/main/docs/GUIDELINES.md) §14 ("decisions
      not to silently undo") was undone — or if it was, this PR argues for it.
- [ ] Every new interactive element has an accessibility label (and a hint where the
      outcome is not obvious); no `accessibilityLiveRegion` on anything that streams.
      Components are structurally untested here, so review is the only gate this passes.
- [ ] Docs updated if behaviour, setup or the release process changed.

## Native impact

- [ ] JavaScript only — can reach an installed build over the `expo-updates` channel
- [ ] Touches native config (`app.json`, `intentFilters`, a config plugin, a dependency
      with native code) — **no update can carry this.** Needs a new build
      (`pnpm build:preview`) and a device pass before release.

## Related

<!-- Closes #… -->
