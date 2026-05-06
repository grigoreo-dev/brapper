# Contributing to brapper

brapper is an open-source project under the [grigoreo-dev](https://github.com/grigoreo-dev) organization. Contributions are welcome.

---

## Project setup

```bash
git clone https://github.com/grigoreo-dev/brapper
cd brapper
pnpm install
pnpm typecheck
```

## Development

```bash
pnpm build        # compile TypeScript
pnpm typecheck    # type-check without emitting
pnpm dev          # watch mode
```

There is no local dev server for brapper itself — it is a library. Test your changes by linking it into a brap project:

```bash
# in brapper/
pnpm link --global

# in your brap project/
pnpm link --global brapper
```

---

## What belongs in brapper

brapper is **infrastructure only**. A contribution belongs here if it is:

- Useful across multiple different brap projects
- Not specific to any particular target web application
- Not tied to a specific captcha service, login flow, or site structure

If it is specific to one target web application, it belongs in that brap project, not here.

When in doubt, ask in an issue first.

---

## Code style

- TypeScript strict mode — no `any`, no type assertions without comment explaining why
- ESM only — `import/export`, `.js` extensions on local imports
- No default exports — named exports only
- Comments explain **why**, not what — no narrating the code
- No emojis in source files or commit messages

---

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add SessionGate open/close/degrade
fix: BrowserSession reconnect race condition
docs: update concurrency model
refactor: extract page pool into separate class
test: SessionGate concurrent wait resolution
```

Keep commits atomic — one logical change per commit.

---

## Pull requests

1. Open an issue first for non-trivial changes — alignment before implementation
2. Branch from `main`: `feat/session-gate`, `fix/reconnect-race`, etc.
3. Keep PRs focused — one feature or fix per PR
4. Update docs if you change public API
5. Run `pnpm typecheck` before pushing — CI will reject type errors

PR title follows the same Conventional Commits format as commit messages.

---

## Reporting issues

Include:
- brapper version
- Node.js version
- What you expected vs what happened
- Minimal reproduction if possible

---

## Roadmap and priorities

See [ROADMAP.md](ROADMAP.md). Items marked with `[ ]` are open for contribution. If you want to work on something, comment on the relevant issue (or open one) to avoid duplicate work.

---

## License

MIT. By contributing you agree your changes will be published under the same license.
