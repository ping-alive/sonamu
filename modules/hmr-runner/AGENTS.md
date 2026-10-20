# modules/hmr-runner

Runner for HMR-enabled applications. Add regression tests for lifecycle, restart, and
failure-handling changes.

## Validation

- `mise exec -- pnpm --filter @sonamu-kit/hmr-runner typecheck`
- `mise exec -- pnpm --filter @sonamu-kit/hmr-runner lint`
- `mise exec -- pnpm --filter @sonamu-kit/hmr-runner test`
- `mise exec -- pnpm --filter @sonamu-kit/hmr-runner build`
