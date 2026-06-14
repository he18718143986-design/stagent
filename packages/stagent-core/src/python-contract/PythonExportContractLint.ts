import * as fs from 'fs';
import * as path from 'path';

export type PythonExportContractIssueCode = 'python-test-import-symbol-missing';

export interface PythonExportContractIssue {
  code: PythonExportContractIssueCode;
  message: string;
  module: string;
  symbol: string;
  testFile: string;
  implFile?: string;
}

const FROM_IMPORT_RE = /^\s*from\s+([a-zA-Z_][\w.]*)\s+import\s+([^\n#]+)/gm;
const TOP_LEVEL_FROM_IMPORT_RE = /^from\s+([a-zA-Z_][\w.]*)\s+import\s+([^\n#]+)/gm;
/** 模块顶层 class（行首无缩进）— 与 `from mod import name` 可 import 表面对齐 */
const MODULE_CLASS_DEF_RE = /^class\s+([A-Za-z_]\w*)/gm;
/** 模块顶层 def（行首无缩进）；嵌套 helper 不计入 export 表面 */
const MODULE_DEF_RE = /^def\s+([A-Za-z_]\w*)/gm;
const ALL_RE = /__all__\s*=\s*\[([^\]]+)\]/;

function parsePythonFromImportsWithRegex(
  content: string,
  fromImportRe: RegExp,
): Array<{ module: string; names: string[] }> {
  const results: Array<{ module: string; names: string[] }> = [];
  fromImportRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = fromImportRe.exec(content)) !== null) {
    const mod = m[1]!;
    if (mod.startsWith('.')) {
      continue;
    }
    const rawNames = m[2]!
      .split(',')
      .map((n) => n.trim().replace(/^\(/, '').replace(/\)$/, ''))
      .filter(Boolean)
      .map((n) => n.replace(/^as\s+\w+$/i, '').trim())
      .filter((n) => n && !/^as\b/i.test(n));
    const names: string[] = [];
    for (const part of rawNames) {
      const asSplit = part.split(/\s+as\s+/i);
      names.push((asSplit[0] ?? part).trim());
    }
    if (names.length > 0) {
      results.push({ module: mod.split('.')[0]!, names });
    }
  }
  return results;
}

export function parsePythonFromImports(content: string): Array<{ module: string; names: string[] }> {
  return parsePythonFromImportsWithRegex(content, FROM_IMPORT_RE);
}

/**
 * 模块顶层常量/变量绑定（行首无缩进，含可选类型标注 `NAME: T = ...`）。
 * 这些符号同样可被 `from module import NAME` 导入，是导出表面的一部分；
 * 仅用于「import/契约缺失」判定，不计入 export-extra（避免把内部常量误判为多余导出）。
 */
const MODULE_CONST_RE = /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm;

export function extractModuleLevelConstants(content: string): Set<string> {
  const symbols = new Set<string>();
  MODULE_CONST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MODULE_CONST_RE.exec(content)) !== null) {
    const name = m[1]!;
    if (!name.startsWith('_')) {
      symbols.add(name);
    }
  }
  return symbols;
}

/**
 * 顶层 `from X import name`（含 `as` 别名）引入的名字——这些名字可被 `from 本模块 import name`
 * 再次导入（Python re-export 语义）。集成切片 main 常 `from pipeline import import_tasks_from_csv`
 * 后对外暴露；这类 re-export 是合法导出表面，应计入「契约/import 缺失」判定。
 */
export function extractImportedNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const imp of parsePythonFromImportsWithRegex(content, TOP_LEVEL_FROM_IMPORT_RE)) {
    for (const n of imp.names) {
      if (n && n !== '*') {
        names.add(n);
      }
    }
  }
  return names;
}

export function extractExportedSymbols(content: string): Set<string> {
  const symbols = new Set<string>();
  MODULE_CLASS_DEF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MODULE_CLASS_DEF_RE.exec(content)) !== null) {
    symbols.add(m[1]!);
  }
  MODULE_DEF_RE.lastIndex = 0;
  while ((m = MODULE_DEF_RE.exec(content)) !== null) {
    if (!m[1]!.startsWith('_')) {
      symbols.add(m[1]!);
    }
  }
  const allMatch = ALL_RE.exec(content);
  if (allMatch?.[1]) {
    for (const name of allMatch[1].match(/['"]([^'"]+)['"]/g) ?? []) {
      symbols.add(name.replace(/['"]/g, ''));
    }
  }
  return symbols;
}

function resolveImplPath(workspaceRoot: string, module: string): string | undefined {
  const candidates = [
    path.join(workspaceRoot, `${module}.py`),
    path.join(workspaceRoot, module, '__init__.py'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

export function lintPythonExportContractOnDisk(params: {
  workspaceRoot: string;
  testFiles: string[];
}): PythonExportContractIssue[] {
  const { workspaceRoot, testFiles } = params;
  const issues: PythonExportContractIssue[] = [];
  const seen = new Set<string>();

  for (const rel of testFiles) {
    const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
    if (!fs.existsSync(abs)) {
      continue;
    }
    const content = fs.readFileSync(abs, 'utf8');
    for (const imp of parsePythonFromImports(content)) {
      const implPath = resolveImplPath(workspaceRoot, imp.module);
      if (!implPath) {
        continue;
      }
      const implContent = fs.readFileSync(implPath, 'utf8');
      const exported = extractExportedSymbols(implContent);
      const constants = extractModuleLevelConstants(implContent);
      const reexports = extractImportedNames(implContent);
      for (const name of imp.names) {
        if (name === '*' || exported.has(name) || constants.has(name) || reexports.has(name)) {
          continue;
        }
        const key = `${rel}:${imp.module}:${name}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        issues.push({
          code: 'python-test-import-symbol-missing',
          message: `python-export-contract：${rel} 从 ${imp.module} import ${name}，但 ${path.relative(workspaceRoot, implPath)} 未导出该符号`,
          module: imp.module,
          symbol: name,
          testFile: rel,
          implFile: path.relative(workspaceRoot, implPath).replace(/\\/g, '/'),
        });
      }
    }
  }
  return issues;
}

function moduleNameFromImplPath(implPath: string): string {
  const base = path.basename(implPath);
  if (base === '__init__.py') {
    return path.basename(path.dirname(implPath));
  }
  return base.replace(/\.py$/i, '');
}

/** 从工作流 artifact 路径静态对读（生成期弱检查）。 */
export function lintPythonExportContractFromPaths(
  pairs: Array<{ testPath: string; implPath: string }>,
  readFile: (p: string) => string,
): PythonExportContractIssue[] {
  const issues: PythonExportContractIssue[] = [];
  const seen = new Set<string>();
  for (const { testPath, implPath } of pairs) {
    const testContent = readFile(testPath);
    const implContent = readFile(implPath);
    const exported = extractExportedSymbols(implContent);
    const constants = extractModuleLevelConstants(implContent);
    const reexports = extractImportedNames(implContent);
    const mod = moduleNameFromImplPath(implPath);
    for (const imp of parsePythonFromImports(testContent)) {
      if (imp.module !== mod) {
        continue;
      }
      for (const name of imp.names) {
        if (name === '*' || exported.has(name) || constants.has(name) || reexports.has(name)) {
          continue;
        }
        const key = `${testPath}:${name}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        issues.push({
          code: 'python-test-import-symbol-missing',
          message: `python-export-contract：${testPath} import ${name} from ${mod}，但 ${implPath} 未导出`,
          module: mod,
          symbol: name,
          testFile: testPath,
          implFile: implPath,
        });
      }
    }
  }
  return issues;
}
