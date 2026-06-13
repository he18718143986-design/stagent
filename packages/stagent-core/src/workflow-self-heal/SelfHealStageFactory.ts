import type { CodeRunnerConfig, LlmTextConfig, Stage, StageInput } from '../WorkflowDefinition';
import { STAGE_TOOL_CODE_RUNNER, STAGE_TOOL_LLM_TEXT } from '../workflow/StageToolKinds';
import { VERIFY_OUT_OUTPUT_KEY } from '../WorkflowOutputKeys';
import {
  implStageIdFromSemanticName,
  isTestRunStageId,
  semanticNameFromTestRunStageId,
  testWriteStageIdFromSemanticName,
} from '../workflow/StageIdPatterns';
import { buildNodeExtensionScriptCommand } from '../contract-infra';
import { VENV_CREATE_RESILIENT_COMMAND } from '../contract-infra/pythonVenvCommands';

export function isBundleWriteStageId(stageId: string): boolean {
  return stageId.endsWith('_stagent_bundle_write');
}

export function isSelfHealStageId(stageId: string): boolean {
  return (
    stageId.startsWith('stage_verify_') ||
    stageId.startsWith('stage_fix_if_failed_') ||
    stageId.startsWith('stage_materialize_stub_') ||
    stageId === 'stage_npm_install_server' ||
    stageId === 'stage_venv_create' ||
    stageId === 'stage_ensure_requirements_baseline' ||
    stageId === 'stage_venv_pip_install' ||
    stageId === 'stage_venv_import_check'
  );
}

function codeRunnerStage(opts: {
  id: string;
  title: string;
  description: string;
  command: string;
  dependsOn?: string[];
  input?: StageInput;
}): Stage {
  const toolConfig: CodeRunnerConfig = {
    type: STAGE_TOOL_CODE_RUNNER,
    command: opts.command,
    captureOutput: true,
    pathBase: 'workspace',
    workingDir: '.',
  };
  return {
    id: opts.id,
    title: opts.title,
    description: opts.description,
    tool: STAGE_TOOL_CODE_RUNNER,
    toolConfig,
    ...(opts.dependsOn?.length ? { dependsOn: opts.dependsOn } : {}),
    input: opts.input ?? { sources: [], mergeStrategy: 'concat' },
    outputs: [{ key: VERIFY_OUT_OUTPUT_KEY, format: 'text' }],
    pauseAfter: false,
    meta: { executionMode: 'deterministic' },
  };
}

export function buildNpmInstallServerStage(dependsOn: string[]): Stage {
  return codeRunnerStage({
    id: 'stage_npm_install_server',
    title: '安装服务端依赖（首个 test_run 前）',
    description: '在 server/ 执行 npm install，确保 Jest 与测试依赖可用。',
    command: 'cd server && npm install',
    dependsOn,
  });
}

export function buildVerifyServerTscStage(opts: {
  id: string;
  title: string;
  dependsOn: string[];
}): Stage {
  return codeRunnerStage({
    id: opts.id,
    title: opts.title,
    description: '运行 tsc --noEmit；失败时由后续 fix 阶段修复。',
    command: 'cd server && npx tsc --noEmit',
    dependsOn: opts.dependsOn,
  });
}

export function buildVerifyImportsStage(opts: {
  id: string;
  title: string;
  testFiles: string[];
  dependsOn: string[];
}): Stage {
  return codeRunnerStage({
    id: opts.id,
    title: opts.title,
    description: '校验测试文件存在；Node/TS 项目内 import 路径（extension 脚本）。',
    command: buildNodeExtensionScriptCommand('verify-test-imports.mjs', opts.testFiles),
    dependsOn: opts.dependsOn,
  });
}

export function buildFixIfFailedStage(opts: {
  id: string;
  title: string;
  testRunStageId: string;
  verifyTscStageId: string;
  dependsOn: string[];
  writeTargets: string[];
}): Stage {
  const semantic = semanticNameFromTestRunStageId(opts.testRunStageId) ?? 'unknown';
  const toolConfig: LlmTextConfig = {
    type: STAGE_TOOL_LLM_TEXT,
    systemPrompt: [
      `测试阶段 stage_test_run_${semantic} 失败后执行修复。`,
      '步骤：1) 阅读上一 test_run 与 tsc 输出；2) 修复缺失文件、错误 import、类型错误；3) 优先保证 server/src/app.ts 导出 startServer/stopServer/clearRedisQueues/setTestMode。',
      `可修改文件：${opts.writeTargets.join('、') || 'server/src 下相关文件'}。`,
      '只输出需要写入的完整文件内容到 writeOutputToFile 指定路径；禁止 Markdown 围栏。',
    ].join('\n'),
    writeOutputToFile: opts.writeTargets[0],
    writePathBase: 'workspace',
  };
  return {
    id: opts.id,
    title: opts.title,
    description: 'test_run 失败后：根据 tsc 与测试输出修复代码，供重试 test_run。',
    tool: STAGE_TOOL_LLM_TEXT,
    toolConfig,
    dependsOn: opts.dependsOn,
    input: {
      sources: [
        {
          type: 'stage-output',
          stageId: opts.testRunStageId,
          outputKey: VERIFY_OUT_OUTPUT_KEY,
          label: 'test_run 输出',
        },
        {
          type: 'stage-output',
          stageId: opts.verifyTscStageId,
          outputKey: VERIFY_OUT_OUTPUT_KEY,
          label: 'tsc 诊断',
        },
      ],
      mergeStrategy: 'concat',
    },
    outputs: [{ key: 'fixPatch', format: 'text' }],
    pauseAfter: false,
  };
}

export function buildServerAppEntryStage(dependsOn: string[]): Stage {
  const toolConfig: LlmTextConfig = {
    type: STAGE_TOOL_LLM_TEXT,
    systemPrompt: [
      '生成 server/src/app.ts：从 index.ts 拆分测试/生产共用逻辑。',
      '必须导出：setTestMode, clearRedisQueues, startServer(port), stopServer。',
      'startServer 创建 express+socket.io，连接时下发 identity 消息，处理 match_request/chat_message 等。',
      'index.ts 仅 import startProductionServer 并监听 PORT。',
      '输出纯 TypeScript，无 Markdown 围栏。',
    ].join('\n'),
    writeOutputToFile: 'server/src/app.ts',
    writePathBase: 'workspace',
  };
  return {
    id: 'stage_impl_server_app',
    title: '实现 server/src/app.ts（测试入口拆分）',
    description: '补齐集成测试所需的 app 导出，避免测试 import ../src/app 失败。',
    tool: STAGE_TOOL_LLM_TEXT,
    toolConfig,
    dependsOn,
    input: {
      sources: [
        {
          type: 'stage-output',
          stageId: 'stage_decide_architecture_overview',
          outputKey: 'decisionRecord',
          label: '架构决策',
        },
      ],
      mergeStrategy: 'concat',
    },
    outputs: [{ key: 'appTs', format: 'text' }],
    pauseAfter: false,
  };
}

export function buildVerifyPythonImportsStage(opts: {
  id: string;
  title: string;
  testFiles: string[];
  dependsOn: string[];
  strict?: boolean;
}): Stage {
  const args = opts.strict ? ['--strict', ...opts.testFiles] : opts.testFiles;
  return codeRunnerStage({
    id: opts.id,
    title: opts.title,
    description: opts.strict
      ? 'pre-impl strict：校验测试文件与项目内模块存在（stub 物化后）。'
      : 'pre-impl：校验测试文件存在；stdlib/第三方按 SSOT 跳过；项目内模块 soft-skip（§5.6#6，由 test_run 承接）。',
    command: buildNodeExtensionScriptCommand('verify-python-test-imports.mjs', args),
    dependsOn: opts.dependsOn,
  });
}

export function buildVenvCreateStage(dependsOn: string[]): Stage {
  return codeRunnerStage({
    id: 'stage_venv_create',
    title: '创建 Python venv',
    description:
      'python3 -m venv .venv（缺 python3-venv 时 fallback --without-pip），供后续 pip / pytest 使用。',
    command: VENV_CREATE_RESILIENT_COMMAND,
    dependsOn,
  });
}

export function buildEnsureRequirementsBaselineStage(dependsOn: string[]): Stage {
  return codeRunnerStage({
    id: 'stage_ensure_requirements_baseline',
    title: '确保 requirements.txt 基线依赖',
    description: '合并 pytest / numpy / pandas 到 requirements.txt，供 venv pip 安装。',
    command: buildNodeExtensionScriptCommand('ensure-python-requirements-baseline.mjs', []),
    dependsOn,
  });
}

export function buildVenvPipInstallStage(dependsOn: string[], pipCommand: string): Stage {
  return codeRunnerStage({
    id: 'stage_venv_pip_install',
    title: '安装 Python 依赖（venv pip）',
    description: '在 .venv 内安装 requirements 或 pytest。',
    command: pipCommand,
    dependsOn,
  });
}

export function buildVenvImportCheckStage(dependsOn: string[], importCmd?: string): Stage {
  const cmd =
    importCmd ??
    '.venv/bin/python -c "import sys; print(\'Environment ready\', sys.version)"';
  return codeRunnerStage({
    id: 'stage_venv_import_check',
    title: '验证 Python venv 可 import 关键依赖',
    description: 'venv import check：确认 requirements 中关键包可 import。',
    command: cmd,
    dependsOn,
  });
}

export function buildPythonFixIfFailedStage(opts: {
  id: string;
  title: string;
  testRunStageId: string;
  dependsOn: string[];
  writeTargets: string[];
}): Stage {
  const semantic = semanticNameFromTestRunStageId(opts.testRunStageId) ?? 'unknown';
  const additional = opts.writeTargets.slice(1);
  const toolConfig: LlmTextConfig = {
    type: STAGE_TOOL_LLM_TEXT,
    systemPrompt: [
      `测试阶段 stage_test_run_${semantic} 失败后执行修复（Python 栈）。`,
      '步骤：1) 阅读 test_run 输出；2) 按 R3b 路由修复 impl 与 requirements.txt；3) 对齐 test 与 impl API。',
      `可修改文件：${opts.writeTargets.join('、') || '工作区 .py 与 requirements.txt'}。`,
      '多文件输出格式（必须）：',
      `--- file: ${opts.writeTargets[0] ?? 'impl.py'} ---`,
      '<impl 全文>',
      ...additional.flatMap((t) => [`--- file: ${t} ---`, `<${t} 全文>`]),
      '禁止 Markdown 围栏；禁止静默 import 未在 decisionArtifacts.dependencies 声明的第三方包。',
    ].join('\n'),
    writeOutputToFile: opts.writeTargets[0],
    writePathBase: 'workspace',
    additionalWriteTargets: additional.length > 0 ? additional : undefined,
    multiFileOutputFormat: additional.length > 0 ? 'delimited' : undefined,
  };
  return {
    id: opts.id,
    title: opts.title,
    description: 'pytest 失败后：根据测试输出修复 Python 代码与依赖。',
    tool: STAGE_TOOL_LLM_TEXT,
    toolConfig,
    dependsOn: opts.dependsOn,
    input: {
      sources: [
        {
          type: 'stage-output',
          stageId: opts.testRunStageId,
          outputKey: VERIFY_OUT_OUTPUT_KEY,
          label: 'test_run 输出',
        },
      ],
      mergeStrategy: 'concat',
    },
    outputs: [{ key: 'fixPatch', format: 'text' }],
    pauseAfter: false,
  };
}

export function readLlmTextWriteOutputPath(stage: Stage | undefined): string | undefined {
  const toolConfig = stage?.toolConfig;
  if (toolConfig?.type !== STAGE_TOOL_LLM_TEXT) {
    return undefined;
  }
  const path = toolConfig.writeOutputToFile?.trim();
  return path || undefined;
}

function findStageById(stages: readonly Stage[], stageId: string): Stage | undefined {
  return stages.find((s) => s.id === stageId);
}

export function inferPythonTestFile(testRunStageId: string): string | undefined {
  if (!isTestRunStageId(testRunStageId)) {
    return undefined;
  }
  const semantic = semanticNameFromTestRunStageId(testRunStageId);
  if (!semantic) {
    return undefined;
  }
  return `tests/test_${semantic}.py`;
}

/** 优先读配对 test_write 的 writeOutputToFile，避免 tests/test_${semantic}.py 与真实文件名不一致。 */
export function resolvePythonTestFileForVerify(
  testRunStageId: string,
  stages: readonly Stage[],
): string | undefined {
  const semantic = semanticNameFromTestRunStageId(testRunStageId);
  if (!semantic) {
    return undefined;
  }
  const fromWrite = readLlmTextWriteOutputPath(
    findStageById(stages, testWriteStageIdFromSemanticName(semantic)),
  );
  if (fromWrite) {
    return fromWrite;
  }
  return inferPythonTestFile(testRunStageId);
}

export function resolveServerTestFileForVerify(
  testRunStageId: string,
  stages: readonly Stage[],
): string | undefined {
  const semantic = semanticNameFromTestRunStageId(testRunStageId);
  if (!semantic) {
    return undefined;
  }
  const fromWrite = readLlmTextWriteOutputPath(
    findStageById(stages, testWriteStageIdFromSemanticName(semantic)),
  );
  if (fromWrite) {
    return fromWrite;
  }
  return inferServerTestFile(testRunStageId);
}

/** Python fix 阶段默认修改 impl 产物，而非 test 文件。 */
export function resolvePythonImplFileForFix(
  testRunStageId: string,
  stages: readonly Stage[],
): string | undefined {
  const semantic = semanticNameFromTestRunStageId(testRunStageId);
  if (!semantic) {
    return undefined;
  }
  const fromImpl = readLlmTextWriteOutputPath(
    findStageById(stages, implStageIdFromSemanticName(semantic)),
  );
  if (fromImpl) {
    return fromImpl;
  }
  const testFile = resolvePythonTestFileForVerify(testRunStageId, stages);
  if (testFile?.startsWith('tests/test_')) {
    return testFile.replace(/^tests\/test_/, '');
  }
  return `${semantic}.py`;
}

export function inferServerTestFile(testRunStageId: string): string | undefined {
  if (!isTestRunStageId(testRunStageId)) {
    return undefined;
  }
  const semantic = semanticNameFromTestRunStageId(testRunStageId);
  if (!semantic) {
    return undefined;
  }
  if (/_(ui|call_ui)$/.test(semantic) || semantic === 'all_tests') {
    return undefined;
  }
  return `server/__tests__/${semantic}.test.ts`;
}
