# Changelog

## [Unreleased]

### Changed
- devDeps `@deepseek-ai/*` closure ride: `0.2.1-rc.5` → `0.2.2-rc.1` (commands, session, settings, skill, tools, util-values; schemastery follows the closure `3.18.5` → `3.19.0` — the rc.1 closure peers `~3.19.0`, keeping one copy and one type graph). Dev-only — neither ships in the published tarball. Peer floors stay `>= 0.2.0-rc.2` (the host preflight satisfies ranges with `includePrerelease`, so the floor already matches the new rc). ci.yml already resolves the newest of the `latest`/`next` dist-tags with the prerelease-aware comparator; release.yml's leftover `sort -V` pick is now switched to the same compare (see below).
- **release.yml picks the host closure with ci.yml's prerelease-aware compare** — the leftover `sort -V` decision (which ranks an rc above a same-version stable once one lands on `latest`, so the release would ride the older rc after a stable 0.2.x lands on `latest`) is replaced by the same node comparator ci.yml uses, so the release gates against exactly the closure CI installs.

## 0.2.1 - 2026-11-04

### Changed

- **Relicensed to Apache-2.0** — package.json declared `MIT` but the repo shipped no LICENSE file; it now carries the full Apache License 2.0 text (appendix `Copyright 2026 fan56`) and package.json declares `Apache-2.0`. Sole author to date (fan56), so no NOTICE file is needed.
- devDeps `@deepseek-ai/*` closure ride: `0.2.1-rc.2` → `0.2.1-rc.5`, and a test-stability fix (wait for the feed ledger line instead of racing it). Dev-only — neither ships in the published tarball.

## 0.2.0 - 2026-10-18

### Added

- **Pure-local mode guarantee** — a bundle with no git remote and no sync configuration runs the full saveLesson → feed → setLessonStatus improvement loop entirely locally: two new tests pin the three-step loop, and the bundle is guaranteed to never grow a git remote. README gains a "pure-local mode" chapter (install checklist for a second machine, and how to isolate bundles that do have sync configured).

### Changed

- **0.2.1-rc.2 wave**: devDeps `@deepseek-ai/*` pins `0.2.0-rc.2` → `0.2.1-rc.2` and `@deepseek-ai/schemastery` `3.18.4` → `3.18.5` (the version the 0.2.1-rc.2 host closure ships — the dual 3.18.4/3.18.5 copies made `tsc` fail TS2742 on the exported config schema types), package-lock.json advanced against registry.npmjs.org; peer floors unchanged (pre-flight `includePrerelease` already matches 0.2.1-rc.2); CI closure tower restored to newest-of(latest,next) with a prerelease-aware compare (10-17 pin undone); verified against a 0.2.1-rc.2 closure: typecheck clean, 112/0 tests, boot smoke pass.

## 0.1.0 - 2026-10-11

Initial release: the self-improvement loop for dsh — session signals become lessons (auto-applied, low-risk) and skill drafts (human-approved before install), with topics-memory's ledger as the input.
