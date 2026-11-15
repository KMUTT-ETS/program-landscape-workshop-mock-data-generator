// Read a folder of the app's XLSX import templates.
//
// The folder is what `pnpm workshop:templates --out <dir>` writes in a Program Landscape
// checkout (the bundle the facilitator hands out): `NN-<slug>-template.xlsx`, numbered in upload
// order. A single template downloaded from a dataset's page (`<slug>-template-YYYY-MM-DD.xlsx`)
// is read too; it carries no number.
//
// Each template has the data sheet first (row 1 = the exact headers the importer accepts) and a
// "Guide" sheet: a preamble (title, description, "Rows are matched on A + B. ...") followed by a
// table with one row per column: Column | Required | Type | What to put | Example | Allowed values.
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type { ImportCellType } from './vendor/db';
import { InputError } from './inputs';

export interface TemplateColumn {
  header: string;
  /** null when the template has no Guide row for the column. */
  required: boolean | null;
  type: ImportCellType | null;
  enumValues: string[] | null;
  example: string;
}

export interface TemplateInfo {
  slug: string;
  /** Upload-order number from the file name; null for a single downloaded template. */
  index: number | null;
  file: string;
  sheetName: string;
  /** The Guide's first line; null without a Guide. */
  title: string | null;
  /** Headers of the "Rows are matched on ..." line; empty when it cannot be read. */
  matchHeaders: string[];
  columns: TemplateColumn[];
}

const BUNDLE_NAME = /^(\d+)-(.+)-template\.xlsx$/i;
const SINGLE_NAME = /^(.+)-template-\d{4}-\d{2}-\d{2}\.xlsx$/i;
const CELL_TYPES: readonly ImportCellType[] = ['text', 'integer', 'decimal', 'date', 'boolean', 'enum'];

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();

function readTemplate(file: string, slug: string, index: number | null): TemplateInfo {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  } catch (err) {
    throw new InputError(`${file} cannot be read as an XLSX template (${(err as Error).message})`);
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new InputError(`${file} has no sheets`);
  const data = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName] as XLSX.WorkSheet, { header: 1, blankrows: false });
  const headers = (data[0] ?? []).map(text).filter((h) => h !== '');
  if (headers.length === 0) throw new InputError(`${file}: the first sheet ('${sheetName}') has no header row`);

  const guideName = wb.SheetNames.find((n) => n.trim().toLowerCase() === 'guide');
  const guide = guideName
    ? XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[guideName] as XLSX.WorkSheet, { header: 1, blankrows: true, defval: null })
    : [];
  const tableAt = guide.findIndex((r) => text(r[0]) === 'Column' && text(r[1]) === 'Required');
  const byHeader = new Map<string, unknown[]>();
  if (tableAt >= 0) {
    for (const r of guide.slice(tableAt + 1)) if (text(r[0])) byHeader.set(text(r[0]), r);
  }
  const preamble = (tableAt >= 0 ? guide.slice(0, tableAt) : []).map((r) => text(r[0]));
  const matched = preamble.map((l) => /^Rows are matched on (.+?)\. /.exec(l)).find(Boolean);

  const columns: TemplateColumn[] = headers.map((header) => {
    const g = byHeader.get(header);
    if (!g) return { header, required: null, type: null, enumValues: null, example: '' };
    const type = text(g[2]) as ImportCellType;
    const allowed = text(g[5]);
    return {
      header,
      required: text(g[1]).toLowerCase() === 'yes',
      type: CELL_TYPES.includes(type) ? type : null,
      enumValues: allowed ? allowed.split(',').map((s) => s.trim()).filter(Boolean) : null,
      example: text(g[4]),
    };
  });

  return {
    slug,
    index,
    file,
    sheetName,
    title: preamble[0] || null,
    matchHeaders: matched?.[1] ? matched[1].split(' + ').map((s) => s.trim()) : [],
    columns,
  };
}

/** Every template in `dir`, keyed by dataset slug. Throws InputError when there are none. */
export function readTemplateDir(dir: string): Map<string, TemplateInfo> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new InputError(`--templates: folder not found: ${dir}`);
  }
  const found = new Map<string, TemplateInfo>();
  for (const name of fs.readdirSync(dir).sort()) {
    const bundle = BUNDLE_NAME.exec(name);
    const single = bundle ? null : SINGLE_NAME.exec(name);
    if (!bundle && !single) continue;
    const slug = (bundle ? bundle[2] : single?.[1]) as string;
    const index = bundle ? Number(bundle[1]) : null;
    if (found.has(slug)) throw new InputError(`--templates: two templates for '${slug}' in ${dir}; keep one`);
    found.set(slug, readTemplate(path.join(dir, name), slug, index));
  }
  if (found.size === 0) {
    throw new InputError(
      `--templates: no import templates in ${dir}. Expected files named like 01-faculties-template.xlsx ` +
        '(from `pnpm workshop:templates --out <dir>` in a Program Landscape checkout).',
    );
  }
  return found;
}
