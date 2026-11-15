// Writes import templates in the app's format (apps/api/src/import/template.ts in Program
// Landscape), from the built-in declarations, with an optional edit per dataset to simulate an
// app whose import code has moved on.
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { listImportDatasets, type ImportDataset } from '../src/vendor/db';

export interface TemplateColumnSpec {
  header: string;
  required: boolean;
  type: string;
  example: string;
  allowed?: string[];
}

export interface TemplateSpec {
  slug: string;
  index: number;
  sheetName: string;
  title: string;
  matchHeaders: string[];
  columns: TemplateColumnSpec[];
}

export function specOfDataset(d: ImportDataset, index: number): TemplateSpec {
  const byKey = new Map(d.columns.map((c) => [c.key, c.header]));
  return {
    slug: d.slug,
    index,
    sheetName: d.sheetName,
    title: d.title,
    matchHeaders: d.strategy.match.columns.map((k) => byKey.get(k) ?? k),
    columns: d.columns.map((c) => ({
      header: c.header,
      required: c.required,
      type: c.type,
      example: c.example,
      ...(c.enumValues ? { allowed: [...c.enumValues] } : {}),
    })),
  };
}

export function templateBytes(t: TemplateSpec): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([t.columns.map((c) => c.header)]), t.sheetName);
  const keys = t.matchHeaders.join(' + ');
  const guide: unknown[][] = [
    [t.title],
    ['A description.'],
    [''],
    [`This workbook has two sheets. Put your data in "${t.sheetName}". This Guide sheet is ignored when you upload.`],
    [`Rows are matched on ${keys}. Uploading again will UPDATE rows whose ${keys} is already here, insert the ones that are new, and leave everything else untouched.`],
    ['Do not add, remove or rename columns — the upload is refused if the columns do not match exactly.'],
    ['Leave a cell blank when you have no value for it. Blank rows are ignored.'],
    [''],
    ['Column', 'Required', 'Type', 'What to put', 'Example', 'Allowed values'],
    ...t.columns.map((c) => [c.header, c.required ? 'Yes' : 'No', c.type, 'guide', c.example, (c.allowed ?? []).join(', ')]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(guide), 'Guide');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Writes all templates (numbered like `pnpm workshop:templates`) after applying `edit`. */
export function writeTemplates(dir: string, edit: (t: TemplateSpec) => TemplateSpec | null = (t) => t): void {
  fs.mkdirSync(dir, { recursive: true });
  listImportDatasets().forEach((d, i) => {
    const t = edit(specOfDataset(d, i + 1));
    if (!t) return;
    const name = `${String(t.index).padStart(2, '0')}-${t.slug}-template.xlsx`;
    fs.writeFileSync(path.join(dir, name), templateBytes(t));
  });
  fs.writeFileSync(path.join(dir, 'README.txt'), 'templates\n');
}
