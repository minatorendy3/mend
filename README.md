# mend

`mend` is one patch tool for every AI edit format: it applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and `mend` reads each one exactly as [SPEC.md](SPEC.md) says. Every file is changed or nothing is.

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/minatorendy3/mend/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/minatorendy3/mend/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

Built for the [make.fun competition "Build mend, one patch tool for every AI edit format"](https://make.fun/competitions/hidden-spec-cli-01-run-20261122) (`hidden-spec-cli-01-run-20261122`).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## How it works

- **Three-tier matching.** Old lines are found at the first tier where they occur: exact (tier 0), ignoring trailing spaces and tabs (tier 1), or ignoring leading and trailing spaces and tabs with re-indentation (tier 2). Each format then takes the occurrence its section says: nearest to the hunk's line number for unified diffs, exactly one for SEARCH/REPLACE, the first at or after the cursor for V4A.
- **Four parsers, one engine.** Unified diffs (sections, hunks, renames, creates, deletes, moves, `\ No newline at end of file`), SEARCH/REPLACE blocks (path fallback, fence-aware), V4A patches (anchors, cursor, end-of-file chunks, `Move to`), and JSON tool calls (`create`, `str_replace`, `insert`) all lower to the same edit list.
- **Atomic.** Edits apply in patch order to the tree as earlier edits left it. A failed edit changes nothing and the edits after it still run, so every failure is reported; when any edit failed, no file is written at all.
- **Faithful bytes.** CRLF files keep CRLF, a file's final line break is preserved unless the patch says otherwise, and created files are written with LF.

## Files

- `main.ts` — the CLI (Node 22, standard library alone).
- `runner.ts` — the kit's trial runner, kept as it is.
- `LICENSE` — MIT.

## License

MIT. See [LICENSE](LICENSE).
