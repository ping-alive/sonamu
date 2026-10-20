# modules/cli

`@sonamu-kit/cli`. The CLI grammar lives in `src/program.ts`, dispatch and lifecycle in
`src/runtime.ts`, presentation in `src/output.ts`. Command behavior is implemented in `sonamu`
(`src/tooling/*`); a parser branch and its tooling handler form one contract, so change both
together.

## Optique

Before changing parsers, options, subcommands, completion, or help output, read the bundled
Optique skill at `node_modules/@optique/core/skills/optique/SKILL.md` and follow it: compose with
`object()`/`or()`/`command()`, express optionality with `optional()` or `withDefault()`, and
validate values with value parsers instead of post-parse checks.

## High-impact areas

- `src/program.ts`: every accepted option must be satisfiable by its tooling handler (optional in
  the grammar must not be required in the handler), and value-parser bounds must match the
  tooling-side schema exactly.
- `src/runtime.ts`: destructive-operation guards, production confirmation, and lifecycle order
  (candidate providers must not touch framework state before Sonamu is initialized).
- `src/handlers.ts`: any package resolved at runtime must be a declared dependency in
  `package.json`; peer transitive dependencies are not resolvable here.
- `bin/sonamu.js`: validate the CLI entry after build.

## Validation

- `mise exec -- pnpm --filter @sonamu-kit/cli check`
- `mise exec -- pnpm --filter @sonamu-kit/cli test`
- When command behavior changes, verify the flow in `examples/miomock`.
- When a command is added, renamed, or removed, update `modules/docs` (ko and en) and the
  `modules/create-sonamu` READMEs in the same change.
