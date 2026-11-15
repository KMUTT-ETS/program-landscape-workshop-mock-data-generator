// Refreshes src/vendor/ from a Program Landscape checkout.
//
//   pnpm sync-vendor [path/to/program-landscape]   (default: ../program-landscape)
//
// The generator checks every sheet with the app's own importer validator and
// matches programmes with the app's TCAS matcher. Those live in the app's
// monorepo, so this repository carries a snapshot of them in src/vendor/.
// Never edit src/vendor/ by hand: re-run this script after the app's import
// declarations change, then run `pnpm check`.
//
// What it does:
//   1. Loads packages/db/src and packages/shared/src from the checkout.
//   2. Strips everything database-side from the import declarations: the
//      loader members of `ImportDataset` (load, count, clear, prefill, ...)
//      and the Prisma types they need. Column specs, row rules, strategies and
//      the validator are kept verbatim.
//   3. Removes what became unused and writes only the files reachable from the
//      names the generator imports, plus two app files (TCAS file list, PDF
//      text extractor).

import fs from 'node:fs';
import path from 'node:path';
import { Node, Project, type ObjectLiteralExpression, type SourceFile } from 'ts-morph';

const LOADER_MEMBERS = new Set(['load', 'count', 'countForTerm', 'countForScope', 'clear', 'cascadeBlockers']);
// validateSheet reads `dataset.prefill !== undefined` (a pre-filled template's
// key-only rows are skipped, not refused), so `prefill` survives as a marker.
const MARKER_MEMBERS = new Set(['prefill']);
const DROPPED_TYPES = ['ImportLoadContext', 'ImportLoadResult', 'PrefillOptions'];

const repoRoot = path.resolve(__dirname, '..');
const appRoot = path.resolve(process.argv[2] ?? path.join(repoRoot, '..', 'program-landscape'));
const vendorDir = path.join(repoRoot, 'src', 'vendor');
const dbSrc = path.join(appRoot, 'packages', 'db', 'src');
const sharedSrc = path.join(appRoot, 'packages', 'shared', 'src');

if (!fs.existsSync(path.join(dbSrc, 'import', 'registry.ts'))) {
  console.error(`Not a Program Landscape checkout: ${appRoot}`);
  process.exit(2);
}

// ── names the generator and its tests import from the vendor indexes ────────
function importedNames(index: 'db' | 'shared'): string[] {
  const names = new Set<string>();
  const re = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+'[./]*(?:src/)?vendor/${index}'`, 'g');
  for (const dir of ['src', 'test']) {
    for (const f of fs.readdirSync(path.join(repoRoot, dir))) {
      if (!f.endsWith('.ts')) continue;
      const text = fs.readFileSync(path.join(repoRoot, dir, f), 'utf8');
      for (const m of text.matchAll(re)) {
        for (const part of (m[2] ?? '').split(',')) {
          const name = part.replace(/^\s*type\s+/, '').trim().split(/\s+as\s+/)[0] ?? '';
          if (name) names.add(name);
        }
      }
    }
  }
  return [...names].sort();
}

const project = new Project({
  compilerOptions: { strict: true, target: 99, module: 1, moduleResolution: 2, skipLibCheck: true },
  skipAddingFilesFromTsConfig: true,
});
const posix = (p: string) => p.split(path.sep).join('/');
project.addSourceFilesAtPaths([
  posix(path.join(dbSrc, '**', '*.ts')),
  posix(path.join(sharedSrc, '**', '*.ts')),
  '!**/*.test.ts',
  '!**/*.spec.ts',
]);

// Imports of the shared package from inside db become relative paths to a
// generated index (written in step 3); give the program a provisional one so
// the language service can resolve them while removing unused code.
const sharedIndexPath = path.join(sharedSrc, '__vendor_index.ts');
function rewriteSharedImports(sf: SourceFile) {
  for (const decl of sf.getImportDeclarations()) {
    if (decl.getModuleSpecifierValue() !== '@kku/shared') continue;
    let rel = posix(path.relative(path.dirname(sf.getFilePath()), sharedIndexPath)).replace(/\.ts$/, '');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    decl.setModuleSpecifier(rel);
  }
}

// Locate the file that exports `name` under packages/<pkg>/src.
function definingFile(root: string, name: string): SourceFile {
  const decl = new RegExp(
    `export\\s+(declare\\s+)?(abstract\\s+)?(const|let|function|async function|class|interface|type|enum)\\s+${name}\\b`,
  );
  const hits = project
    .getSourceFiles()
    .filter((sf) => sf.getFilePath().startsWith(posix(root)) && !sf.getFilePath().includes('__vendor_index'))
    .filter((sf) => decl.test(sf.getFullText()));
  if (hits.length !== 1) {
    throw new Error(`Expected one file exporting ${name} under ${root}, found ${hits.length}`);
  }
  return hits[0] as SourceFile;
}

function indexText(from: string, names: string[], root: string): string {
  const byFile = new Map<SourceFile, string[]>();
  for (const n of names) {
    const sf = definingFile(root, n);
    byFile.set(sf, [...(byFile.get(sf) ?? []), n]);
  }
  const lines = [...byFile]
    .map(([sf, ns]) => {
      let rel = posix(path.relative(from, sf.getFilePath())).replace(/\.ts$/, '');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      const isType = (n: string) => sf.getInterface(n) !== undefined || sf.getTypeAlias(n) !== undefined;
      const types = ns.filter(isType).sort();
      const values = ns.filter((n) => !isType(n)).sort();
      return [
        values.length ? `export { ${values.join(', ')} } from '${rel}';` : '',
        types.length ? `export type { ${types.join(', ')} } from '${rel}';` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .sort();
  return `${HEADER}\n${lines.join('\n')}\n`;
}

// PdfPageText lives in a large shared file that pulls in zod and the AI types;
// inline the one interface the PDF extractor needs instead.
function pdfPageTextDecl(): string {
  const sf = project.getSourceFileOrThrow(path.join(sharedSrc, 'pdf-intake', 'types.ts'));
  return sf.getInterfaceOrThrow('PdfPageText').getText();
}

const HEADER =
  `// GENERATED by scripts/sync-vendor.ts from a Program Landscape checkout. Do not edit.\n` +
  `// Refresh with \`pnpm sync-vendor <path/to/program-landscape>\`.\n`;

// ── step 1: strip the database side of the import declarations ──────────────
const shared = importedNames('shared');
const db = importedNames('db');

// Shared names the db side needs are added after stripping (see step 2).
project.createSourceFile(sharedIndexPath, '', { overwrite: true });

const importDir = posix(path.join(dbSrc, 'import'));
for (const sf of project.getSourceFiles()) {
  if (!sf.getFilePath().startsWith(posix(dbSrc))) continue;
  rewriteSharedImports(sf);
  if (!sf.getFilePath().startsWith(importDir)) continue;
  sf.forEachDescendant((node) => {
    if (!Node.isObjectLiteralExpression(node)) return;
    stripLoaderMembers(node);
  });
}

function stripLoaderMembers(obj: ObjectLiteralExpression) {
  for (const prop of obj.getProperties()) {
    const name =
      Node.isPropertyAssignment(prop) ||
      Node.isMethodDeclaration(prop) ||
      Node.isShorthandPropertyAssignment(prop)
        ? prop.getName()
        : null;
    if (name && LOADER_MEMBERS.has(name)) prop.remove();
    else if (name && MARKER_MEMBERS.has(name)) prop.replaceWithText(`${name}: true`);
  }
}

const typesFile = project.getSourceFileOrThrow(path.join(dbSrc, 'import', 'types.ts'));
const datasetIface = typesFile.getInterfaceOrThrow('ImportDataset');
for (const m of datasetIface.getMembers()) {
  if (Node.isPropertySignature(m) || Node.isMethodSignature(m)) {
    if (LOADER_MEMBERS.has(m.getName())) m.remove();
    else if (MARKER_MEMBERS.has(m.getName())) {
      m.replaceWithText(`/** The app's template pre-fills rows (its loader is not vendored). */\n  ${m.getName()}?: true;`);
    }
  }
}
for (const t of DROPPED_TYPES) typesFile.getInterface(t)?.remove();
typesFile.getImportDeclarations().forEach((d) => {
  if (d.getModuleSpecifierValue() === '@prisma/client') d.remove();
});

// ── step 2: collect reachable files, removing unused code until stable ──────
function sharedNamesUsedByDb(files: SourceFile[]): string[] {
  const names = new Set<string>();
  for (const sf of files) {
    for (const decl of sf.getImportDeclarations()) {
      if (!decl.getModuleSpecifierValue().endsWith('__vendor_index')) continue;
      for (const n of decl.getNamedImports()) names.add(n.getName());
    }
  }
  return [...names];
}

function reachable(entries: SourceFile[]): SourceFile[] {
  const seen = new Set<SourceFile>();
  const stack = [...entries];
  while (stack.length) {
    const sf = stack.pop() as SourceFile;
    if (seen.has(sf)) continue;
    seen.add(sf);
    for (const d of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
      const spec = d.getModuleSpecifierValue();
      if (!spec || !spec.startsWith('.')) continue;
      const target = d.getModuleSpecifierSourceFile();
      if (!target) throw new Error(`${sf.getFilePath()}: cannot resolve '${spec}'`);
      stack.push(target);
    }
  }
  return [...seen];
}

// An export no other vendored file (or index) uses is only API surface of the
// app; un-export it so fixUnusedIdentifiers can drop it if the file itself
// does not use it either.
function unexportUnreferenced(sf: SourceFile, inSet: Set<string>) {
  const decls = [
    ...sf.getFunctions(),
    ...sf.getInterfaces(),
    ...sf.getTypeAliases(),
    ...sf.getClasses(),
    ...sf.getEnums(),
    ...sf.getVariableStatements(),
  ];
  for (const d of decls) {
    if (!d.isExported()) continue;
    const nameNodes = Node.isVariableStatement(d)
      ? d.getDeclarations().map((v) => v.getNameNode())
      : [d.getNameNode()];
    const usedElsewhere = nameNodes.some((n) => {
      if (!n || !Node.isIdentifier(n)) return true;
      return n
        .findReferencesAsNodes()
        .some((r) => r.getSourceFile() !== sf && inSet.has(r.getSourceFile().getFilePath()));
    });
    if (!usedElsewhere) d.setIsExported(false);
  }
}

const dbIndexPath = path.join(dbSrc, '__vendor_db_index.ts');
let files: SourceFile[] = [];
for (let pass = 0; pass < 10; pass += 1) {
  // Settle the indexes first: every shared name a reachable db file imports
  // must be re-exported before anything is judged unreferenced.
  const dbIndex = project.createSourceFile(dbIndexPath, indexText(path.dirname(dbIndexPath), db, dbSrc), {
    overwrite: true,
  });
  let sharedNeeded = [...new Set([...shared, ...sharedNamesUsedByDb(files)])].sort();
  let next: SourceFile[] = [];
  for (;;) {
    project.createSourceFile(sharedIndexPath, indexText(path.dirname(sharedIndexPath), sharedNeeded, sharedSrc), {
      overwrite: true,
    });
    next = reachable([dbIndex, project.getSourceFileOrThrow(sharedIndexPath)]);
    const wanted = [...new Set([...sharedNeeded, ...sharedNamesUsedByDb(next)])].sort();
    if (wanted.length === sharedNeeded.length) break;
    sharedNeeded = wanted;
  }
  const before = next.map((sf) => sf.getFullText()).join('\0');
  const inSet = new Set(next.map((sf) => sf.getFilePath()));
  for (const sf of next) {
    if (sf === dbIndex || sf.getFilePath() === posix(sharedIndexPath)) continue;
    unexportUnreferenced(sf, inSet);
    sf.fixUnusedIdentifiers();
    sf.organizeImports();
  }
  const after = next.map((sf) => sf.getFullText()).join('\0');
  const stable = before === after && next.length === files.length;
  files = next;
  if (stable) break;
}

// A Prisma enum still named by validation code (a column's allowed values)
// becomes a string-union type read from schema.prisma. Any other Prisma or
// package import left means a loader escaped the strip: fail loudly.
const schemaText = fs.readFileSync(path.join(appRoot, 'packages', 'db', 'prisma', 'schema.prisma'), 'utf8');
function prismaEnum(name: string): string[] | null {
  const m = new RegExp(`^enum\\s+${name}\\s*\\{([^}]*)\\}`, 'm').exec(schemaText);
  if (!m) return null;
  return (m[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l && !l.startsWith('@@'))
    .map((l) => l.split(/\s+/)[0] ?? '');
}
const enumsPath = path.join(dbSrc, '__prisma_enums.ts');
const enums = new Map<string, string[]>();
for (const sf of files) {
  for (const d of sf.getImportDeclarations()) {
    const spec = d.getModuleSpecifierValue();
    if (spec.startsWith('.')) continue;
    if (spec !== '@prisma/client') {
      throw new Error(`${sf.getFilePath()}: unexpected package import '${spec}' after stripping`);
    }
    for (const n of d.getNamedImports()) {
      const values = prismaEnum(n.getName());
      if (!values) throw new Error(`${sf.getFilePath()}: Prisma import '${n.getName()}' is not an enum; loader code escaped the strip`);
      enums.set(n.getName(), values);
    }
    d.setModuleSpecifier('./__prisma_enums_placeholder');
  }
}
if (enums.size) {
  const body = [...enums]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, vs]) => `export type ${n} = ${vs.map((v) => `'${v}'`).join(' | ')};`)
    .join('\n');
  files.push(project.createSourceFile(enumsPath, `// Prisma enums from packages/db/prisma/schema.prisma.\n${body}\n`, { overwrite: true }));
}

// ── step 3: write src/vendor ────────────────────────────────────────────────
fs.rmSync(vendorDir, { recursive: true, force: true });
function out(sf: SourceFile): string {
  const p = sf.getFilePath();
  if (p === posix(sharedIndexPath)) return path.join(vendorDir, 'shared', 'index.ts');
  if (p === posix(dbIndexPath)) return path.join(vendorDir, 'db', 'index.ts');
  if (p === posix(enumsPath)) return path.join(vendorDir, 'db', 'prisma-enums.ts');
  if (p.startsWith(posix(dbSrc))) return path.join(vendorDir, 'db', path.relative(dbSrc, p));
  return path.join(vendorDir, 'shared', path.relative(sharedSrc, p));
}
function relSpec(from: string, to: string): string {
  let rel = posix(path.relative(path.dirname(from), to)).replace(/\.ts$/, '').replace(/\/index$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}
for (const sf of files) {
  // Re-point every relative import at its target's place in src/vendor.
  for (const d of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
    const spec = d.getModuleSpecifierValue();
    if (!spec || !spec.startsWith('.')) continue;
    const target =
      spec === './__prisma_enums_placeholder' ? enumsPath : d.getModuleSpecifierSourceFileOrThrow().getFilePath();
    d.setModuleSpecifier(relSpec(out(sf), out({ getFilePath: () => posix(target) } as SourceFile)));
  }
  const isIndex = sf.getFilePath() === posix(sharedIndexPath) || sf.getFilePath() === posix(dbIndexPath);
  const text = isIndex ? sf.getFullText() : HEADER + '\n' + sf.getFullText();
  const dest = out(sf);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}

// Two app files the generator uses directly.
const tcasFiles = fs.readFileSync(
  path.join(appRoot, 'apps', 'ingestion', 'src', 'connectors', 'sources', 'tcas', 'files.ts'),
  'utf8',
);
fs.writeFileSync(path.join(vendorDir, 'tcas-files.ts'), HEADER + '\n' + tcasFiles);

const extractor = fs
  .readFileSync(path.join(appRoot, 'apps', 'ingestion', 'src', 'pdf-intake', 'pipeline', 'native-text-extractor.ts'), 'utf8')
  .replace("import type { PdfPageText } from '@kku/shared';", pdfPageTextDecl());
if (extractor.includes('@kku/')) throw new Error('native-text-extractor.ts has a new @kku/ import; update sync-vendor.ts');
fs.writeFileSync(path.join(vendorDir, 'native-text-extractor.ts'), HEADER + '\n' + extractor);

const commit = (() => {
  try {
    const head = fs.readFileSync(path.join(appRoot, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    const loose = path.join(appRoot, '.git', ref);
    if (fs.existsSync(loose)) return `${fs.readFileSync(loose, 'utf8').trim()} (${ref})`;
    return ref;
  } catch {
    return 'unknown';
  }
})();
fs.writeFileSync(
  path.join(vendorDir, 'SOURCE.md'),
  `# Vendored from Program Landscape\n\nGenerated by \`scripts/sync-vendor.ts\`. Do not edit these files.\n\n` +
    `- Source commit: \`${commit}\`\n- Files: ${files.length + 2}\n`,
);

console.log(`Wrote ${files.length + 2} files to ${path.relative(repoRoot, vendorDir)} (db: ${db.join(', ')}; shared: ${shared.join(', ')})`);
