# Repository Guidelines

## Project Structure & Module Organization

- Root-level Node.js scripts implement LLRP communication: `reader.js` (full client), `minimal.js` (minimal connectivity), `readertest.js` (capabilities debug), and `workingreader.js` (alternate client).
- Logs from local runs live in `test_antenna*.log`.
- There is no `src/` or build system; all entry points are in the repo root.

## Build, Test, and Development Commands

- `node reader.js` runs the full-featured reader with reconnects, logging, and stats.
- `node minimal.js` exercises a minimal ROSpec for quick connectivity testing.
- `node readertest.js` prints detailed capabilities parsing output.

No build step or package manager is required; the scripts use Node.js built-ins only.

## Coding Style & Naming Conventions

- Indentation varies by file (some use 4 spaces, others 2); keep the existing style in the file you edit.
- Prefer `const` and `let`; avoid introducing external dependencies.
- Use descriptive constant maps for protocol IDs (e.g., `MSG`, `PARAM`).
- Naming: files are lowercase with optional underscores; constants are `UPPER_SNAKE_CASE`, functions/classes `camelCase`/`PascalCase`.

## Testing Guidelines

- No automated test framework is present. Testing is manual via the scripts above.
- Use real hardware or captured logs (e.g., `test_antenna1.log`) when validating protocol parsing.

## Commit & Pull Request Guidelines

- No Git history is available in this directory, so no established commit convention can be inferred.
- Use short, imperative subject lines (e.g., "Handle KEEPALIVE ack timeouts") and include a brief body if the change is non-trivial.
- In PRs, summarize behavior changes, list the script(s) used to validate, and include reader configuration details when relevant (IP, antennas, power).

## Configuration & Safety Tips

- Update the reader IP/port and antenna power in `reader.js` before connecting.
- Ensure the reader is in LLRP Server mode on port 5084 and that hop/power tables are derived from capabilities, not hardcoded.
