// What each generated sheet must look like: its file order, sheet name, title and columns.
//
// Without --templates every sheet follows the snapshot of the app's import declarations in
// src/vendor (the built-in spec). With --templates the app's own template wins: the generator's
// rows are fitted to the template's columns by header, so a template that gained an optional
// column, lost one, reordered them or renamed a sheet still gets a file the importer accepts.
//
// Validation runs on an "effective" declaration built from the template. A template column that
// matches a built-in column (same header, same type) keeps the built-in's finer rules (cell checks,
// references, k-anonymity, duplicate-key identity); a new or retyped column is checked for what
// the template states: required, type and allowed values. Row rules and the load strategy are kept
// only while every built-in column they could read is still there.
import type { ImportColumn, ImportDataset, ImportStrategy } from './vendor/db';
import { getImportDataset } from './vendor/db';
import { MOCK_DATASETS, UPLOAD_ORDER } from './datasets';
import { InputError } from './inputs';
import type { Row } from './datasets';
import type { TemplateInfo } from './templates';

export interface SheetSpec {
  slug: string;
  title: string;
  sheetName: string;
  /** The declaration the sheet is validated against. */
  dataset: ImportDataset;
  /** Header in the sheet -> header the generator's builder fills it from (null: no builder column). */
  source: ReadonlyMap<string, string | null>;
  /** Value written into a column with no builder column (the template's example, or blank). */
  fill: ReadonlyMap<string, string | null>;
  /** The template file, when the spec came from one. */
  template: string | null;
}

export interface SheetPlan {
  /** Slugs in file order (file 01 first). */
  order: string[];
  specs: Map<string, SheetSpec>;
}

/** Header comparison that survives a change of case, spacing or punctuation. */
const loose = (h: string): string => h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function builtInSpec(slug: string): SheetSpec {
  const dataset = getImportDataset(slug);
  const headers = dataset.columns.map((c) => c.header);
  return {
    slug,
    title: dataset.title,
    sheetName: dataset.sheetName,
    dataset,
    source: new Map(headers.map((h) => [h, h])),
    fill: new Map(),
    template: null,
  };
}

function strategyKeys(s: ImportStrategy): string[] {
  const keys = [...s.match.columns, ...(s.match.kind === 'manual' ? (s.match.fallback ?? []) : [])];
  if (s.kind === 'term-scoped') keys.push(...s.termColumns);
  if (s.kind === 'programme-scoped') keys.push(...s.scopeColumns);
  return keys;
}

/** The effective spec for one template, with a note for every difference from the built-in. */
export function specFromTemplate(t: TemplateInfo, notes: string[]): SheetSpec {
  const base = getImportDataset(t.slug);
  const say = (msg: string): void => {
    notes.push(`template ${t.slug}: ${msg}`);
  };
  const exact = new Map(base.columns.map((c) => [c.header, c]));
  const fuzzy = new Map(base.columns.map((c) => [loose(c.header), c]));
  const used = new Set<ImportColumn>();
  const source = new Map<string, string | null>();
  const fill = new Map<string, string | null>();

  const columns: ImportColumn[] = t.columns.map((tc) => {
    let b = exact.get(tc.header);
    if (!b) {
      b = fuzzy.get(loose(tc.header));
      if (b && !used.has(b)) say(`column '${b.header}' is now '${tc.header}'; filled from the old column`);
      else b = undefined;
    }
    if (b && used.has(b)) b = undefined;
    const type = tc.type ?? b?.type ?? 'text';
    const required = tc.required ?? b?.required ?? false;
    const enumValues = tc.enumValues ?? (type === 'enum' ? (b?.enumValues ?? []) : undefined);
    if (b) {
      used.add(b);
      source.set(tc.header, b.header);
      if (type !== b.type) {
        say(`column '${tc.header}' changed type from ${b.type} to ${type}; only the template's type is checked`);
        return { header: tc.header, key: b.key, type, required, enumValues, guide: '', example: tc.example };
      }
      if (required && !b.required) say(`column '${tc.header}' is now required`);
      // keep the importer's own rules for the column
      return { ...b, header: tc.header, required, ...(enumValues ? { enumValues } : {}) };
    }
    source.set(tc.header, null);
    if (required) {
      if (!tc.example) {
        throw new InputError(
          `${t.file}: required column '${tc.header}' is new and the template gives no example to fill it with. ` +
            'This generator needs an update for it (src/datasets.ts), or run without --templates.',
        );
      }
      fill.set(tc.header, tc.example);
      say(`new required column '${tc.header}' filled with the template's example '${tc.example}' on every row`);
    } else {
      fill.set(tc.header, null);
      say(`new optional column '${tc.header}' left blank`);
    }
    return { header: tc.header, key: `template:${tc.header}`, type, required, enumValues, guide: '', example: tc.example };
  });

  const dropped = base.columns.filter((c) => !used.has(c));
  for (const c of dropped) say(`column '${c.header}' is not in the template; not written`);
  const keys = new Set(columns.map((c) => c.key));

  let strategy: ImportStrategy = base.strategy;
  if (!strategyKeys(base.strategy).every((k) => keys.has(k))) {
    const byHeader = new Map(columns.map((c) => [c.header, c.key]));
    const matchKeys = t.matchHeaders.map((h) => byHeader.get(h)).filter((k): k is string => k !== undefined);
    const match = matchKeys.length > 0 ? matchKeys : columns.map((c) => c.key);
    strategy = { kind: 'upsert', match: { kind: 'manual', columns: match } };
    say(`its match key changed; duplicate rows are checked on ${match.join(' + ')}`);
  }
  const rowRules = dropped.length === 0 ? base.rowRules : undefined;
  if (dropped.length > 0 && base.rowRules?.length) {
    say(`${base.rowRules.length} cross-column rule(s) not checked, since columns changed`);
  }
  if (t.sheetName !== base.sheetName) say(`data sheet is now named '${t.sheetName}'`);

  const dataset: ImportDataset = {
    ...base,
    title: t.title ?? base.title,
    sheetName: t.sheetName,
    columns,
    strategy,
    rowRules,
  };
  return { slug: t.slug, title: dataset.title, sheetName: t.sheetName, dataset, source, fill, template: t.file };
}

/** File order and specs: built-in only, or fitted to a folder of templates. */
export function planSheets(templates: ReadonlyMap<string, TemplateInfo> | null, notes: string[]): SheetPlan {
  if (!templates) return { order: [...UPLOAD_ORDER], specs: new Map(UPLOAD_ORDER.map((s) => [s, builtInSpec(s)])) };

  const specs = new Map<string, SheetSpec>();
  const missing: string[] = [];
  for (const slug of UPLOAD_ORDER) {
    const t = templates.get(slug);
    if (t) specs.set(slug, specFromTemplate(t, notes));
    else {
      missing.push(slug);
      specs.set(slug, builtInSpec(slug));
    }
  }
  if (missing.length > 0) {
    notes.push(`no template for ${missing.join(', ')}; used the built-in columns for those`);
  }
  for (const [slug, t] of templates) {
    if (MOCK_DATASETS.has(slug)) continue;
    let known = true;
    try {
      getImportDataset(slug);
    } catch {
      known = false;
    }
    if (!known) notes.push(`template ${slug}: a dataset this generator does not know; no file written (${t.file})`);
  }

  // Template numbers decide the order once every sheet has one; otherwise keep the built-in order.
  const numbered = UPLOAD_ORDER.every((s) => templates.get(s)?.index != null);
  const order = numbered
    ? [...UPLOAD_ORDER].sort((a, b) => (templates.get(a)?.index ?? 0) - (templates.get(b)?.index ?? 0))
    : [...UPLOAD_ORDER];
  if (numbered && order.some((s, i) => s !== UPLOAD_ORDER[i])) {
    notes.push(`upload order follows the template numbers: ${order.join(', ')}`);
  }
  return { order, specs };
}

/** Rows keyed by the builder's headers -> rows keyed by the sheet's headers. */
export function conformRows(spec: SheetSpec, rows: readonly Row[]): Row[] {
  const headers = spec.dataset.columns.map((c) => c.header);
  return rows.map((r) =>
    Object.fromEntries(
      headers.map((h) => {
        const from = spec.source.get(h);
        return [h, from ? (r[from] ?? null) : (spec.fill.get(h) ?? null)];
      }),
    ),
  );
}
