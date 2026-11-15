import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_ORDER } from '../src/datasets';
import { main } from '../src/generate';
import { InputError } from '../src/inputs';
import { readTemplateDir } from '../src/templates';
import { writeTemplates, type TemplateSpec } from './template-helper';

const FIX = path.join(__dirname, 'fixtures');
const INPUT = path.join(FIX, 'fixture-input.json');
const TCAS_ARG = `${path.join(FIX, 'tcas-sample.xlsx')}:2567:3`;

let tmp = '';
let logs: string[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-tpl-'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = async (argv: string[]): Promise<{ code: number; text: string }> => {
  const code = await main([INPUT, '--tcas-file', TCAS_ARG, ...argv], tmp);
  return { code, text: logs.join('\n') };
};
const bytes = (dir: string): Record<string, string> =>
  Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((f) => fs.statSync(path.join(dir, f)).isFile())
      .map((f) => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]),
  );
const sheet = (file: string): { name: string; rows: unknown[][] } => {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const name = wb.SheetNames[0] as string;
  return { name, rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name] as XLSX.WorkSheet, { header: 1 }) };
};
const edit =
  (slug: string, f: (t: TemplateSpec) => TemplateSpec | null) =>
  (t: TemplateSpec): TemplateSpec | null =>
    t.slug === slug ? f(t) : t;
const chain =
  (...fs: Array<(t: TemplateSpec) => TemplateSpec | null>) =>
  (t: TemplateSpec): TemplateSpec | null =>
    fs.reduce<TemplateSpec | null>((acc, f) => (acc ? f(acc) : null), t);

describe('readTemplateDir', () => {
  it('reads slug, number, sheet, title, match key and every column of the Guide', () => {
    const dir = path.join(tmp, 'tpl');
    writeTemplates(dir);
    fs.writeFileSync(path.join(dir, 'notes.xlsx'), 'not a template'); // ignored: wrong name
    const t = readTemplateDir(dir);
    expect(t.size).toBe(26);
    const p = t.get('programmes');
    expect(p?.index).toBe(3);
    expect(p?.sheetName).toBe('Programmes');
    expect(p?.matchHeaders).toEqual(['Programme Code']);
    const level = p?.columns.find((c) => c.header === 'Level');
    expect(level).toMatchObject({ required: true, type: 'enum' });
    expect(level?.enumValues).toContain('BACHELOR');
    expect(t.get('program-faculty')?.matchHeaders).toEqual(['Programme Code', 'Employee Code']);
  });

  it('reads a single template downloaded from a dataset page', () => {
    const dir = path.join(tmp, 'tpl');
    writeTemplates(dir, (t) => (t.slug === 'faculties' ? t : null));
    fs.renameSync(path.join(dir, '01-faculties-template.xlsx'), path.join(dir, 'faculties-template-2026-11-15.xlsx'));
    const t = readTemplateDir(dir);
    expect([...t.keys()]).toEqual(['faculties']);
    expect(t.get('faculties')?.index).toBeNull();
  });

  it('refuses a missing folder and a folder with no templates', () => {
    expect(() => readTemplateDir(path.join(tmp, 'nope'))).toThrow(InputError);
    fs.mkdirSync(path.join(tmp, 'empty'));
    expect(() => readTemplateDir(path.join(tmp, 'empty'))).toThrow(/no import templates/);
  });
});

describe('--templates', () => {
  it('gives byte-identical files when the templates match the built-in columns', async () => {
    writeTemplates(path.join(tmp, 'tpl'));
    const a = await run(['--out', path.join(tmp, 'a')]);
    const b = await run(['--out', path.join(tmp, 'b'), '--templates', 'tpl']);
    expect(a.code, a.text).toBe(0);
    expect(b.code, b.text).toBe(0);
    expect(b.text).not.toMatch(/template /);
    expect(bytes(path.join(tmp, 'b'))).toEqual(bytes(path.join(tmp, 'a')));
  });

  it('fits sheets to templates whose columns moved on', async () => {
    writeTemplates(
      path.join(tmp, 'tpl'),
      chain(
        // a new optional column, columns reordered, the sheet renamed
        edit('faculties', (t) => ({
          ...t,
          sheetName: 'Faculty List',
          columns: [...t.columns].reverse().concat({ header: 'Website', required: false, type: 'text', example: 'https://x' }),
        })),
        // an optional column removed
        edit('programmes', (t) => ({ ...t, columns: t.columns.filter((c) => c.header !== 'Official Code') })),
        // a header renamed by case only, and a new required column with an example
        edit('departments', (t) => ({
          ...t,
          columns: t.columns
            .map((c) => (c.header === 'Name (English)' ? { ...c, header: 'Name (english)' } : c))
            .concat({ header: 'Campus', required: true, type: 'text', example: 'Main campus' }),
        })),
      ),
    );
    const out = path.join(tmp, 'out');
    const r = await run(['--out', out, '--templates', 'tpl']);
    expect(r.code, r.text).toBe(0);

    const fac = sheet(path.join(out, '01-faculties.xlsx'));
    expect(fac.name).toBe('Faculty List');
    expect(fac.rows[0]).toEqual(['Teaching Mode', 'Kind', 'Name (English)', 'Name (Thai)', 'Faculty Code', 'Website']);
    expect((fac.rows[1] as unknown[])[4]).toMatch(/^MOCK-F\d+$/); // codes landed in the moved column

    const prog = sheet(path.join(out, '03-programmes.xlsx'));
    expect(prog.rows[0]).not.toContain('Official Code');

    const dep = sheet(path.join(out, '02-departments.xlsx'));
    expect(dep.rows[0]).toEqual(['Department Code', 'Name (Thai)', 'Name (english)', 'Faculty Code', 'Campus']);
    expect(dep.rows.slice(1).every((row) => row[4] === 'Main campus' && typeof row[2] === 'string')).toBe(true);

    const readme = fs.readFileSync(path.join(out, 'README.txt'), 'utf-8');
    for (const t of [
      "new optional column 'Website' left blank",
      "data sheet is now named 'Faculty List'",
      "column 'Official Code' is not in the template",
      "column 'Name (English)' is now 'Name (english)'",
      "new required column 'Campus' filled with the template's example 'Main campus'",
    ]) {
      expect(readme).toContain(t);
      expect(r.text).toContain(t);
    }
  });

  it('follows the template numbers for the file order', async () => {
    // swap enrolment and financial metrics
    writeTemplates(path.join(tmp, 'tpl'), (t) =>
      t.slug === 'enrollment-metrics' ? { ...t, index: 5 } : t.slug === 'financial-metrics' ? { ...t, index: 4 } : t,
    );
    const out = path.join(tmp, 'out');
    const r = await run(['--out', out, '--templates', 'tpl']);
    expect(r.code, r.text).toBe(0);
    expect(fs.existsSync(path.join(out, '04-financial-metrics.xlsx'))).toBe(true);
    expect(fs.existsSync(path.join(out, '05-enrollment-metrics.xlsx'))).toBe(true);
    expect(r.text).toContain('upload order follows the template numbers');
  });

  it('uses the built-in columns for a missing template and notes an unknown dataset', async () => {
    const dir = path.join(tmp, 'tpl');
    writeTemplates(dir, (t) => (t.slug === 'research-outputs' ? null : t));
    fs.copyFileSync(path.join(dir, '01-faculties-template.xlsx'), path.join(dir, '27-new-thing-template.xlsx'));
    const out = path.join(tmp, 'out');
    const r = await run(['--out', out, '--templates', 'tpl']);
    expect(r.code, r.text).toBe(0);
    expect(fs.readdirSync(out).filter((f) => f.endsWith('.xlsx'))).toHaveLength(UPLOAD_ORDER.length);
    expect(r.text).toContain('no template for research-outputs');
    expect(r.text).toContain('template new-thing: a dataset this generator does not know');
  });

  it('stops, writing nothing, on a new required column it cannot fill', async () => {
    writeTemplates(
      path.join(tmp, 'tpl'),
      edit('faculties', (t) => ({ ...t, columns: [...t.columns, { header: 'Dean', required: true, type: 'text', example: '' }] })),
    );
    const out = path.join(tmp, 'out');
    const r = await run(['--out', out, '--templates', 'tpl']);
    expect(r.code).toBe(2);
    expect(r.text).toContain("required column 'Dean' is new");
    expect(fs.existsSync(out)).toBe(false);
  });

  it('checks a retyped column against the template and refuses what it cannot accept', async () => {
    // Faculty Code becomes an integer: the generator's codes (F01, ...) are not whole numbers
    writeTemplates(
      path.join(tmp, 'tpl'),
      edit('faculties', (t) => ({
        ...t,
        columns: t.columns.map((c) => (c.header === 'Faculty Code' ? { ...c, type: 'integer' } : c)),
      })),
    );
    const out = path.join(tmp, 'out');
    const r = await run(['--out', out, '--templates', 'tpl']);
    expect(r.code).toBe(2);
    expect(r.text).toContain("column 'Faculty Code' changed type from text to integer");
    expect(r.text).toMatch(/faculties: its template \(01-faculties-template\.xlsx\) would refuse this sheet/);
    expect(fs.existsSync(out)).toBe(false);
  });
});
