import type { DecisionArtifactsV1 } from './decisionArtifactsSchema';
import { parseDecisionArtifactsFromText } from './parseDecisionArtifacts';
import { isPythonStdlibRoot } from '../python-contract/pythonStdlibRoots';
import { isExternalPythonModuleRoot } from '../python-contract/pythonExternalModules';

function moduleExportsForSemantic(
  modules: Array<{ name: string; exports: string[] }> | undefined,
  semantic: string,
): string[] | null {
  const raw = rawModuleExportsForSemantic(modules, semantic);
  if (!raw) {
    return null;
  }
  const pruned = pruneExportNoise(raw);
  return pruned.length > 0 ? pruned : null;
}

function rawModuleExportsForSemantic(
  modules: Array<{ name: string; exports: string[] }> | undefined,
  semantic: string,
): string[] | null {
  const entry = (modules ?? []).find((m) => m.name?.trim() === semantic);
  const exports = [
    ...new Set(
      (entry?.exports ?? [])
        .map((e) => (typeof e === 'string' ? e.trim() : ''))
        .filter(Boolean),
    ),
  ];
  return exports.length > 0 ? exports : null;
}

function normalizeModules(
  modules: Array<{ name: string; exports: string[] }> | undefined,
): Array<{ name: string; exports: string[] }> {
  return (modules ?? [])
    .filter((m) => typeof m.name === 'string' && m.name.trim())
    .map((m) => ({
      name: m.name.trim(),
      exports: [
        ...new Set(
          (m.exports ?? [])
            .map((e) => (typeof e === 'string' ? e.trim() : ''))
            .filter(Boolean),
        ),
      ],
    }));
}

const MODULE_JSON_RE =
  /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"exports"\s*:\s*(\[[^\]]*\])\s*\}/g;
const COLON_LIST_RE = /[：:]\s*([a-zA-Z_]\w*(?:\s*[,，、]\s*[a-zA-Z_]\w*)+)/g;
/** 仅匹配模块级函数调用：排除 Class.method( 实例方法（T4 Run #59 broker.query_market） */
const PUBLIC_FUNC_CALL_RE = /(?<![.\w])([a-z][a-z0-9_]{2,})\s*\(/g;
const CLASS_RE = /\bclass\s+([A-Z]\w*)/g;
/** DecisionRecord 正文中出现的 PascalCase 类型名（BrokerAdapter、SimBroker 等） */
const PASCAL_CASE_TYPE_RE = /\b([A-Z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+)\b/g;
const BACKTICK_IDENT_RE = /`([A-Za-z_]\w*)`/g;
const MAIN_METHOD_RE = /主方法\s*`?([A-Za-z_]\w*)`?/g;
const DESIGN_CLASS_RE = /设计\s*([A-Z]\w*)\s*类/g;

const SKIP_IDENT = new Set([
  'if',
  'for',
  'def',
  'class',
  'from',
  'import',
  'None',
  'True',
  'False',
  'main',
  'pytest',
  'MVP',
  'Python',
  'CLI',
  'CSV',
  'DataFrame',
  'numpy',
  'pandas',
  'long',
  'short',
  'none',
  'dot',
  'type',
  'index',
  'period',
  'timestamp',
]);

const SKIP_PASCAL_CASE = new Set([
  'DecisionRecord',
  'SimpleNamespace',
  'FileNotFoundError',
]);

/** Python 内置 / 类型注解噪声，不得作为模块 export */
/** 上证/深证行情占位全局变量，非模块公开 API（T4 Run #51）。 */
const MARKET_INDEX_EXPORT_NOISE = new Set(['index_sh', 'index_sz']);

const BUILTIN_EXPORT_NOISE = new Set([
  // 类型构造器
  'int',
  'str',
  'bool',
  'float',
  'dict',
  'list',
  'tuple',
  'set',
  'frozenset',
  'bytes',
  'bytearray',
  'complex',
  'object',
  'any',
  'optional',
  'union',
  // 内建函数（decide 正文常写「取最大 id」「长度」等 → max/len 等被误抽为 export，
  //   但它们是 Python 内建、绝非模块 API；T6 batch2 run3：store 契约误含 `max`）
  'max',
  'min',
  'len',
  'sum',
  'sorted',
  'abs',
  'round',
  'range',
  'enumerate',
  'zip',
  'map',
  'filter',
  'all',
  'reversed',
  'next',
  'iter',
  'print',
  'open',
  'input',
  'type',
  'isinstance',
  'issubclass',
  'hasattr',
  'getattr',
  'setattr',
  'delattr',
  'repr',
  'format',
  'hash',
  'id',
  'vars',
  'dir',
  'super',
  'property',
  'staticmethod',
  'classmethod',
]);

/**
 * typing / dataclasses / enum / abc / collections 的「类型原语」噪声（T4 Run #66c）。
 * decide 正文常写「返回一个 NamedTuple」「用 dataclass 定义」「Optional[Signal]」等，
 * 这些是**导入的类型构造器**，被抽成契约 export → impl 合理不导出原语名 →
 * `python-impl-export-missing` 误拦（与 #66b 库名同类：导入名 ≠ 模块 API）。
 * 大小写不敏感（按 toLowerCase 比对）。
 */
const PYTHON_TYPING_DATACLASS_NOISE = new Set([
  // typing
  'namedtuple',
  'typeddict',
  'protocol',
  'generic',
  'typevar',
  'newtype',
  'callable',
  'classvar',
  'final',
  'literal',
  'annotated',
  'iterable',
  'iterator',
  'generator',
  'sequence',
  'mapping',
  'mutablemapping',
  'frozenset',
  'type',
  'awaitable',
  'coroutine',
  'asynciterator',
  'asynciterable',
  'contextmanager',
  'noreturn',
  'anystr',
  'overload',
  'cast',
  // dataclasses
  'dataclass',
  'field',
  'fields',
  'asdict',
  'astuple',
  'initvar',
  'make_dataclass',
  // enum
  'enum',
  'intenum',
  'flag',
  'intflag',
  'auto',
  // abc
  'abc',
  'abcmeta',
  'abstractmethod',
  // collections
  'ordereddict',
  'defaultdict',
  'counter',
  'deque',
]);

/** 异常类名（DecisionRecord 正文「抛出 KeyError」等），非模块 API。 */
const PYTHON_EXCEPTION_NOISE = new Set([
  'KeyError',
  'ValueError',
  'TypeError',
  'AttributeError',
  'IndexError',
  'RuntimeError',
  'NotImplementedError',
  'ImportError',
]);

/** pandas/numpy 方法链噪声（`df.assign()` / `rolling().mean()` 等），非模块 export。 */
const PANDAS_NUMPY_METHOD_NOISE = new Set([
  'assign',
  'rolling',
  'mean',
  'std',
  'ewm',
  'sort_index',
  'concat',
  'df',
  'low',
  'high',
  'close',
  'open',
  'volume',
  'iloc',
  'loc',
  'fillna',
  'dropna',
  'reset_index',
  'set_index',
  'compute_all',
]);

/**
 * 第三方库的「展示名」噪声（T4 Run #66b）：DecisionRecord 正文常写「使用 NumPy 计算…」，
 * `NumPy`/`Pandas` 等被 PascalCase 抽取或合成为契约 export → impl 合理不导出库名 →
 * `python-impl-export-missing` 误拦。库名永远不是模块级 API。
 * `isExternalPythonModuleRoot` 已覆盖 import 名（numpy/pandas/yaml…）；此集合补展示名
 * 与 import 名不一致的常见库（如 PyYAML→pyyaml、scikit-learn→sklearn）。
 */
const PYTHON_LIBRARY_DISPLAY_NOISE = new Set([
  'numpy',
  'pandas',
  'scipy',
  'matplotlib',
  'seaborn',
  'sklearn',
  'scikitlearn',
  'pyyaml',
  'tensorflow',
  'pytorch',
  'torch',
  'requests',
  'pytest',
]);

function normalizeLibraryName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_]/g, '');
}

/** DataFrame 指标输出列名 / 常量，非模块 export（T4 Run #60）。 */
const INDICATOR_OUTPUT_COLUMN_NOISE = new Set(['dif', 'dea', 'hist', 'cci', 'nan']);

const INDICATOR_COLUMN_NOISE_RE = [
  /^ma\d+$/i,
  /^boll_(?:lower|mid|upper)$/i,
  /^vol_ma\d+$/i,
  /^macd_(?:dif|dea|hist)$/i,
];

function isIndicatorColumnNoise(name: string): boolean {
  const n = name.trim();
  if (!n) {
    return false;
  }
  if (n === 'NaN' || INDICATOR_OUTPUT_COLUMN_NOISE.has(n.toLowerCase())) {
    return true;
  }
  return INDICATOR_COLUMN_NOISE_RE.some((re) => re.test(n));
}

const EXPLICIT_EXPORT_PHRASE_RE =
  /(?:五个公开函数为|公开函数为|exports\s*(?:列表)?[是为：:]+|公开符号(?:（[^）]*）)?[：:])\s*([^\n。；;]+)/gi;

function parseExportNameList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [
      ...new Set(
        parsed
          .map((e) => (typeof e === 'string' ? e.trim() : ''))
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

function isNoiseExportName(name: string): boolean {
  const n = name.trim();
  if (!n || n.startsWith('_') || SKIP_IDENT.has(n)) {
    return true;
  }
  if (BUILTIN_EXPORT_NOISE.has(n.toLowerCase())) {
    return true;
  }
  if (PYTHON_TYPING_DATACLASS_NOISE.has(n.toLowerCase())) {
    return true;
  }
  if (MARKET_INDEX_EXPORT_NOISE.has(n)) {
    return true;
  }
  if (PYTHON_EXCEPTION_NOISE.has(n)) {
    return true;
  }
  if (PANDAS_NUMPY_METHOD_NOISE.has(n)) {
    return true;
  }
  if (/Input$/i.test(n)) {
    return true;
  }
  if (isPythonStdlibRoot(n)) {
    return true;
  }
  // 第三方库名（import 根名 numpy/pandas/yaml… 或展示名 NumPy/PyYAML…）永非模块 API
  if (isExternalPythonModuleRoot(n) || PYTHON_LIBRARY_DISPLAY_NOISE.has(normalizeLibraryName(n))) {
    return true;
  }
  if (isIndicatorColumnNoise(n)) {
    return true;
  }
  return false;
}

/** 剔除已合成 artifacts / 正文扫描中的异常类与 pandas 方法噪声。 */
export function pruneExportNoise(exports: string[]): string[] {
  return [
    ...new Set(exports.map((e) => e.trim()).filter((e) => e && !isNoiseExportName(e))),
  ].sort((a, b) => a.localeCompare(b));
}

/** DecisionRecord 中显式列举的契约 exports（优先于全文函数调用扫描）。 */
function extractExplicitExportsFromProse(text: string): string[] | null {
  const symbols = new Set<string>();
  EXPLICIT_EXPORT_PHRASE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPLICIT_EXPORT_PHRASE_RE.exec(text)) !== null) {
    const segment = m[1]!;
    for (const tick of segment.matchAll(/`([A-Za-z_]\w*)`/g)) {
      addExportSymbol(symbols, tick[1]);
    }
    for (const part of segment.split(/[,，、]/)) {
      const cleaned = part.replace(/`/g, '').replace(/\s*\(.*$/, '').trim();
      if (/^[a-z][a-z0-9_]{2,}$/i.test(cleaned)) {
        addExportSymbol(symbols, cleaned);
      }
    }
  }
  const exports = pruneExportNoise([...symbols]);
  return exports.length >= 2 ? exports : null;
}

function addExportSymbol(out: Set<string>, name: string | undefined): void {
  const n = name?.trim();
  if (!n || isNoiseExportName(n)) {
    return;
  }
  if (!/^[A-Za-z_]\w*$/.test(n)) {
    return;
  }
  out.add(n);
}

export function isWeakModuleExports(exports: string[] | null | undefined): boolean {
  if (!exports?.length) {
    return true;
  }
  return exports.every((e) => isNoiseExportName(e));
}

/** sidecar exports 全是 snake_case 但正文含 PascalCase API 类型 → 误合成（T4 Run #59）。 */
function isMisleadingSidecarExports(
  exports: string[],
  decisionRecord: string,
): boolean {
  if (!exports.length) {
    return false;
  }
  const hasPascalExport = exports.some((e) => /^[A-Z]/.test(e));
  if (hasPascalExport) {
    return false;
  }
  PASCAL_CASE_TYPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PASCAL_CASE_TYPE_RE.exec(decisionRecord)) !== null) {
    if (!SKIP_PASCAL_CASE.has(m[1]!) && !isNoiseExportName(m[1]!)) {
      return true;
    }
  }
  return false;
}

function sidecarHasExportNoise(exports: string[] | null | undefined): boolean {
  return exports?.some((e) => isNoiseExportName(e.trim())) ?? false;
}

/** 从 DecisionRecord 正文（无 sidecar 时）抽取本切片 exports。 */
export function extractModuleExportsFromDecisionRecord(
  semantic: string,
  decisionRecord: string | null | undefined,
): string[] | null {
  const text = decisionRecord?.trim();
  if (!text) {
    return null;
  }

  const reparsed = parseDecisionArtifactsFromText(text);
  const fromSidecar = moduleExportsForSemantic(reparsed.artifacts?.modules, semantic);
  if (
    fromSidecar &&
    !isWeakModuleExports(fromSidecar) &&
    !isMisleadingSidecarExports(fromSidecar, text)
  ) {
    return fromSidecar;
  }

  MODULE_JSON_RE.lastIndex = 0;
  let jsonMatch: RegExpExecArray | null;
  while ((jsonMatch = MODULE_JSON_RE.exec(text)) !== null) {
    if (jsonMatch[1]!.trim() !== semantic) {
      continue;
    }
    const exports = pruneExportNoise(parseExportNameList(jsonMatch[2]!));
    if (exports.length > 0) {
      return exports;
    }
  }

  const explicit = extractExplicitExportsFromProse(text);
  if (explicit?.length) {
    return explicit;
  }

  const symbols = new Set<string>();

  MAIN_METHOD_RE.lastIndex = 0;
  while ((jsonMatch = MAIN_METHOD_RE.exec(text)) !== null) {
    addExportSymbol(symbols, jsonMatch[1]);
  }

  DESIGN_CLASS_RE.lastIndex = 0;
  while ((jsonMatch = DESIGN_CLASS_RE.exec(text)) !== null) {
    addExportSymbol(symbols, jsonMatch[1]);
  }

  CLASS_RE.lastIndex = 0;
  while ((jsonMatch = CLASS_RE.exec(text)) !== null) {
    addExportSymbol(symbols, jsonMatch[1]);
  }

  PASCAL_CASE_TYPE_RE.lastIndex = 0;
  while ((jsonMatch = PASCAL_CASE_TYPE_RE.exec(text)) !== null) {
    if (!SKIP_PASCAL_CASE.has(jsonMatch[1]!)) {
      addExportSymbol(symbols, jsonMatch[1]);
    }
  }

  BACKTICK_IDENT_RE.lastIndex = 0;
  while ((jsonMatch = BACKTICK_IDENT_RE.exec(text)) !== null) {
    addExportSymbol(symbols, jsonMatch[1]);
  }

  COLON_LIST_RE.lastIndex = 0;
  let listMatch: RegExpExecArray | null;
  while ((listMatch = COLON_LIST_RE.exec(text)) !== null) {
    for (const part of listMatch[1]!.split(/[,，、]/)) {
      addExportSymbol(symbols, part.replace(/\s*\(.*$/, '').trim());
    }
  }

  PUBLIC_FUNC_CALL_RE.lastIndex = 0;
  while ((listMatch = PUBLIC_FUNC_CALL_RE.exec(text)) !== null) {
    addExportSymbol(symbols, listMatch[1]);
  }

  const exports = pruneExportNoise([...symbols]);
  return exports.length > 0 ? exports : null;
}

/** 切片 decide 缺 sidecar 时，从 decisionRecord 合成 modules[] 单条。 */
export function synthesizeSliceDecisionArtifacts(
  semantic: string,
  decisionRecord: string,
  existing?: DecisionArtifactsV1 | null,
): DecisionArtifactsV1 | null {
  const fromRecord = extractModuleExportsFromDecisionRecord(semantic, decisionRecord);
  const rawExisting = rawModuleExportsForSemantic(existing?.modules, semantic);
  const existingEntry = moduleExportsForSemantic(existing?.modules, semantic);
  const sidecarNeedsSanitize =
    rawExisting != null &&
    existingEntry != null &&
    rawExisting.length !== existingEntry.length;

  const writeSanitizedModules = (exports: string[]): DecisionArtifactsV1 => {
    const modules = normalizeModules(existing?.modules).filter((m) => m.name !== semantic);
    modules.push({ name: semantic, exports });
    return {
      version: 1,
      files: existing?.files ?? [],
      modules,
      ...(existing?.dependencies ? { dependencies: existing.dependencies } : {}),
      ...(existing?.testStack ? { testStack: existing.testStack } : {}),
      ...(existing?.behaviorSpec ? { behaviorSpec: existing.behaviorSpec } : {}),
    };
  };

  if (!fromRecord?.length) {
    if (existingEntry && (sidecarNeedsSanitize || sidecarHasExportNoise(rawExisting))) {
      return writeSanitizedModules(existingEntry);
    }
    return existing ?? null;
  }

  if (
    existingEntry &&
    !isWeakModuleExports(existingEntry) &&
    !isMisleadingSidecarExports(existingEntry, decisionRecord) &&
    !sidecarNeedsSanitize &&
    !sidecarHasExportNoise(rawExisting)
  ) {
    return existing ?? null;
  }
  const exports =
    existingEntry &&
    !isWeakModuleExports(existingEntry) &&
    !isMisleadingSidecarExports(existingEntry, decisionRecord) &&
    !sidecarHasExportNoise(rawExisting)
      ? existingEntry
      : fromRecord;
  return writeSanitizedModules(exports);
}
