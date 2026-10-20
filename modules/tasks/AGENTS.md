# modules/tasks

Distributed task queue. Add regression tests for scheduling, retry, and distribution logic
changes before completion.

## Validation

- `mise exec -- pnpm --filter @sonamu-kit/tasks check`
- `mise exec -- pnpm --filter @sonamu-kit/tasks test`
- `mise exec -- pnpm --filter @sonamu-kit/tasks build`
