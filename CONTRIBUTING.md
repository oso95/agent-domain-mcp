# Contributing

Contributions are welcome. This guide covers how to set up the project, run tests, and submit a pull request.

## Prerequisites

- Node.js 18 or later
- npm 9 or later

## Setup

```bash
git clone https://github.com/oso95/domain-suite-mcp.git
cd domain-suite-mcp
npm install
npm run build
```

## Running Tests

```bash
npm test
```

All 161 unit tests must pass before opening a pull request.

## Type Checking

```bash
npm run typecheck
```

The project uses TypeScript strict mode. No type errors are permitted.

## Integration Testing

Integration tests run against real provider APIs and are opt-in:

```bash
# Copy .env.example and fill in your API keys
cp .env.example .env

# Run the smoke test
node scripts/smoke-test.mjs
```

Integration tests require real credentials. Namecheap sandbox (`NAMECHEAP_SANDBOX=true`) and GoDaddy OTE (`GODADDY_SANDBOX=true`) environments are safe for testing without incurring costs.

## Code Style

- TypeScript strict mode throughout
- ESM modules (`"type": "module"`)
- No `any` types
- All errors must be `AgentError` instances with a `code`, `message`, and `action` field
- Error messages must be actionable: tell the agent what went wrong and exactly what to do next

## Adding a Provider

1. Create `src/providers/<name>/client.ts` implementing the `Provider` interface from `src/providers/types.ts`
2. Add provider config to `src/config.ts`
3. Register the provider in `src/registry.ts`
4. Add notes to `src/tools/providers.ts` (`SUPPORTED_NOTES`, `UNSUPPORTED_NOTES`)
5. Add provider setup instructions to `docs/PROVIDERS.md`
6. Update the provider table in `README.md`
7. Add unit tests in `tests/unit/`

## Pull Request Guidelines

- One logical change per PR
- Add or update unit tests for any changed behaviour
- Update `docs/TOOLS.md` and `docs/PROVIDERS.md` if tool schemas or provider capabilities change
- Add a CHANGELOG entry under `[Unreleased]`
- Titles follow conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

## Reporting Issues

Open an issue with:
- The tool name and input that caused the problem
- The error output (sanitize any API keys)
- The provider you are using
