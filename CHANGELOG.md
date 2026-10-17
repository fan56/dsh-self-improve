# Changelog

## Unreleased

- **0.2.1-rc.2 wave**: devDeps `@deepseek-ai/*` pins `0.2.0-rc.2` → `0.2.1-rc.2` and `@deepseek-ai/schemastery` `3.18.4` → `3.18.5` (the version the 0.2.1-rc.2 host closure ships — the dual 3.18.4/3.18.5 copies made `tsc` fail TS2742 on the exported config schema types), package-lock.json advanced against registry.npmjs.org; peer floors unchanged (pre-flight `includePrerelease` already matches 0.2.1-rc.2); CI closure tower restored to newest-of(latest,next) with a prerelease-aware compare (10-17 pin undone); verified against a 0.2.1-rc.2 closure: typecheck clean, 112/0 tests, boot smoke pass.
