import { extractModuleExportsFromDecisionRecord, pruneExportNoise, shouldPreferGlobalOverSlice } from './decisionRecordExports';
import type { BehaviorSpecV1 } from './behaviorSpecSchema';
import { filterBlockedPipDependencies } from '../python-contract/blockedPipDependencies';

export interface DecisionArtifactFileV1 {
  key: string;
  path: string;
  format: string;
  content: string;
}

/** TDD / 量化基线依赖（与 stage_ensure_requirements_baseline 对齐）。 */
export const PYTHON_BASELINE_DEPENDENCIES = ['pytest', 'numpy', 'pandas'] as const;

/**
 * PyPI 包名 → import 根名别名（lint 与 prompt SSOT 共用）。
 * 例：pyyaml 已声明时 `import yaml` 合法。
 */
export const DEPENDENCY_IMPORT_ROOT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  pyyaml: ['yaml'],
};

/** decisionArtifacts.files 含 YAML 落盘路径时隐式允许的包（T4 config.yaml 场景）。 */
export function inferImplicitDependenciesFromArtifacts(
  artifacts: DecisionArtifactsV1 | null | undefined,
): string[] {
  if (!artifacts?.files?.length) {
    return [];
  }
  const implicit = new Set<string>();
  for (const f of artifacts.files) {
    const p = (f.path ?? '').trim().toLowerCase();
    if (p.endsWith('.yaml') || p.endsWith('.yml')) {
      // pip 包名是 pyyaml；`import yaml` 由 isDeclaredImportRoot 别名处理，不得写入 requirements.txt
      implicit.add('pyyaml');
    }
  }
  return [...implicit];
}

/** import 根名是否在已声明依赖集合内（含别名）。 */
export function isDeclaredImportRoot(importRoot: string, allowedDeps: Iterable<string>): boolean {
  const root = importRoot.toLowerCase();
  const allowed = new Set([...allowedDeps].map((d) => d.toLowerCase()));
  if (allowed.has(root)) {
    return true;
  }
  for (const [pkg, aliases] of Object.entries(DEPENDENCY_IMPORT_ROOT_ALIASES)) {
    if (allowed.has(pkg) && aliases.includes(root)) {
      return true;
    }
  }
  return false;
}

export interface DecisionArtifactsV1 {
  version: 1;
  files: DecisionArtifactFileV1[];
  modules?: Array<{ name: string; exports: string[] }>;
  /** 允许 impl/fix 引用的第三方包根名（不含版本 pin）。 */
  dependencies?: string[];
  testStack?: 'pytest' | 'jest' | 'vitest';
  /** 行为规格 SSOT（首期 signals 必填；见 behaviorSpecSchema.ts）。 */
  behaviorSpec?: BehaviorSpecV1;
}

export function isDecisionArtifactsV1(value: unknown): value is DecisionArtifactsV1 {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const o = value as DecisionArtifactsV1;
  return o.version === 1 && Array.isArray(o.files);
}

export function normalizeModuleExports(
  modules: Array<{ name: string; exports: string[] }> | undefined,
): Array<{ name: string; exports: string[] }> {
  if (!modules?.length) {
    return [];
  }
  return modules
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

/**
 * 纠正常见 LLM 误写（T4 Run #38：main 切片 export=mode 实为 CLI --mode 参数名）。
 * 仅在入口模块且 exports 为单一可疑符号时替换，避免误伤合法命名。
 */
export function sanitizeModuleExports(semantic: string, exports: string[]): string[] {
  const cleaned = pruneExportNoise(exports);
  if (semantic === 'main' && cleaned.length === 1 && cleaned[0] === 'mode') {
    return ['main'];
  }
  return cleaned;
}

/** slice sidecar → slice decisionRecord 正文 → global architecture modules[]。 */
export function resolveModuleExports(
  semantic: string,
  sliceArtifacts: DecisionArtifactsV1 | null | undefined,
  globalArtifacts: DecisionArtifactsV1 | null | undefined,
  sliceDecisionRecord?: string | null,
): string[] | null {
  const sliceEntry = normalizeModuleExports(sliceArtifacts?.modules).find((m) => m.name === semantic);
  const globalEntry = normalizeModuleExports(globalArtifacts?.modules).find((m) => m.name === semantic);
  const globalExports =
    globalEntry && globalEntry.exports.length > 0
      ? sanitizeModuleExports(semantic, globalEntry.exports)
      : null;

  if (sliceEntry && sliceEntry.exports.length > 0) {
    const sliceExports = sanitizeModuleExports(semantic, sliceEntry.exports);
    if (globalExports && shouldPreferGlobalOverSlice(sliceExports, globalExports)) {
      return globalExports;
    }
    return sliceExports;
  }
  if (sliceDecisionRecord?.trim()) {
    const fromRecord = extractModuleExportsFromDecisionRecord(semantic, sliceDecisionRecord);
    if (fromRecord?.length) {
      if (globalExports && shouldPreferGlobalOverSlice(fromRecord, globalExports)) {
        return globalExports;
      }
      return fromRecord;
    }
  }
  if (globalExports) {
    return globalExports;
  }
  return null;
}

export function normalizeDependencies(deps: string[] | undefined): string[] {
  if (!deps?.length) {
    return [];
  }
  return [
    ...new Set(
      deps
        .map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : ''))
        .filter(Boolean),
    ),
  ];
}

/** 合并 global + 全部 slice decisionArtifacts.dependencies，并含基线包。 */
export function resolveDeclaredDependencies(
  sliceArtifacts: DecisionArtifactsV1 | null | undefined,
  globalArtifacts: DecisionArtifactsV1 | null | undefined,
): string[] {
  const merged = new Set<string>(PYTHON_BASELINE_DEPENDENCIES);
  for (const dep of normalizeDependencies(globalArtifacts?.dependencies)) {
    merged.add(dep);
  }
  for (const dep of normalizeDependencies(sliceArtifacts?.dependencies)) {
    merged.add(dep);
  }
  return [...merged];
}

/** 从 workflow instance 收集全部已声明第三方依赖（global + 各 slice decide + 隐式推断）。 */
export function collectDeclaredDependenciesFromInstance(
  stageRuntimes: Array<{ stageId: string; outputs?: Record<string, unknown> }>,
  decisionArtifactsKey: string,
): string[] {
  const merged = new Set<string>(PYTHON_BASELINE_DEPENDENCIES);
  for (const rt of stageRuntimes) {
    if (!rt.stageId.startsWith('stage_decide_')) {
      continue;
    }
    const raw = rt.outputs?.[decisionArtifactsKey];
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const artifacts = raw as DecisionArtifactsV1;
    for (const dep of normalizeDependencies(artifacts.dependencies)) {
      merged.add(dep);
    }
    for (const dep of inferImplicitDependenciesFromArtifacts(artifacts)) {
      merged.add(dep);
    }
  }
  return filterBlockedPipDependencies(merged);
}

/** import 根名别名（如 yaml）→ 排除；仅保留可 pip install 的包名。 */
export function toPipInstallableDependencies(deps: Iterable<string>): string[] {
  const aliasImportRoots = new Set(
    Object.values(DEPENDENCY_IMPORT_ROOT_ALIASES).flatMap((aliases) => aliases.map((a) => a.toLowerCase())),
  );
  const out = new Set<string>();
  for (const dep of deps) {
    const pkg = dep.trim().toLowerCase();
    if (!pkg || aliasImportRoots.has(pkg)) {
      continue;
    }
    out.add(pkg);
  }
  return [...out];
}

/** 运行时注入 test_write / impl / fix：已声明第三方依赖 SSOT。 */
export function buildDeclaredDependenciesPromptSuffix(
  stageRuntimes: Array<{ stageId: string; outputs?: Record<string, unknown> }>,
  decisionArtifactsKey: string,
): string | undefined {
  const deps = collectDeclaredDependenciesFromInstance(stageRuntimes, decisionArtifactsKey);
  if (deps.length === 0) {
    return undefined;
  }
  return [
    '【已声明第三方依赖 SSOT（decisionArtifacts.dependencies + 基线 + 隐式推断）】',
    '仅可 import 下列第三方包（以及 Python 标准库、项目内模块）：',
    ...deps.map((d) => `- ${d}`),
    '未列出的第三方包禁止 import；需要 YAML 解析且列表含 pyyaml 时使用 `import yaml`。',
  ].join('\n');
}

/** 从 modules[] 收集项目内包名（用于 declared-deps lint 跳过）。 */
export function collectProjectModuleNames(
  sliceArtifacts: DecisionArtifactsV1 | null | undefined,
  globalArtifacts: DecisionArtifactsV1 | null | undefined,
): string[] {
  const names = new Set<string>();
  for (const m of normalizeModuleExports(globalArtifacts?.modules)) {
    names.add(m.name);
  }
  for (const m of normalizeModuleExports(sliceArtifacts?.modules)) {
    names.add(m.name);
  }
  return [...names];
}

/** 从 instance 全部 decide 阶段收集项目内模块名。 */
export function collectAllProjectModuleNamesFromInstance(
  stageRuntimes: Array<{ stageId: string; outputs?: Record<string, unknown> }>,
  decisionArtifactsKey: string,
): string[] {
  const names = new Set<string>();
  for (const rt of stageRuntimes) {
    if (!rt.stageId.startsWith('stage_decide_')) {
      continue;
    }
    const raw = rt.outputs?.[decisionArtifactsKey];
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    for (const m of normalizeModuleExports((raw as DecisionArtifactsV1).modules)) {
      names.add(m.name);
    }
  }
  return [...names];
}
