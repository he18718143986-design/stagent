import { isTestRunStageId } from '../workflow/StageIdPatterns';
import { isCodeRunnerTool } from '../workflow/StageToolKinds';
import type { Stage, WorkflowDefinition } from '../WorkflowDefinition';
import { planDeclaresConftest } from '../python-bootstrap/pythonStackDetect';
import { planCompletenessMsg } from '../l10n/lintMsg';
import { codeRunnerCommandOf, writeOutputToFileOf } from '../plan-completeness/planCompletenessStageAccess';
import type { InfraChainIssue } from './InfraChainIssues';
import { withVenvPipBootstrap } from './pythonVenvCommands';
import {
  firstPythonInfraAnchorIndex,
  firstTestRunIndex,
  requiresNpmInstallServer,
  requiresPythonConftest,
  requiresPythonVenvChain,
} from './InfraChainRequirements';

const VENV_CREATE_RE = /stage_venv_create/;
const VENV_ENSURE_REQ_RE = /stage_ensure_requirements_baseline/;
const VENV_PIP_RE = /stage_venv_pip_install/;
const VENV_IMPORT_RE = /stage_venv_import_check/;
const VENV_MERGED_RE = /stage_venv_init/;

export const PYTHON_REQUIREMENTS_BASELINE_STAGE_ID = 'stage_ensure_requirements_baseline';

export const PYTHON_VENV_BASELINE_PACKAGES = ['pytest', 'numpy', 'pandas'] as const;

export type PythonVenvChainStatus = {
  create: boolean;
  pip: boolean;
  importCheck: boolean;
  merged: boolean;
};

function codeRunnerCommand(stage: Stage): string {
  if (!isCodeRunnerTool(stage.tool)) {
    return '';
  }
  return codeRunnerCommandOf(stage) ?? '';
}

/** 从已有 code-runner 命令解析 venv 目录名；默认 `.venv`。 */
export function resolveVenvDirName(stages: readonly Stage[]): string {
  for (const s of stages) {
    const cmd = codeRunnerCommand(s);
    const m = /\bpython3?\s+-m\s+venv\s+([^\s&;]+)/i.exec(cmd);
    if (m?.[1]) {
      return m[1].replace(/^['"]|['"]$/g, '');
    }
  }
  return '.venv';
}

export function resolveVenvPythonExecutable(stages: readonly Stage[]): string {
  return `${resolveVenvDirName(stages)}/bin/python`;
}

export function pythonVenvChainStatusBefore(stages: readonly Stage[], endIndex: number): PythonVenvChainStatus {
  const acc: PythonVenvChainStatus = { create: false, pip: false, importCheck: false, merged: false };
  const bound = Math.max(0, Math.min(endIndex, stages.length));
  for (let i = 0; i < bound; i++) {
    const s = stages[i]!;
    if (VENV_CREATE_RE.test(s.id)) {
      acc.create = true;
    }
    if (VENV_PIP_RE.test(s.id)) {
      acc.pip = true;
    }
    if (VENV_IMPORT_RE.test(s.id)) {
      acc.importCheck = true;
    }
    if (VENV_MERGED_RE.test(s.id)) {
      acc.merged = true;
    }
    const cmd = codeRunnerCommand(s);
    if (/\bpython3?\s+-m\s+venv\b/i.test(cmd)) {
      acc.create = true;
    }
    if (
      /\bpip3?\s+install\b/i.test(cmd) ||
      /(?:\.venv|venv)\/bin\/python\s+-m\s+pip\s+install\b/i.test(cmd)
    ) {
      acc.pip = true;
    }
    if (/(?:\.venv|venv)\/bin\/python\s+-c\s+["'].*\bimport\b/i.test(cmd)) {
      acc.importCheck = true;
    }
  }
  return acc;
}

export function pythonVenvChainComplete(status: PythonVenvChainStatus): boolean {
  return (status.create && status.pip && status.importCheck) || status.merged;
}

function isRequirementsTxtPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  return norm === 'requirements.txt' || norm.endsWith('/requirements.txt');
}

export function planDeclaresRequirementsTxt(stages: readonly Stage[]): boolean {
  return lastRequirementsTxtWriterStageId(stages) !== undefined;
}

/** 计划中最后一个声明写入 requirements.txt 的阶段 id（llm-text writeOutputToFile 或 file-write）。 */
export function lastRequirementsTxtWriterStageId(
  stages: readonly Stage[],
  endIndex?: number,
): string | undefined {
  const bound = endIndex ?? stages.length;
  let lastId: string | undefined;
  for (let i = 0; i < bound; i++) {
    const stage = stages[i]!;
    const out = writeOutputToFileOf(stage)?.trim();
    if (out && isRequirementsTxtPath(out)) {
      lastId = stage.id;
      continue;
    }
    const cfg = stage.toolConfig;
    if (
      cfg &&
      typeof cfg === 'object' &&
      'type' in cfg &&
      cfg.type === 'file-write' &&
      'filePath' in cfg &&
      typeof cfg.filePath === 'string' &&
      isRequirementsTxtPath(cfg.filePath)
    ) {
      lastId = stage.id;
    }
  }
  return lastId;
}

export function hasRequirementsBaselineStage(stages: readonly Stage[]): boolean {
  return stages.some((s) => s.id === PYTHON_REQUIREMENTS_BASELINE_STAGE_ID);
}

/** pip 是否应从 requirements.txt 安装（显式 writer 或 baseline 种子阶段）。 */
export function usesRequirementsTxtForVenvPip(stages: readonly Stage[]): boolean {
  return planDeclaresRequirementsTxt(stages) || hasRequirementsBaselineStage(stages);
}

export function resolveVenvPipInstallCommand(stages: readonly Stage[]): string {
  const py = resolveVenvPythonExecutable(stages);
  if (usesRequirementsTxtForVenvPip(stages)) {
    return withVenvPipBootstrap(py, 'pip install -r requirements.txt');
  }
  return withVenvPipBootstrap(py, 'pip install pytest');
}

export function resolveVenvImportCheckCommand(stages: readonly Stage[]): string {
  const py = resolveVenvPythonExecutable(stages);
  if (usesRequirementsTxtForVenvPip(stages)) {
    return `${py} -c "import numpy, pandas; print('Environment ready')"`;
  }
  return `${py} -c "import sys; print('Environment ready', sys.version)"`;
}

function matchingTestWriteId(testRunId: string): string | undefined {
  if (!isTestRunStageId(testRunId)) {
    return undefined;
  }
  const semantic = testRunId.replace(/^stage_test_run_/, '');
  return semantic ? `stage_test_write_${semantic}` : undefined;
}

function hasStage(stages: readonly Stage[], id: string): boolean {
  return stages.some((s) => s.id === id);
}

/** Plan completeness 用：Python 基础设施缺口。 */
export function detectPythonInfraPlanIssues(wf: WorkflowDefinition): InfraChainIssue[] {
  const issues: InfraChainIssue[] = [];
  const anchorIdx = firstPythonInfraAnchorIndex(wf);
  if (anchorIdx < 0) {
    return issues;
  }

  const stages = wf.stages ?? [];
  const venv = pythonVenvChainStatusBefore(stages, anchorIdx);
  if (!pythonVenvChainComplete(venv)) {
    issues.push({
      kind: 'missing-python-venv-chain',
      message: planCompletenessMsg(
        'missing-python-venv-chain',
        'stage_venv_create / stage_venv_pip_install / stage_venv_import_check',
      ),
    });
  }

  if (requiresPythonConftest(wf)) {
    issues.push({
      kind: 'missing-python-test-layout',
      message: planCompletenessMsg('missing-python-test-layout', 'conftest.py'),
    });
  }

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!;
    if (!isTestRunStageId(s.id)) {
      continue;
    }
    const writeId = matchingTestWriteId(s.id);
    if (!writeId) {
      continue;
    }
    const writeIdx = stages.findIndex((x) => x.id === writeId);
    if (writeIdx < 0 || writeIdx >= i) {
      continue;
    }
    const between = stages.slice(writeIdx + 1, i);
    if (!between.some((x) => x.id.startsWith('stage_verify_imports_'))) {
      issues.push({
        kind: 'missing-python-verify-imports',
        message: planCompletenessMsg('missing-python-verify-imports', writeId, s.id),
        stageId: s.id,
      });
    }
  }

  return issues;
}

/** Self-heal 审计用：注入后仍缺的链路（含 venv 链）。 */
export function detectSelfHealInfraGaps(wf: WorkflowDefinition): string[] {
  const stages = wf.stages ?? [];
  const gaps: string[] = [];

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!;
    if (!isTestRunStageId(s.id)) {
      continue;
    }
    const writeId = matchingTestWriteId(s.id);
    const writeIdx = writeId ? stages.findIndex((x) => x.id === writeId) : -1;
    if (writeIdx >= 0 && i === writeIdx + 1) {
      gaps.push(`${s.id}: 紧跟 test_write，无 verify_imports`);
    }
    const semantic = s.id.replace(/^stage_test_run_/, '') || 'x';
    if (!hasStage(stages, `stage_fix_if_failed_${semantic}`)) {
      gaps.push(`${s.id}: 缺少 stage_fix_if_failed_${semantic}`);
    }
  }

  if (requiresPythonVenvChain(wf)) {
    const anchor = firstPythonInfraAnchorIndex(wf);
    if (anchor >= 0) {
      const venv = pythonVenvChainStatusBefore(stages, anchor);
      if (!pythonVenvChainComplete(venv)) {
        gaps.push('首个 test_run 前缺少完整 Python venv 链（create/pip/import_check）');
      }
    }
  }

  const firstRun = firstTestRunIndex(wf);
  if (firstRun >= 0 && requiresNpmInstallServer(wf) && !hasStage(stages, 'stage_npm_install_server')) {
    gaps.push('首个 test_run 前缺少 stage_npm_install_server');
  }

  return gaps;
}

export {
  firstPythonInfraAnchorIndex,
  firstTestRunIndex,
  requiresNpmInstallServer,
  requiresPythonConftest,
  requiresPythonVenvChain,
  planDeclaresConftest,
};
