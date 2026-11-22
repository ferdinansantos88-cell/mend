# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ferdinansantos88-cell/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ferdinansantos88-cell/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a command-line patch tool that applies edits written by AI in any of the four formats AI tools actually emit, against a tree of text files. One tool, four formats, no conversion step.

## Formats

- **Unified diffs** — `diff --git`, `---`/`+++` headers, `rename from`/`rename to`, new/deleted files, hunks with wrong line numbers (nearest occurrence wins), creation, deletion, moves, `\ No newline at end of file`.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, path taken from the nearest line above the block, path inherited from the previous block, exactly-once occurrence.
- **V4A patches** — `*** Begin Patch` / `*** End Patch`, Add/Delete/Update File, `*** Move to:`, `@@` anchors, cursor-tracked chunks, `*** End of File`.
- **JSON edits** — one JSON array or JSON Lines of `create` / `str_replace` / `insert` objects, exact substring match (no tier).

## Matching

Every old block is found at the first of three tiers at which it occurs at least once:

- **tier 0** — every line exactly equal;
- **tier 1** — equal once trailing spaces and tabs are removed;
- **tier 2** — equal once leading and trailing spaces and tabs are removed, with new lines re-indented to the file's own indentation.

`--strict` tries tier 0 only. That is the whole edge over the house strict applier, which is tier 0 only: `mend` succeeds where a strict applier reports `no-match`.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / absent for standard input. Exit codes: `0` applied (or `--check` clean), `1` one or more edits failed (`error: <code> <path>` per failed edit, then `failed: <k> of <n> edits`), `2` usage / no patch / format / parse fault (`error: parse <N>`). A successful run prints one `A`/`D`/`M`/`R` line per changed file (sorted by path bytes, moves as one `R old -> new` line sorted by the new path), then `ok: <n> file(s)`. A failed edit changes nothing, later edits still run, and when any edit failed no file is written at all.

Paths are checked for safety first (no leading `/`, no `\`, no empty/`.`/`..` segments). Files keep their own line break (LF or CRLF) and their final break; created files use LF and end with a break unless the format says otherwise.

## Practice score

**100/100 — practice score 1000** on the kit's public practice set (unified 30, SEARCH/REPLACE 20, V4A 20, JSON 15, CLI 15), verified with `node check.ts <kit>/program/generator/practice.json`.

## Run

Node 22, standard library only, no dependencies:

```
node main.ts patch.diff
```

## License

MIT. See [LICENSE](LICENSE).
