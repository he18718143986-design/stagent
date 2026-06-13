import * as fs from 'fs';
import * as path from 'path';
import type { Stage, WorkflowDefinition } from '../../WorkflowDefinition';
import {
  isImplStageId,
  semanticNameFromImplStageId,
  semanticNameFromTestWriteStageId,
  testWriteStageIdFromSemanticName,
} from '../../workflow/StageIdPatterns';
import type { StageRuntime } from '../../WorkflowDefinition';
import { CODE_RUNNER_EXIT_OUTPUT_KEY, VERIFY_OUT_OUTPUT_KEY } from '../../WorkflowOutputKeys';
import { buildConfigYamlAccessGuide, extractYamlTopLevelKeys } from '../../ConfigContractLint';
import {
  isPythonEntryScriptPath,
  resolveArchitectureConfigYamlContent,
} from '../../commitment/resolveArchitectureConfigYaml';

/** impl/fix GREEN 阶段注入落盘 test 全文上限（字符）。 */
export const SLICE_TEST_FILE_PROMPT_MAX_CHARS = 14_000;
export const PYTEST_FAILURE_PROMPT_MAX_CHARS = 6_000;
import { writeOutputToFileOf } from '../../workflow/StageToolConfigAccess';
import { parsePythonFromImports } from '../../python-contract/PythonExportContractLint';
import { isExternalPythonModuleRoot } from '../../python-contract/pythonExternalModules';

const PLAIN_IMPORT_RE = /^\s*import\s+([a-zA-Z_][\w.]*)\s*(?:as\s+\w+)?\s*$/gm;

export function extractProjectImportLinesFromPythonTest(content: string, semantic: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const imp of parsePythonFromImports(content)) {
    const modRoot = imp.module.split('.')[0]!;
    if (isExternalPythonModuleRoot(modRoot) || modRoot !== semantic) {
      continue;
    }
    const names = imp.names.filter((n) => n !== '*');
    const line =
      names.length > 0
        ? `from ${modRoot} import ${names.join(', ')}`
        : `from ${modRoot} import ...`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }

  PLAIN_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLAIN_IMPORT_RE.exec(content)) !== null) {
    const modRoot = m[1]!.split('.')[0]!;
    if (isExternalPythonModuleRoot(modRoot) || modRoot !== semantic) {
      continue;
    }
    const line = `import ${modRoot}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }

  return lines;
}

export interface PairedSliceTestContext {
  semantic: string;
  testRelPath: string;
  testContent: string;
  implRelPath?: string;
}

function truncateForPrompt(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}\n…(truncated ${trimmed.length - maxChars} chars)`;
}

function findPairedTestWriteStage(wf: WorkflowDefinition, semantic: string): Stage | undefined {
  const id = testWriteStageIdFromSemanticName(semantic);
  return wf.stages?.find((s) => s.id === id);
}

export function resolvePairedSliceTestContext(
  wf: WorkflowDefinition,
  semantic: string,
  workspaceRoot?: string,
  implStage?: Stage,
): PairedSliceTestContext | undefined {
  if (!workspaceRoot?.trim() || !semantic.trim()) {
    return undefined;
  }
  const testWrite = findPairedTestWriteStage(wf, semantic);
  const testRelPath = testWrite ? writeOutputToFileOf(testWrite) : undefined;
  if (!testRelPath) {
    return undefined;
  }
  const abs = path.join(workspaceRoot, testRelPath);
  if (!fs.existsSync(abs)) {
    return undefined;
  }
  const testContent = fs.readFileSync(abs, 'utf8');
  if (!testContent.trim()) {
    return undefined;
  }
  const implRelPath = implStage
    ? writeOutputToFileOf(implStage) ?? `${semantic}/__init__.py`
    : undefined;
  return { semantic, testRelPath, testContent, implRelPath };
}

export function readTestRunFailureExcerpt(testRunRuntime: StageRuntime | undefined): string | undefined {
  if (!testRunRuntime) {
    return undefined;
  }
  const verify = String(testRunRuntime.outputs?.[VERIFY_OUT_OUTPUT_KEY] ?? '').trim();
  const stdout = String(testRunRuntime.outputs?.stdout ?? '').trim();
  const stderr = String(testRunRuntime.outputs?.stderr ?? '').trim();
  const exitCode = testRunRuntime.outputs?.[CODE_RUNNER_EXIT_OUTPUT_KEY];
  const body = verify || [stdout, stderr].filter(Boolean).join('\n');
  if (!body) {
    return exitCode != null ? `exitCode=${exitCode}` : undefined;
  }
  const header = exitCode != null ? `exitCode=${exitCode}\n` : '';
  return truncateForPrompt(`${header}${body}`, PYTEST_FAILURE_PROMPT_MAX_CHARS);
}

/**
 * 层3 · GREEN 行为桥接：impl 阶段注入已落盘 pytest 全文 + import 约束。
 */
export function buildTestGreenBridgePromptSuffix(
  wf: WorkflowDefinition,
  stage: Stage,
  workspaceRoot?: string,
): string | undefined {
  if (!isImplStageId(stage.id) || !workspaceRoot?.trim()) {
    return undefined;
  }
  const semantic = semanticNameFromImplStageId(stage.id);
  if (!semantic) {
    return undefined;
  }
  const ctx = resolvePairedSliceTestContext(wf, semantic, workspaceRoot, stage);
  if (!ctx) {
    return undefined;
  }
  const importLines = extractProjectImportLinesFromPythonTest(ctx.testContent, semantic);
  const implPath = ctx.implRelPath ?? `${semantic}/__init__.py`;
  const lines = [
    '【GREEN 阶段 · 必读已落盘测试（行为桥接）】',
    `你必须让 ${ctx.testRelPath} 中全部 pytest 通过；禁止修改测试文件；禁止改 export 名。`,
    `实现落盘：${implPath}；import 模块名：${semantic}（禁止 from __init__ import）。`,
  ];
  if (importLines.length > 0) {
    lines.push('契约 import（须原样满足）：', ...importLines.map((l) => `- ${l}`));
  }
  lines.push(
    '实现规则：逐条满足 assert/raises 语义；返回值类型/键名须与测试消费一致；嵌套 helper 不得作为顶层 export。',
  );
  if (/\bthreading\b/.test(ctx.testContent)) {
    lines.push(
      '测试含 threading：若实现用 Lock，必须用 RLock 或避免在 with 持锁块内调用会再次 acquire 同锁的内部方法（否则 pytest 死锁挂起）。',
    );
  }
  lines.push(`--- ${ctx.testRelPath} ---`, truncateForPrompt(ctx.testContent, SLICE_TEST_FILE_PROMPT_MAX_CHARS));
  return lines.join('\n');
}

/** @deprecated 使用 buildTestGreenBridgePromptSuffix */
export function buildTestImportBridgePromptSuffix(
  wf: WorkflowDefinition,
  stage: Stage,
  workspaceRoot?: string,
): string | undefined {
  return buildTestGreenBridgePromptSuffix(wf, stage, workspaceRoot);
}

/** 入口脚本（main.py 等）须对齐架构决策 config.yaml 键（T4 Run #33 smoke 根治）。 */
export function buildConfigYamlBridgePromptSuffix(
  stageRuntimes: readonly StageRuntime[],
  entryRelPath: string | undefined,
): string | undefined {
  if (!isPythonEntryScriptPath(entryRelPath)) {
    return undefined;
  }
  const yaml = resolveArchitectureConfigYamlContent(stageRuntimes);
  if (!yaml?.trim()) {
    return undefined;
  }
  const topKeys = extractYamlTopLevelKeys(yaml);
  const lines = [
    '【config.yaml 键 SSOT（架构决策）】',
    `全局架构将落盘 config.yaml；${entryRelPath} 经 yaml.safe_load 后只能访问架构 YAML 已定义键（禁止发明 trade/modules/data_source 等顶层键）。`,
    buildConfigYamlAccessGuide(yaml),
    '禁止通过 config dict 注入可调用对象（如 config.get("compute_indicators")）；应直接 from indicators/signals/risk/broker import 对应函数/类。',
  ];
  if (topKeys.length) {
    lines.push(`顶层键一览：${topKeys.join(', ')}`);
  }
  lines.push('--- config.yaml（架构决策预览）---', truncateForPrompt(yaml, 4_000));
  return lines.join('\n');
}

/** fix 阶段：重申落盘 test + 最近 pytest 失败摘要。 */
export function buildFixTestGreenBridgePromptSuffix(
  wf: WorkflowDefinition,
  semantic: string,
  workspaceRoot: string | undefined,
  testRunRuntime: StageRuntime | undefined,
): string | undefined {
  const ctx = resolvePairedSliceTestContext(wf, semantic, workspaceRoot);
  if (!ctx) {
    return undefined;
  }
  const failure = readTestRunFailureExcerpt(testRunRuntime);
  const lines = [
    '【fix · 对齐已落盘测试（行为桥接）】',
    `禁止修改 ${ctx.testRelPath}；只改 impl/requirements 使下列测试通过。`,
    `--- ${ctx.testRelPath} ---`,
    truncateForPrompt(ctx.testContent, SLICE_TEST_FILE_PROMPT_MAX_CHARS),
  ];
  if (failure) {
    lines.push('--- 最近 pytest 失败输出 ---', failure);
  }
  return lines.join('\n');
}

/** testfix replan 注入实现源码上限（字符）。 */
export const SLICE_IMPL_FILE_PROMPT_MAX_CHARS = 14_000;

/**
 * testfix replan（重写假红嫌疑测试）· 实现侧桥接：注入实现源码全文 + 当前测试 + pytest 失败。
 *
 * T4 Run #24 根因：重写测试时无实现上下文 → LLM 发明构造签名
 * （`SimBroker(initial_cash=…)` vs 实际 `__init__`）→ 全部 setup TypeError。
 * 测试必须对齐**已落盘实现的真实 API**，只修脆弱断言，不得虚构接口。
 */
export function buildTestRewriteImplBridgePromptSuffix(
  wf: WorkflowDefinition,
  semantic: string,
  workspaceRoot: string | undefined,
  testRunRuntime: StageRuntime | undefined,
): string | undefined {
  if (!workspaceRoot?.trim() || !semantic.trim()) {
    return undefined;
  }
  const implStage = wf.stages?.find((s) => s.id === `stage_impl_${semantic}`);
  const implRelPath = (implStage ? writeOutputToFileOf(implStage) : undefined) ?? `${semantic}/__init__.py`;
  const implAbs = path.join(workspaceRoot, implRelPath);
  if (!fs.existsSync(implAbs)) {
    return undefined;
  }
  const implContent = fs.readFileSync(implAbs, 'utf8');
  if (!implContent.trim()) {
    return undefined;
  }
  const lines = [
    '【测试重写 · 实现 API 桥接（SSOT）】',
    `重写的测试必须基于下方实现源码的**真实签名**（构造参数、方法名、返回键名、状态取值）调用；禁止虚构任何参数或方法。`,
    `保持失败测试覆盖的契约行为，只修正测试自身缺陷（脆弱断言/虚构 API/非契约属性）。`,
    `--- ${implRelPath}（已落盘实现，禁止假设其它接口） ---`,
    truncateForPrompt(implContent, SLICE_IMPL_FILE_PROMPT_MAX_CHARS),
  ];
  const ctx = resolvePairedSliceTestContext(wf, semantic, workspaceRoot);
  if (ctx) {
    lines.push(
      `--- ${ctx.testRelPath}（当前测试，待重写） ---`,
      truncateForPrompt(ctx.testContent, SLICE_TEST_FILE_PROMPT_MAX_CHARS),
    );
  }
  const failure = readTestRunFailureExcerpt(testRunRuntime);
  if (failure) {
    lines.push('--- 最近 pytest 失败输出 ---', failure);
  }
  return lines.join('\n');
}

/** 提取 Python 文件顶层 def/class 与类内公开方法（含 __init__）的签名行（供集成调用对齐）。 */
export function extractPublicPythonSignatures(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < 80; i++) {
    const raw = lines[i]!;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    const isTop = indent === 0 && /^(?:async\s+)?(?:def|class)\s+[A-Za-z_]/.test(trimmed);
    const isMethod = indent === 4 && /^(?:async\s+)?def\s+[A-Za-z_]/.test(trimmed);
    if (!isTop && !isMethod) {
      continue;
    }
    const name = trimmed.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/)?.[1] ?? '';
    if (name.startsWith('_') && name !== '__init__') {
      continue;
    }
    let sig = trimmed;
    let j = i;
    if (/^(?:async\s+)?def/.test(trimmed)) {
      const bal = (s: string) => (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;
      while (bal(sig) > 0 && j + 1 < lines.length) {
        j++;
        sig += ' ' + lines[j]!.trim();
      }
      const closeParen = sig.lastIndexOf(')');
      const colon =
        closeParen >= 0 ? sig.indexOf(':', closeParen) : sig.indexOf(':');
      if (colon >= 0) {
        sig = sig.slice(0, colon + 1);
      }
    } else {
      const colon = sig.indexOf(':');
      if (colon >= 0) {
        sig = sig.slice(0, colon + 1);
      }
    }
    out.push((isMethod ? '    ' : '') + sig);
  }
  return out;
}

/**
 * 集成切片（main）impl/fix · 下游模块真实 API 签名 SSOT。
 * T4 Run #57：main 调 `SimBroker(config)` 但 broker 真实 `__init__(self)` 不收参；
 * 测试用 autospec=True 锁真实签名 → TypeError，fix 链不见下游签名而耗尽。
 */
export function buildIntegrationApiBridgePromptSuffix(
  wf: WorkflowDefinition,
  semantic: string,
  workspaceRoot: string | undefined,
): string | undefined {
  if (semantic !== 'main' || !workspaceRoot?.trim()) {
    return undefined;
  }
  const blocks: string[] = [];
  for (const stage of wf.stages ?? []) {
    if (!isImplStageId(stage.id) || stage.id.includes('_stagent_bundle')) {
      continue;
    }
    const peer = semanticNameFromImplStageId(stage.id);
    if (!peer || peer === 'main' || peer === 'conftest') {
      continue;
    }
    const rel = writeOutputToFileOf(stage) ?? `${peer}/__init__.py`;
    const abs = path.join(workspaceRoot, rel);
    if (!fs.existsSync(abs)) {
      continue;
    }
    const sigs = extractPublicPythonSignatures(fs.readFileSync(abs, 'utf8'));
    if (sigs.length > 0) {
      blocks.push(`# ${peer}（${rel}）`, ...sigs);
    }
  }
  if (blocks.length === 0) {
    return undefined;
  }
  return [
    '【集成切片 · 下游模块真实 API 签名 SSOT（运行时 · 已落盘实现）】',
    'main 调用 indicators/signals/risk/broker 时，必须严格按下方真实签名调用（构造参数个数、方法名、是否收参）；',
    '测试常用 mock.patch(..., autospec=True) 锁定真实签名，调用不符会 TypeError。禁止臆造参数（如 broker `__init__(self)` 不收参时严禁 `SimBroker(config)`）。',
    ...blocks,
  ].join('\n');
}

/** 切片 Python import 模块名 = stage semantic（≠ impl 路径 basename）。 */
export function resolveSlicePythonImportModuleName(
  wf: WorkflowDefinition,
  stage: Stage,
): string | undefined {
  const fromTest = semanticNameFromTestWriteStageId(stage.id);
  if (fromTest) {
    return fromTest;
  }
  const fromImpl = semanticNameFromImplStageId(stage.id);
  if (fromImpl) {
    return fromImpl;
  }
  return undefined;
}
