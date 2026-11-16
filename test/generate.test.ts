import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_ORDER, sheetInfo } from '../src/datasets';
import { main } from '../src/generate';
import { loadInputs } from '../src/inputs';
import { TCAS_FILES, loadRows, ownRows } from '../src/tcas';
import { assertCellsClean, datasetBytes } from '../src/write';

const FIX = path.join(__dirname, 'fixtures');
const FIXTURE = path.join(FIX, 'tcas-sample.xlsx');
const INPUT = path.join(FIX, 'fixture-input.json');
const TCAS_ARG = `${FIXTURE}:2567:3`;
const GENERATE = path.join(__dirname, '..', 'src', 'generate.ts');

let tmp = '';
let logs: string[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-gen-'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const run = async (argv: string[]): Promise<{ code: number; text: string }> => {
  const code = await main(argv, tmp);
  return { code, text: logs.join('\n') };
};
const files = (dir: string): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]));

describe('generate', () => {
  it('writes 20 files, README.txt and .gitignore, and is repeatable', async () => {
    const out = path.join(tmp, 'out');
    const r = await run([INPUT, '--tcas-file', TCAS_ARG, '--out', out]);
    expect(r.code, r.text).toBe(0);
    const xlsx = fs.readdirSync(out).filter((f) => f.endsWith('.xlsx')).sort();
    expect(xlsx).toHaveLength(20);
    expect(xlsx[0]).toBe(`01-${UPLOAD_ORDER[0]}.xlsx`);
    expect(xlsx[19]).toBe(`20-${UPLOAD_ORDER[19]}.xlsx`);
    expect(fs.existsSync(path.join(out, 'README.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(out, '.gitignore'), 'utf-8').trim()).toBe('*');
    expect(r.text).toContain('วิศวกรรมวัสดุ');
    expect(r.text).toContain('TCAS course code');
    const first = files(out);
    expect((await run([INPUT, '--tcas-file', TCAS_ARG, '--out', out])).code).toBe(0);
    expect(files(out)).toEqual(first);
  }, 120_000);

  it('copies a --tcas-file into the cache under the download name, then runs offline', async () => {
    const out = path.join(tmp, 'out');
    await run([INPUT, '--tcas-file', TCAS_ARG, '--out', out]);
    const f = TCAS_FILES.find((x) => x.entryYearBE === 2567 && x.round === '3')!;
    expect(fs.existsSync(path.join(out, '.cache', path.basename(new URL(f.url).pathname)))).toBe(true);
    const r = await run([INPUT, '--offline', '--out', out]);
    expect(r.code, r.text).toBe(0);
  }, 120_000);

  it('bachelor Thai names are byte-identical to a TCAS cell', async () => {
    const rows = ownRows(await loadRows('/x', { offline: true, files: [{ path: FIXTURE, entryYearBE: 2567, round: '3' }] }), loadInputs(INPUT).university);
    const raw = new Set(rows.filter((r) => r.programme.includes('วิศวกรรมวัสดุ')).map((r) => r.programme));
    const out = path.join(tmp, 'out');
    expect((await run([INPUT, '--tcas-file', TCAS_ARG, '--out', out])).code).toBe(0);
    const wb = XLSX.read(fs.readFileSync(path.join(out, '03-programmes.xlsx')), { type: 'buffer' });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1 });
    const names = new Set(grid.slice(1).map((r) => r[1]));
    expect([...raw].some((n) => names.has(n))).toBe(true);
  });

  it('offline without a cache is an input error', async () => {
    const r = await run([INPUT, '--offline', '--out', path.join(tmp, 'o')]);
    expect(r.code).toBe(2);
    expect(r.text).toContain('--offline');
    expect(fs.existsSync(path.join(tmp, 'o', '03-programmes.xlsx'))).toBe(false);
  });

  it('bad input and bad flags exit 2', async () => {
    let r = await run([path.join(tmp, 'missing.json'), '--out', tmp]);
    expect(r.code).toBe(2);
    expect(r.text).toContain('not found');
    r = await run([INPUT, '--tcas-file', 'nocolons.xlsx', '--out', tmp]);
    expect(r.code).toBe(2);
    expect((await run([INPUT, '--size', 'huge'])).code).toBe(2);
    expect((await run([INPUT, '--nonsense'])).code).toBe(2);
    expect((await run([])).code).toBe(2);
  });

  it('a corrupt TCAS file is an input error naming the file', async () => {
    const bad = path.join(tmp, 'bad.xlsx');
    fs.writeFileSync(bad, 'not a spreadsheet');
    const r = await run([INPUT, '--tcas-file', `${bad}:2567:3`, '--out', path.join(tmp, 'o')]);
    expect(r.code).toBe(2);
    expect(r.text).toContain('bad.xlsx');
    expect(fs.existsSync(path.join(tmp, 'o', 'README.txt'))).toBe(false);
  });

  it('README.txt names the pages, connectors and commands', async () => {
    const out = path.join(tmp, 'out');
    await run([INPUT, '--tcas-file', TCAS_ARG, '--out', out]);
    const t = fs.readFileSync(path.join(out, 'README.txt'), 'utf-8');
    for (const s of ['มหาวิทยาลัยเทคโนโลยีพระจอมเกล้าธนบุรี', 'Region: Central', 'University Rankings', 'un-wpp', 'openalex-works',
      'Start over', sheetInfo('program-faculty').title, '/admin/data-setup', '/admin/organization', '/admin/data-sources', 'Upload filled template'])
      expect(t).toContain(s);
    expect(t).toContain('pnpm skills:normalise --source=labour_market --auto-promote');
    expect(t).not.toMatch(/python|\.toml/i);
    expect(t).toContain(`from ${sheetInfo(UPLOAD_ORDER[19]!).title} (20) back to ${sheetInfo(UPLOAD_ORDER[0]!).title} (1)`);
  });
});

const KMUTT = 'มหาวิทยาลัยเทคโนโลยีพระจอมเกล้าธนบุรี';
let inputCount = 0;
function inputFile(programmes: unknown[]): string {
  const f = path.join(tmp, `in-${++inputCount}.json`);
  fs.writeFileSync(f, JSON.stringify({ university: KMUTT, region: 'Central', programmes }));
  return f;
}
function validNationalId(): string {
  const d = [1, 1, 0, 1, 7, 0, 0, 2, 3, 0, 6, 7];
  const sum = d.reduce((a, x, i) => a + x * (13 - i), 0);
  return `${d.join('')}${(11 - (sum % 11)) % 10}`;
}

describe('failure handling', () => {
  it('a failing early sheet is reported as exit 2 with every cause, writing nothing', async () => {
    const out = path.join(tmp, 'o');
    const input = inputFile([{ name: 'วิศวกรรมวัสดุ', faculty: 'คณะวิศวกรรมศาสตร์', name_en: validNationalId() }]);
    const r = await run([input, '--tcas-file', TCAS_ARG, '--out', out]);
    expect(r.code, r.text).toBe(2);
    expect(r.text).toContain('Nothing was written');
    expect(r.text).toContain('programmes');
    expect(r.text).not.toMatch(/no reference values|\n\s+at /);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('two entries resolving to the same TCAS programme are refused, naming both', async () => {
    const out = path.join(tmp, 'o');
    const r = await run([inputFile([{ name: 'วิศวกรรมวัสดุ', faculty: 'คณะวิศวกรรมศาสตร์' }, { name: 'วิศวกรรมวัสดุ', faculty: 'คณะวิศวกรรมศาสตร์' }]), '--tcas-file', TCAS_ARG, '--out', out]);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/#1.*#2.*same TCAS programme/s);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('two identical postgraduate entries are refused', async () => {
    const e = { name: 'วิศวกรรมวัสดุ', level: 'MASTER', faculty: 'คณะวิศวกรรมศาสตร์' };
    const r = await run([inputFile([e, { ...e }]), '--tcas-file', TCAS_ARG, '--out', path.join(tmp, 'o')]);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/#1.*#2.*same MASTER programme/s);
  });
});

describe('TCAS file sets', () => {
  it('a --tcas-file run records its files and a later --offline run uses exactly those', async () => {
    const out = path.join(tmp, 'out');
    expect((await run([INPUT, '--tcas-file', TCAS_ARG, '--out', out])).code).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, '.cache', 'tcas-files.json'), 'utf-8')) as Array<{ entryYearBE: number }>;
    expect(manifest.map((m) => m.entryYearBE)).toEqual([2567]);
    // an extra, unrelated cached file must not be read by the offline run
    fs.copyFileSync(FIXTURE, path.join(out, '.cache', path.basename(new URL(TCAS_FILES[0]!.url).pathname)));
    logs = [];
    const r = await run([INPUT, '--offline', '--out', out]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain('recorded by an earlier --tcas-file run');
    expect(r.text).toContain('TCAS years loaded: 2567/3');
  }, 120_000);

  it('prints the TCAS years it loaded', async () => {
    const r = await run([INPUT, '--tcas-file', TCAS_ARG, '--out', path.join(tmp, 'o')]);
    expect(r.text).toContain('TCAS years loaded: 2567/3');
  });
});

describe('writer', () => {
  it('refuses control characters, naming dataset, row and column', () => {
    const h = sheetInfo('faculties').headers;
    const row = Object.fromEntries(h.map((k) => [k, 'x']));
    row[h[1]!] = 'bad\x01name';
    expect(() => assertCellsClean('faculties', [row])).toThrow(/faculties.*row 2.*Name/);
    expect(() => datasetBytes('faculties', [row])).toThrow(/control character/);
  });

  it('keeps text cells as text, even when they look like formulas or numbers', () => {
    const h = sheetInfo('faculties').headers;
    const row = Object.fromEntries(h.map((k) => [k, '=1+1']));
    row[h[0]!] = '007';
    const wb = XLSX.read(datasetBytes('faculties', [row]), { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]!]!;
    expect(ws['A2']!.t).toBe('s');
    expect(ws['A2']!.v).toBe('007');
    expect(ws['B2']!.f).toBeUndefined();
  });
});

describe('determinism across processes', () => {
  it('two runs more than a second apart give identical bytes', () => {
    const outs: Array<Record<string, string>> = [];
    for (const n of ['a', 'b']) {
      if (outs.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
      const out = path.join(tmp, n);
      const r = spawnSync(process.execPath, [path.join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs'), GENERATE, INPUT, '--tcas-file', TCAS_ARG, '--out', out], {
        encoding: 'utf-8', env: { ...process.env, INIT_CWD: tmp },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      outs.push(files(out));
    }
    expect(Object.keys(outs[0]!)).toEqual(Object.keys(outs[1]!));
    for (const k of Object.keys(outs[0]!)) expect(outs[0]![k], k).toBe(outs[1]![k]);
  }, 180_000);
});

describe('generate --no-tcas', () => {
  const freeInput = (): string => {
    const file = path.join(tmp, 'free.json');
    fs.copyFileSync(path.join(FIX, 'curriculum-sample.pdf'), path.join(tmp, 'curriculum-sample.pdf'));
    fs.writeFileSync(
      file,
      JSON.stringify({
        university: 'สถาบันสมมุติที่ไม่ใช้ TCAS',
        region: 'Northeast',
        programmes: [
          { name: 'วิศวกรรมวัสดุ', faculty: 'คณะวิศวกรรมศาสตร์', pdf: 'curriculum-sample.pdf' },
          { name: 'เคมี', faculty: 'คณะวิทยาศาสตร์', level: 'MASTER' },
        ],
      }),
    );
    return file;
  };

  it('writes every file without reading or downloading TCAS, and says so in README.txt', async () => {
    const out = path.join(tmp, 'out');
    // --offline on top: any attempt to read TCAS would fail the run
    const r = await run([freeInput(), '--no-tcas', '--offline', '--out', out]);
    expect(r.code, r.text).toBe(0);
    expect(fs.readdirSync(out).filter((f) => f.endsWith('.xlsx'))).toHaveLength(UPLOAD_ORDER.length);
    expect(r.text).toContain('TCAS-free run');
    expect(r.text).not.toContain('TCAS years loaded');
    const readme = fs.readFileSync(path.join(out, 'README.txt'), 'utf-8');
    expect(readme).toContain('TCAS-FREE RUN (--no-tcas)');
    expect(readme).toMatch(/tcas +do NOT run/);
    expect(readme).toContain('สถาบันสมมุติที่ไม่ใช้ TCAS');
    const wb = XLSX.read(fs.readFileSync(path.join(out, '03-programmes.xlsx')), { type: 'buffer' });
    const names = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]!]!).map((x) => x['Name (Thai)']);
    expect(names).toEqual(expect.arrayContaining(['วิศวกรรมวัสดุ', 'วิศวกรรมวัสดุ (หลักสูตรนานาชาติ)', 'เคมี', 'เคมี (แผน ข)']));
    const first = files(out);
    expect((await run([freeInput(), '--no-tcas', '--out', out])).code).toBe(0);
    expect(files(out)).toEqual(first);
  }, 120_000);

  it('refuses --no-tcas with --tcas-file', async () => {
    const r = await run([freeInput(), '--no-tcas', '--tcas-file', TCAS_ARG, '--out', path.join(tmp, 'out')]);
    expect(r.code).toBe(2);
    expect(r.text).toContain('--no-tcas and --tcas-file cannot be used together');
  });

  it('a university missing from TCAS is pointed to --no-tcas', async () => {
    const r = await run([freeInput(), '--tcas-file', TCAS_ARG, '--out', path.join(tmp, 'out')]);
    expect(r.code).toBe(2);
    expect(r.text).toContain('is not in the TCAS files');
    expect(r.text).toContain('run again with --no-tcas');
  });
});
