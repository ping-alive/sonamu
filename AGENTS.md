# Repository Instructions

## Toolchain

- Run `mise install --locked` for explicit toolchain setup.
- Use `mise run <task>` for repository-wide tasks and `mise exec -- pnpm ...`
  (or `mise exec -- node ...`) for package-local or raw tool commands. Do not
  invoke host `node`, `npm`, `npx`, or `pnpm` directly. The root `mise.toml`
  resolves from subdirectories.
- Docker, EAS, and container build files intentionally omit mise.

## Validation

- Run `mise run check` (oxlint + oxfmt) at the repository root for every code
  change.
- Run the tests and builds listed in each affected module's `AGENTS.md`.
- For framework-core, generator, template, or generated-output changes, validate
  the resulting behavior in `examples/miomock`.
- For user-visible UI changes, verify the affected flow in a browser when the
  application can run locally.

## Skills

- Sonamu framework guidance comes from the installed `sonamu-*` skills
  (`cartanova-ai/sonamu-skills`). Read the applicable one before changing
  framework behavior.
- For React changes, follow the `vercel-react-best-practices` skill.
- Optional: the `agent-harness` plugin from the private `cartanova-ai/skills`
  repository provides workflow, review, and commit skills. Its project adapter
  is `.cartanova/harness.yaml`. Without it, use your runtime's defaults.

## Commits

Match the subject grammar and language of recent `git log`
(`[<package>] <type>(SON-<n>): <summary>`, Korean summary). Never invent an
issue number.

## Code Style

- Write code comments and test descriptions in Korean.
- Add concise inline comments only where business logic needs its intent or
  rationale explained; use JSDoc for detailed method documentation.
