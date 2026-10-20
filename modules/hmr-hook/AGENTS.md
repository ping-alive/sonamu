# modules/hmr-hook

Core HMR hook runtime; regressions break hot reload across dependent packages. Add regression
tests for non-obvious runtime edge cases.

## Validation

- `mise exec -- pnpm --filter @sonamu-kit/hmr-hook typecheck`
- `mise exec -- pnpm --filter @sonamu-kit/hmr-hook lint`
- `mise exec -- pnpm --filter @sonamu-kit/hmr-hook test`
- `mise exec -- pnpm --filter @sonamu-kit/hmr-hook build`
