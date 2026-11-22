# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/takoyakimaru333/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/takoyakimaru333/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is an entry for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122): one command-line tool that applies the edits AI models write, in four formats, to a tree of files. `SPEC.md` is the whole specification.

## Run

```sh
node main.ts [options] [PATCH]
```

Node 22 and its standard library alone. `PATCH` is the path of the patch file, relative to the working directory; when it is absent or `-`, the patch is read from standard input. `--format=NAME` reads the patch in one format (`unified`, `search-replace`, `v4a`, `json`); `auto`, the default, detects it. `--check` does everything but write, and `--strict` matches lines exactly.

## What it does

- Reads unified diffs (with wrong line numbers tolerated: each hunk takes the occurrence nearest its header line), SEARCH/REPLACE blocks, V4A patches, and JSON edit objects (`create`, `str_replace`, `insert`).
- Matches old lines at three tiers: exact, trailing whitespace ignored, then leading and trailing whitespace ignored with re-indentation of the new lines.
- Applies edits in the patch's order to the tree as earlier edits left it; a failed edit changes nothing and the edits after it still run, so every failure is reported. When any edit failed, no file is written.
- Reports what changed (`A`, `D`, `M`, and `R old -> new` for moves) and `ok: <n> files`, or the failures and `failed: <k> of <n> edits`.

## The files

- `main.ts`: the CLI. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.

## Practice score

100 of 100 passed: practice score 1000.
