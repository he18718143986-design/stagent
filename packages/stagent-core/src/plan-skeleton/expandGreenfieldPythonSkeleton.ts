import * as crypto from 'node:crypto';
import type { Stage, StageOutput, WorkflowDefinition } from '../WorkflowDefinition';
import { DEFAULT_TOOL_PATH_BASE } from '../WorkflowDefinition';
import { DECISION_ARTIFACTS_OUTPUT_KEY, PRIMARY_DECISION_OUTPUT_KEY } from '../WorkflowOutputKeys';
import {
  implStageIdFromSemanticName,
  testRunStageIdFromSemanticName,
  testWriteStageIdFromSemanticName,
} from '../workflow/StageIdPatterns';
import {
  GLOBAL_CONFIG_DECIDE_STAGE_ID,
  GREENFIELD_PYTHON_SKELETON_VERSION,
  SKELETON_PROMPT_PLACEHOLDER_PREFIX,
} from './constants';
import { extractPythonSliceModules, orderEntrySliceLast } from './extractPythonSliceModules';
import { applySemanticFillToSkeleton } from './applySemanticFillToSkeleton';
import { sanitizeSemanticFillWorkflow } from './sanitizeSemanticFillPrompts';
import {
  BEHAVIOR_SPEC_SLICE_SUFFIX,
  DECISION_ARTIFACTS_PROMPT_SUFFIX,
  SLICE_MODULE_CONTRACT_SUFFIX,
} from '../commitment/parseDecisionArtifacts';
import { BEHAVIOR_SPEC_REQUIRED_SLICES } from '../commitment/behaviorSpecSchema';

export interface ExpandGreenfieldPythonSkeletonInput {
  userInput: string;
  taskType?: string;
  title?: string;
  workflowId?: string;
  modules?: string[];
  /** 可选：按 stage id 覆盖 systemPrompt（语义填充）。 */
  stagePrompts?: Record<string, string>;
  isGreenfield?: boolean;
}

export interface ExpandGreenfieldPythonSkeletonResult {
  workflow: WorkflowDefinition;
  modules: string[];
  skeletonVersion: string;
}

function placeholderPrompt(label: string): string {
  return `${SKELETON_PROMPT_PLACEHOLDER_PREFIX} ${label}`;
}

function implWritePath(semantic: string): string {
  if (semantic === 'main') {
    return 'main.py';
  }
  return `${semantic}/__init__.py`;
}

function llmTextStage(opts: {
  id: string;
  title: string;
  systemPrompt: string;
  outputs: StageOutput[];
  dependsOn?: string[];
  isDecisionStage?: boolean;
  writeOutputToFile?: string;
  pauseAfter?: boolean;
}): Stage {
  const toolConfig: Stage['toolConfig'] = {
    type: 'llm-text',
    systemPrompt: opts.systemPrompt,
    writePathBase: DEFAULT_TOOL_PATH_BASE,
  };
  if (opts.writeOutputToFile?.trim()) {
    (toolConfig as { writeOutputToFile?: string }).writeOutputToFile = opts.writeOutputToFile.trim();
  }
  return {
    id: opts.id,
    title: opts.title,
    description: opts.title,
    tool: 'llm-text',
    toolConfig,
    input: {
      sources: [{ type: 'user-input', label: '用户需求' }],
      mergeStrategy: 'concat',
    },
    outputs: opts.outputs,
    pauseAfter: opts.pauseAfter ?? false,
    isDecisionStage: opts.isDecisionStage,
    dependsOn: opts.dependsOn,
  };
}

function buildGlobalArchitectureDecideStage(): Stage {
  return llmTextStage({
    id: GLOBAL_CONFIG_DECIDE_STAGE_ID,
    title: '全局架构决策',
    systemPrompt: `${placeholderPrompt(
      '输出全局架构 DecisionRecord，并附 decisionArtifacts sidecar（须含 key=configContent → config.yaml，以及全部切片的 modules[] 接口表）。',
    )}${DECISION_ARTIFACTS_PROMPT_SUFFIX}`,
    isDecisionStage: true,
    pauseAfter: true,
    outputs: [
      { key: PRIMARY_DECISION_OUTPUT_KEY, format: 'markdown' },
      { key: DECISION_ARTIFACTS_OUTPUT_KEY, format: 'json' },
    ],
  });
}

function buildSliceDecideStage(semantic: string, dependsOn: string): Stage {
  const behaviorSuffix = (BEHAVIOR_SPEC_REQUIRED_SLICES as readonly string[]).includes(semantic)
    ? BEHAVIOR_SPEC_SLICE_SUFFIX
    : '';
  return llmTextStage({
    id: `stage_decide_${semantic}`,
    title: `决策 · ${semantic}`,
    systemPrompt: `${placeholderPrompt(
      `模块 ${semantic} 边界与接口合约（DecisionRecord + decisionArtifacts.modules 单条）。`,
    )}${SLICE_MODULE_CONTRACT_SUFFIX}${behaviorSuffix}`,
    isDecisionStage: true,
    pauseAfter: true,
    dependsOn: [dependsOn],
    outputs: [
      { key: PRIMARY_DECISION_OUTPUT_KEY, format: 'markdown' },
      { key: DECISION_ARTIFACTS_OUTPUT_KEY, format: 'json' },
    ],
  });
}

function buildTestWriteStage(semantic: string, dependsOn: string): Stage {
  const testPath = `tests/test_${semantic}.py`;
  return llmTextStage({
    id: testWriteStageIdFromSemanticName(semantic)!,
    title: `写测试 · ${semantic}`,
    systemPrompt: placeholderPrompt(`为 ${semantic} 编写 pytest（RED，测行为不测实现）。`),
    writeOutputToFile: testPath,
    dependsOn: [dependsOn],
    outputs: [{ key: 'code', format: 'text' }],
  });
}

function buildImplStage(semantic: string, dependsOn: string): Stage {
  return llmTextStage({
    id: implStageIdFromSemanticName(semantic)!,
    title: `实现 · ${semantic}`,
    systemPrompt: placeholderPrompt(`实现模块 ${semantic}（GREEN），遵循已批准 DecisionRecord。`),
    writeOutputToFile: implWritePath(semantic),
    dependsOn: [dependsOn],
    outputs: [{ key: 'code', format: 'text' }],
  });
}

function buildTestRunStage(semantic: string, dependsOn: string): Stage {
  const testPath = `tests/test_${semantic}.py`;
  return {
    id: testRunStageIdFromSemanticName(semantic)!,
    title: `跑测试 · ${semantic}`,
    description: `pytest · ${semantic}`,
    tool: 'code-runner',
    toolConfig: {
      type: 'code-runner',
      command: `.venv/bin/python -m pytest -q ${testPath}`,
      captureOutput: true,
      pathBase: DEFAULT_TOOL_PATH_BASE,
      workingDir: '.',
      // T4 Run #32：broker 死锁 pytest 挂满 60s → code-runner-timeout；放宽并留给 fix 链收敛。
      timeout: 120,
    },
    input: {
      sources: [{ type: 'user-input', label: '用户需求' }],
      mergeStrategy: 'concat',
    },
    outputs: [{ key: 'testLog', format: 'text' }],
    pauseAfter: false,
    dependsOn: [dependsOn],
  };
}

function buildWriteConfigStage(dependsOn: string): Stage {
  return {
    id: 'stage_write_config',
    title: '写入 config.yaml',
    description: '从全局决策 decisionArtifacts 落盘 config.yaml',
    tool: 'file-write',
    toolConfig: {
      type: 'file-write',
      filePath: 'config.yaml',
      pathBase: DEFAULT_TOOL_PATH_BASE,
      sourceStageId: GLOBAL_CONFIG_DECIDE_STAGE_ID,
      sourceOutputKey: 'configContent',
    },
    input: { sources: [], mergeStrategy: 'concat' },
    outputs: [{ key: 'writeLog', format: 'text' }],
    pauseAfter: false,
    dependsOn: [dependsOn],
  };
}

/**
 * 展开绿场 Python 多模块标准 DAG（固定边 + 占位 prompt）。
 * Plan Compiler（sanitize / disk-bootstrap / self-heal）在执行前注入 venv / verify / delivery。
 */
export function expandGreenfieldPythonSkeleton(
  input: ExpandGreenfieldPythonSkeletonInput,
): ExpandGreenfieldPythonSkeletonResult {
  const taskType = input.taskType ?? 'software';
  // 入口切片（main）恒排末位：集成切片须在依赖切片之后实现/验证（forward-slice import）。
  // input.modules 来自 LLM 架构决策时可能把 main 列在前，此处做确定性兜底重排。
  const modules = orderEntrySliceLast(
    input.modules && input.modules.length > 0
      ? input.modules
      : extractPythonSliceModules(input.userInput, taskType),
  );

  if (modules.length < 4) {
    throw new Error(
      `expandGreenfieldPythonSkeleton: need >=4 slice modules, got ${modules.length} (${modules.join(', ')})`,
    );
  }

  const stages: Stage[] = [buildGlobalArchitectureDecideStage()];
  let prevAnchor = GLOBAL_CONFIG_DECIDE_STAGE_ID;

  for (const semantic of modules) {
    const decideId = `stage_decide_${semantic}`;
    stages.push(buildSliceDecideStage(semantic, prevAnchor));
    prevAnchor = decideId;
    stages.push(buildTestWriteStage(semantic, prevAnchor));
    const testWriteId = testWriteStageIdFromSemanticName(semantic)!;
    stages.push(buildImplStage(semantic, testWriteId));
    const implId = implStageIdFromSemanticName(semantic)!;
    stages.push(buildTestRunStage(semantic, implId));
    prevAnchor = testRunStageIdFromSemanticName(semantic)!;
  }

  stages.push(buildWriteConfigStage(prevAnchor));

  let workflow: WorkflowDefinition = {
    id: input.workflowId ?? `wf_skeleton_${crypto.randomUUID()}`,
    version: '2.0',
    meta: {
      title: input.title ?? '绿场 Python 多模块（骨架模板）',
      taskType,
      userInput: input.userInput,
      createdAt: new Date().toISOString(),
      isGreenfield: input.isGreenfield ?? true,
      workflowTemplate: 'greenfield_full',
      skeletonVersion: GREENFIELD_PYTHON_SKELETON_VERSION,
      engineAutoInsertedGlobalArchitectureStageId: GLOBAL_CONFIG_DECIDE_STAGE_ID,
    },
    globalConfig: {
      language: 'python',
      stackProfile: 'python',
    },
    stages,
  };

  if (input.stagePrompts && Object.keys(input.stagePrompts).length > 0) {
    workflow = applySemanticFillToSkeleton(workflow, input.stagePrompts);
    workflow = sanitizeSemanticFillWorkflow(workflow);
  }

  return {
    workflow,
    modules,
    skeletonVersion: GREENFIELD_PYTHON_SKELETON_VERSION,
  };
}
