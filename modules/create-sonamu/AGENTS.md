# modules/create-sonamu

Project generator (`mise exec -- pnpm create sonamu`). `index.ts` drives the prompts, copies
`template/`, and writes the generated `package.json` and `pnpm-workspace.yaml`. `template/` is the
source of every generated project; anything wrong here ships to every new project.

## Dependency versions in generated projects

The template declares `"sonamu": "workspace:^"`. `scripts/prepublish.mjs` substitutes the current
versions before an npm publish and `postpublish.mjs` restores the originals, so only the
generator run from this monorepo leaves `workspace:^` in place. Substituted versions freeze at
create-sonamu's publish time, and a caret on a `0.x` version does not cross a minor, so new
projects lag until create-sonamu is republished.

## Validation

- For template changes, generate a project and verify it installs and builds.
- Template files are excluded from oxfmt (root `.oxfmtrc.json`); match the surrounding style by
  hand.
