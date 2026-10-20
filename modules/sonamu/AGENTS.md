# modules/sonamu

Framework core; changes affect every Sonamu-based project. Internal tests are limited, so
miomock integration verification is mandatory evidence. HMR changes usually span
`@sonamu-kit/hmr-hook`, `@sonamu-kit/hmr-runner`, and `@sonamu-kit/ts-loader`; review
cross-package impact.

## High-impact areas

- `src/database/puri.ts`, `src/database/puri.types.ts`: type inference and nullability are
  high-risk; validate type-level and runtime behavior together.
- `src/syncer/template*.ts`: template changes affect generated code across projects; verify
  regeneration in miomock.
- `src/database/migrator.ts`: migration behavior changes require explicit evidence.
- `src/api/config.ts`: validate runtime vs. development path resolution.
- `bin/cli.js`: validate the CLI entry after build.

## Validation

- `mise exec -- pnpm --filter sonamu build`
- `mise exec -- pnpm --filter sonamu test:type`
- `mise exec -- pnpm --filter miomock-api test`
- If templates or generation paths changed, validate the sync result and generated outputs in
  miomock.
