# Contributing to OpenOutposts

Thank you for your interest in contributing to OpenOutposts! This document provides guidelines for
contributing to the project.

OpenOutposts is derived from Open-Inspect; some inherited packages retain their `@open-inspect`
internal npm scope. The current architecture and package responsibilities are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/OpenOutposts.git`
3. Install dependencies: `npm install`
4. Build the foundation: `npm run build:foundation`
5. Run the foundation tests: `npm run test:foundation`
6. Create a branch for your changes: `git checkout -b feature/your-feature-name`

## Development Setup

The quickest way to get a working environment:

```bash
npm install
npm run build:foundation
npm run test:foundation
```

For the current local end-to-end loop, follow
[docs/OUTPOSTS_QUICKSTART.md](docs/OUTPOSTS_QUICKSTART.md). For individual checks:

```bash
# Install dependencies
npm install

# Build the outpost foundation (protocol, homestead, Go worker)
npm run build:foundation

# Run the foundation tests
npm run test:foundation

# Run type checking
npm run typecheck

# Run linting
npm run lint

# Run the full test suite
npm test
```

## Project Structure

| Package                     | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `packages/outpost-protocol` | Versioned homestead/worker protocol messages    |
| `packages/homestead`        | Central harness runtime and Pi adapter          |
| `packages/outpost-worker`   | Thin Go worker for owned execution targets      |
| `packages/control-plane`    | Cloudflare control plane and Durable Objects    |
| `packages/web`              | Next.js product interface                       |
| `packages/shared`           | Shared product types and service-auth contracts |
| `packages/github-bot`       | GitHub integration Worker                       |
| `packages/linear-bot`       | Linear integration Worker                       |
| `packages/slack-bot`        | Slack integration Worker                        |

## Making Changes

### Code Style

- Run `npm run lint` before committing
- Run `npm run typecheck` to ensure type safety
- Follow existing code patterns in the codebase

### Commit Messages

Use clear, descriptive commit messages:

- `feat: add new feature`
- `fix: resolve issue with X`
- `docs: update documentation`
- `refactor: restructure module`

### Pull Requests

1. Ensure all tests pass: `npm test`
2. Ensure linting passes: `npm run lint`
3. Ensure type checking passes: `npm run typecheck`
4. Update documentation if needed
5. Provide a clear description of your changes

### Source Control Provider Contributions

For SCM/provider changes, follow:

- `docs/adr/0001-single-provider-scm-boundaries.md`

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, etc.)

## Questions

If you have questions, please open a GitHub issue with the "question" label.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
