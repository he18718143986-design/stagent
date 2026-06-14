/**
 * M41：工作区契约 lint 层 — 从 WorkflowEngine 抽出跨文件 / SDK / 测试质量 lint。
 */
import * as path from 'path';
import { contextMdPath } from './paths/StagentPaths';
import type { WorkflowInstance } from './WorkflowDefinition';
import { collectWorkflowArtifacts } from './WorkflowArtifactRegistry';
import { lintCrossFileKeyContract, type ProjectFile } from './CrossFileKeyContractLint';
import { analyzePythonModuleDepth, formatModuleDepthWarning } from './ModuleDepthScorer';
import { parseGlossary } from './ProjectGlossaryStore';
import { lintSampleReaderHeaderContract } from './SampleHeaderContractLint';
import { COMMITMENT_SNAPSHOT_OUTPUT_KEY } from './commitment';
import type { CommitmentSnapshot } from './commitment';
import { readContractCommitmentsEnabled } from './settings/readers/contract';
import { PRIMARY_DECISION_OUTPUT_KEY } from './WorkflowOutputKeys';
import {
  collectDecisionRecordsFromInstance,
  lintSdkPathContract,
  sdkPathContractIssuesToWarnings,
  type SdkPathContractIssue,
} from './SdkPathContractLint';
import { lintTestQuality, testQualityIssuesToWarnings } from './TestQualityLint';
import {
  lintPythonExportContractOnDisk,
  type PythonExportContractIssue,
} from './python-contract/PythonExportContractLint';
import { collectSlicePythonPaths } from './python-contract/slicePythonPaths';
import {
  lintPythonPypiSymbolsOnDisk,
  type PythonPypiSymbolIssue,
} from './python-contract/PythonPypiSymbolLint';
import {
  DEFAULT_FS_READ_TIMEOUT_MS,
  pathExists,
  readTextFile,
  readTextFileIfExists,
} from './FsAsync';

export interface WorkspaceLintContext {
  instance: WorkflowInstance | undefined;
  workspaceRootAbsolute: string | undefined;
  glossaryEnabled: boolean;
  sdkPathContractLintMode: 'off' | 'warn' | 'hard';
  pythonExportContractLintMode: 'off' | 'warn' | 'hard';
  pythonPypiSymbolLintMode: 'off' | 'warn' | 'hard';
}

/** 从工作区文件集解析生产模块名：顶层非 tests 目录（含 .py）+ 顶层 *.py（如 main.py）+ 约定 src/main。 */
function collectWorkspaceProductionModules(files: ProjectFile[]): string[] {
  const names = new Set<string>(['src', 'main']);
  for (const f of files) {
    const norm = f.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!/\.py$/i.test(norm) || /(^|\/)(test_|tests?\/)/i.test(norm)) {
      continue;
    }
    const segs = norm.split('/').filter(Boolean);
    if (segs.length >= 2) {
      const top = segs[0];
      if (top && top !== 'tests' && top !== 'src') {
        names.add(top);
      }
    } else if (segs.length === 1) {
      names.add(segs[0].replace(/\.py$/i, ''));
    }
  }
  return [...names];
}

export async function collectWorkspaceProjectFiles(ctx: WorkspaceLintContext): Promise<ProjectFile[]> {
  const ws = ctx.workspaceRootAbsolute;
  if (!ws || !ctx.instance) {
    return [];
  }
  const registry = collectWorkflowArtifacts(ctx.instance.definition);
  const candidates = registry.paths.filter((rel) =>
    /\.(py|json|ya?ml|tsx?|jsx?|mjs|cjs)$/i.test(rel),
  );
  const reads = await Promise.all(
    candidates.map(async (rel) => {
      try {
        const abs = path.join(ws, rel);
        if (!(await pathExists(abs))) {
          return undefined;
        }
        return { path: rel, content: await readTextFile(abs, { timeoutMs: DEFAULT_FS_READ_TIMEOUT_MS }) };
      } catch {
        return undefined;
      }
    }),
  );
  return reads.filter((f): f is ProjectFile => f !== undefined);
}

export function collectSdkPathContractIssues(
  ctx: WorkspaceLintContext,
  files: ProjectFile[],
): SdkPathContractIssue[] {
  if (!ctx.instance || ctx.sdkPathContractLintMode === 'off') {
    return [];
  }
  const registry = collectWorkflowArtifacts(ctx.instance.definition);
  const decisionRecords = collectDecisionRecordsFromInstance(
    ctx.instance.definition,
    ctx.instance.stageRuntimes.map((rt) => ({
      stageId: rt.stageId,
      decisionRecord: rt.outputs[PRIMARY_DECISION_OUTPUT_KEY],
    })),
  );
  const commitmentSnapshots = readContractCommitmentsEnabled()
    ? ctx.instance.stageRuntimes
        .map((rt) => {
          const raw = rt.outputs[COMMITMENT_SNAPSHOT_OUTPUT_KEY];
          if (!raw || typeof raw !== 'object') {
            return null;
          }
          return { stageId: rt.stageId, snapshot: raw as CommitmentSnapshot };
        })
        .filter((x): x is { stageId: string; snapshot: CommitmentSnapshot } => x !== null)
    : undefined;

  return lintSdkPathContract({
    workflow: ctx.instance.definition,
    files,
    decisionRecords,
    commitmentSnapshots,
    registry,
  });
}

export function resolveExportContractTestFiles(
  instance: WorkflowInstance,
  sliceSemantic?: string,
): string[] {
  const all = collectWorkflowArtifacts(instance.definition).paths.filter((p) =>
    /(^|\/)tests\/test_.*\.py$/i.test(p.replace(/\\/g, '/')),
  );
  if (!sliceSemantic?.trim()) {
    return all;
  }
  const { testRelPath } = collectSlicePythonPaths(instance.definition, sliceSemantic.trim());
  return testRelPath ? [testRelPath] : all;
}

export function collectPythonExportContractIssues(
  ctx: WorkspaceLintContext,
  options?: { sliceSemantic?: string },
): PythonExportContractIssue[] {
  if (!ctx.instance || ctx.pythonExportContractLintMode === 'off') {
    return [];
  }
  const ws = ctx.workspaceRootAbsolute;
  if (!ws) {
    return [];
  }
  const testFiles = resolveExportContractTestFiles(ctx.instance, options?.sliceSemantic);
  if (testFiles.length === 0) {
    return [];
  }
  return lintPythonExportContractOnDisk({ workspaceRoot: ws, testFiles });
}

export async function runWorkspaceContractLint(ctx: WorkspaceLintContext): Promise<string[]> {
  const files = await collectWorkspaceProjectFiles(ctx);
  const ws = ctx.workspaceRootAbsolute;
  if (!ws || !ctx.instance) {
    return [];
  }
  const warnings: string[] = [];
  if (files.length >= 2) {
    let canonicalKeys: string[] | undefined;
    if (ctx.glossaryEnabled) {
      try {
        const ctxPath = contextMdPath(ws);
        const ctxRaw = await readTextFileIfExists(ctxPath, { timeoutMs: DEFAULT_FS_READ_TIMEOUT_MS });
        if (ctxRaw !== undefined) {
          canonicalKeys = parseGlossary(ctxRaw).map((e) => e.term);
        }
      } catch {
        // CONTEXT.md 读失败不影响主 lint
      }
    }
    warnings.push(...lintCrossFileKeyContract(files, canonicalKeys).warnings);
    // 生产模块名按工作区实际包目录解析（顶层非 tests 目录的 .py / main.py），供 test-quality
    // lint 用——避免确定性平台任务（非 T4 切片名）被误判为「未 import 生产模块」假绿。
    const productionModules = collectWorkspaceProductionModules(files);
    for (const f of files) {
      if (/(^|\/)(test_|tests?\/).*\.py$|_test\.py$/i.test(f.path)) {
        warnings.push(
          ...testQualityIssuesToWarnings(f.path, lintTestQuality(f.content, { productionModules })),
        );
      }
    }
    warnings.push(...lintSampleReaderHeaderContract(files));
    for (const f of files) {
      if (/\.py$/i.test(f.path)) {
        const msg = formatModuleDepthWarning(f.path, analyzePythonModuleDepth(f.content));
        if (msg) {
          warnings.push(msg);
        }
      }
    }
  }
  if (ctx.sdkPathContractLintMode === 'warn') {
    warnings.push(...sdkPathContractIssuesToWarnings(collectSdkPathContractIssues(ctx, files)));
  }
  if (ctx.pythonExportContractLintMode === 'warn') {
    for (const issue of collectPythonExportContractIssues(ctx)) {
      warnings.push(`[python-export-contract ${issue.code}] ${issue.message}`);
    }
  }
  if (ctx.pythonPypiSymbolLintMode === 'warn') {
    for (const issue of collectPythonPypiSymbolIssues(ctx)) {
      warnings.push(`[python-pypi-symbol ${issue.code}] ${issue.message}`);
    }
  }
  return warnings;
}

export function collectPythonPypiSymbolIssues(ctx: WorkspaceLintContext): PythonPypiSymbolIssue[] {
  if (!ctx.instance || ctx.pythonPypiSymbolLintMode === 'off') {
    return [];
  }
  const ws = ctx.workspaceRootAbsolute;
  if (!ws) {
    return [];
  }
  const pyFiles = collectWorkflowArtifacts(ctx.instance.definition).paths.filter((p) =>
    /\.py$/i.test(p),
  );
  if (pyFiles.length === 0) {
    return [];
  }
  return lintPythonPypiSymbolsOnDisk({ workspaceRoot: ws, pyFiles });
}

export async function runPythonExportContractHardGate(
  ctx: WorkspaceLintContext,
  options?: { sliceSemantic?: string },
): Promise<PythonExportContractIssue | null> {
  if (ctx.pythonExportContractLintMode !== 'hard') {
    return null;
  }
  const issues = collectPythonExportContractIssues(ctx, options);
  return issues[0] ?? null;
}

export async function runPythonPypiSymbolHardGate(
  ctx: WorkspaceLintContext,
): Promise<PythonPypiSymbolIssue | null> {
  if (ctx.pythonPypiSymbolLintMode !== 'hard') {
    return null;
  }
  const issues = collectPythonPypiSymbolIssues(ctx);
  return issues[0] ?? null;
}

export async function runSdkPathContractHardGate(
  ctx: WorkspaceLintContext,
): Promise<SdkPathContractIssue | null> {
  if (ctx.sdkPathContractLintMode !== 'hard') {
    return null;
  }
  const files = await collectWorkspaceProjectFiles(ctx);
  const issues = collectSdkPathContractIssues(ctx, files);
  return issues[0] ?? null;
}
