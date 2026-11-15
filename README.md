# Workshop mock-data generator

Writes 20 mock import spreadsheets (and a `README.txt` of next steps) for your
university, so you can try the Program Landscape import without real data.
The figures are invented, but they agree with the public TCAS round-3 numbers
of your own programmes. It needs only Node (24.22.1 or later) and pnpm; it does not
need a Program Landscape checkout or a database.

This repository was extracted from the Program Landscape monorepo
(`apps/ingestion/src/scripts/workshop-mock/`). The app's import validator and TCAS
matcher are carried as a snapshot in `src/vendor/` (see
[Keeping in step with the app](#keeping-in-step-with-the-app)).

## Run

    pnpm install
    pnpm workshop:mock my-input.json

Flags:

- `--size small|medium` (default `small`): how many faculties and programmes.
- `--seed N` (default 2026): the same input and seed give byte-identical files.
- `--out DIR` (default `./workshop-mock-out`): where the files go. The folder gets a
  `.gitignore` containing `*`, so it is never committed.
- `--cache DIR` (default `<out>/.cache`): where TCAS files are kept.
- `--offline`: never download; use the cache only.
- `--tcas-file PATH:YEAR:ROUND` (repeatable): use a TCAS file you downloaded, for
  example `--tcas-file tcas67.xlsx:2567:3` (year is Buddhist era; rounds are `3`, or
  `3.1` / `3.2` for 2568). The file is copied into the cache, so later runs can use
  `--offline`.
- `--templates DIR`: fit the files to the app's own import templates (see
  [Using the app's templates](#using-the-apps-templates)).

Relative paths you type (the input file, `--out`, `--cache`, `--tcas-file`, `--templates`) resolve
against the folder you ran pnpm from.

On start the program prints which TCAS row each of your programmes was matched to, and
every note (English names it had to invent, how courses were read). Read them.

Exit code 0 is success, 2 is an input problem (a message, no stack trace). Before any file
is written, every sheet is checked with the app's own importer validator; if one would be
refused, nothing is written. Then open `README.txt` in the output folder.

The check uses this repository's snapshot of the importer. To prove the files against
the importer and the `tcas` connector's matcher of the app version you will load them
into, run this from a Program Landscape checkout:

    pnpm workshop:check-mock <out> my-input.json

## Using the app's templates

Without `--templates` the files follow this repository's snapshot of the importer
(`src/vendor/`). If the app you will upload into is newer, give it the app's templates:

    # in a Program Landscape checkout, or use the bundle the facilitator sent
    pnpm workshop:templates --out ~/import-templates

    # here
    pnpm workshop:mock my-input.json --templates ~/import-templates

The folder holds `NN-<slug>-template.xlsx` files; a single template downloaded from a
dataset's page (`<slug>-template-YYYY-MM-DD.xlsx`) works too. Each sheet is then written with
the template's sheet name and columns, in the template's order, and the files are numbered
by the template numbers. Columns are matched by header, ignoring case, spaces and
punctuation, so the generator copes when the app:

- adds an optional column: it is left blank;
- adds a required column: every row gets the template's example value (the run stops if
  the template has no example);
- removes a column: it is not written;
- reorders columns, renames the data sheet or renumbers the datasets;
- changes a header only in case or punctuation.

Every change is printed and listed under "Notes from this run" in `README.txt`. Read them:
a filled-in example value is valid but meaningless. Columns that still match the built-in
ones keep the importer's full rules (checks, references, duplicate keys). New or retyped
columns are checked for what the template states: required, type and allowed values. A
renamed header (beyond case or punctuation), a new kind of value, or a new dataset needs a
change to the generator (`src/datasets.ts`).

## Input file

`example-input.json` in this folder is a starting point. JSON has no comments, so every
field is explained here.

- `university` (required): the Thai name exactly as the TCAS files spell it.
- `region` (required): one of `Northeast`, `Central`, `North` or `South`. Central covers
  Bangkok, the East and the West; any other value stops the run.
- `programmes` (required): one entry per curriculum PDF.
  - `name` (required): the programme name as written in the PDF (a small spelling
    difference is fine).
  - `pdf`: path to the curriculum PDF. Relative paths resolve against the JSON file's folder.
    If given, the file must exist, or the run stops.
  - `level`: `BACHELOR` (default), `MASTER`, `DOCTORAL` or `HIGHER_GRAD_DIPLOMA`.
  - `faculty` (required): the faculty's Thai name as the TCAS files spell it. For a bachelor
    programme it must match a TCAS faculty, or the run stops and lists them; it also settles
    a name taught in two faculties (KMUTT has วิศวกรรมเครื่องกล in two). A postgraduate
    programme in a faculty with no TCAS rows keeps the name as typed.
  - `tcas_code`: a TCAS course code. Use it when the name cannot be matched
    automatically; it always wins over name matching.
  - `name_en`: the English name, used as-is in the mock files. Without it the generator
    translates common Thai words and otherwise writes a neutral placeholder.
  - `courses`: path to a CSV file (header `code,name_th,name_en,credits,category`) to use
    instead of the PDF's courses.

## If something fails

- `University '...' is not in the TCAS files`: copy the Thai name from one of the
  closest names it lists.
- `Cannot match programme`: add `"tcas_code": "<course code>"` to that entry, using a
  code from the candidate list, or check that the entry's `faculty` is right.
- `faculty '...' has no programmes in the latest TCAS year`: copy the faculty's Thai name
  from the list it prints.
- `pdf not found` / `courses not found`: the path is wrong. It resolves against the input
  file's folder, and the message shows the full path it tried.
- `tcas_code ... is not in the latest TCAS year`: course codes change every year; use the
  code it suggests.
- `No TCAS data` with `--offline`: run once without `--offline`, or pass `--tcas-file`.
- `Cannot download`: download the files from mytcas.com yourself and pass `--tcas-file`.
- `no course codes found in ...pdf`: the PDF is a scan or has no course table. An invented
  course list is used. Give a `courses` CSV to use your own.

## Tests

    pnpm check        # typecheck + vitest

## Keeping in step with the app

`src/vendor/` is generated; never edit it by hand. It holds the parts of Program
Landscape the generator calls: the 26 import-dataset declarations with their column
specs, row rules and strategies, `validateSheet`, the course-code helpers, the TCAS
matcher, the built-in TCAS file list and the PDF text extractor. Everything
database-side (loaders, counts, start-over guards, Prisma types) is stripped, and the
Prisma enums a column check names become string-union types. `src/vendor/SOURCE.md`
records the app commit the snapshot came from.

Small changes in the app are covered at run time by `--templates`. When the app's import
declarations change for good (a new dataset, a renamed column, a new rule), refresh the
snapshot and re-run the tests:

    pnpm sync-vendor ../program-landscape   # path to an app checkout
    pnpm check

The sync takes two to three minutes. It fails, writing nothing, if stripped code still
needs Prisma or another package; read the message and extend `scripts/sync-vendor.ts`.
A new dataset in the app also changes the numbered file list (`UPLOAD_ORDER`), so
check the tests that count files.
