/* ------------------------------------------------------------------ */
/*  异族出题人（M-role-model-routing）：                                 */
/*  1. classifyStageRoleFromId / modelFamilyHintForStageId 纯函数；      */
/*  2. readPreferredModelByRole 配置读取的健壮性；                       */
/*  3. CoreLlmInvoker 按角色选模型：覆盖命中用专属模型，未配置/未命中     */
/*     回退全局 preferredModelFamily（零配置时行为与历史一致）。          */
/* ------------------------------------------------------------------ */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyStageRoleFromId,
  modelFamilyHintForStageId,
} from '../AgentSpecializationRouter';
import { readPreferredModelByRole } from '../StagentSettings';
import { createCoreLlmInvoker } from '../core/CoreLlmInvoker';
import type { LlmModel, PlatformAdapter, ConfigPort } from '../platform/PlatformAdapter';

/* ---------------- 纯函数：角色分类 ---------------- */

test('classifyStageRoleFromId maps id prefixes to roles', () => {
  assert.equal(classifyStageRoleFromId('stage_test_write_indicators'), 'test-write');
  assert.equal(classifyStageRoleFromId('stage_impl_indicators'), 'implementation');
  assert.equal(classifyStageRoleFromId('stage_decide_api'), 'decision');
  assert.equal(classifyStageRoleFromId('stage_zoom_out'), 'lightweight');
  assert.equal(classifyStageRoleFromId('stage_doc_overview'), 'lightweight');
  // test_run 及其派生 trace（fix / gate-repair）→ default（沿用全局模型，不误用出题模型）
  assert.equal(classifyStageRoleFromId('stage_test_run_indicators'), 'default');
  assert.equal(classifyStageRoleFromId('stage_test_run_indicators:gate-repair'), 'default');
  assert.equal(classifyStageRoleFromId('workflow_generation'), 'default');
});

test('classifyStageRoleFromId routes main integration impl/fix to integration role (Run #65)', () => {
  // 集成切片 main：impl / fix / 三级 replan-fix → integration
  assert.equal(classifyStageRoleFromId('stage_impl_main'), 'integration');
  assert.equal(classifyStageRoleFromId('stage_fix_if_failed_main'), 'integration');
  assert.equal(classifyStageRoleFromId('stage_runtime_replan_fix_main'), 'integration');
  assert.equal(classifyStageRoleFromId('stage_runtime_replan_testfix_main'), 'integration');
  assert.equal(classifyStageRoleFromId('stage_runtime_replan_posttestfix_fix_main'), 'integration');
  // 组合后缀容忍
  assert.equal(classifyStageRoleFromId('stage_fix_if_failed_main:gate-repair'), 'integration');
  // 叶子切片不受影响：impl 仍 implementation，test_write_main 仍 test-write
  assert.equal(classifyStageRoleFromId('stage_impl_indicators'), 'implementation');
  assert.equal(classifyStageRoleFromId('stage_fix_if_failed_indicators'), 'default');
  assert.equal(classifyStageRoleFromId('stage_test_write_main'), 'test-write');
});

test('modelFamilyHintForStageId resolves integration role override (Run #65)', () => {
  const overrides = { integration: 'direct:pro' } as const;
  assert.equal(modelFamilyHintForStageId('stage_impl_main', overrides), 'direct:pro');
  assert.equal(modelFamilyHintForStageId('stage_fix_if_failed_main', overrides), 'direct:pro');
  // 叶子 impl 不命中 integration
  assert.equal(modelFamilyHintForStageId('stage_impl_indicators', overrides), undefined);
});

test('modelFamilyHintForStageId resolves only configured roles', () => {
  const overrides = { 'test-write': 'direct:glm-4' } as const;
  assert.equal(
    modelFamilyHintForStageId('stage_test_write_signals', overrides),
    'direct:glm-4',
  );
  assert.equal(modelFamilyHintForStageId('stage_impl_signals', overrides), undefined);
  assert.equal(modelFamilyHintForStageId('stage_test_run_signals', overrides), undefined);
  // 空白值视为未配置
  assert.equal(
    modelFamilyHintForStageId('stage_test_write_signals', { 'test-write': '  ' }),
    undefined,
  );
});

/* ---------------- 配置读取 ---------------- */

function cfgWith(values: Record<string, unknown>): ConfigPort {
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return key in values ? (values[key] as T) : defaultValue;
    },
  } as ConfigPort;
}

test('readPreferredModelByRole reads llmModelByRole and ignores junk', () => {
  assert.deepEqual(readPreferredModelByRole(cfgWith({})), {});
  assert.deepEqual(
    readPreferredModelByRole(cfgWith({ llmModelByRole: { 'test-write': 'direct:glm-4' } })),
    { 'test-write': 'direct:glm-4' },
  );
  // 非法形态：数组 / 非对象 / 非字符串值 / 未知角色键 → 安全忽略
  assert.deepEqual(readPreferredModelByRole(cfgWith({ llmModelByRole: ['x'] })), {});
  assert.deepEqual(readPreferredModelByRole(cfgWith({ llmModelByRole: 'direct:x' })), {});
  assert.deepEqual(
    readPreferredModelByRole(
      cfgWith({ llmModelByRole: { 'test-write': 42, unknown_role: 'direct:y' } }),
    ),
    {},
  );
});

/* ---------------- CoreLlmInvoker 路由 ---------------- */

function fakeModel(family: string, reply: string): LlmModel {
  return {
    id: `fake:${family}`,
    family,
    name: family,
    structuredOutput: true,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *sendRequest(): AsyncGenerator<string> {
      yield reply;
    },
  } as unknown as LlmModel;
}

function fakePlatform(models: LlmModel[], configValues: Record<string, unknown>): PlatformAdapter {
  return {
    config: cfgWith(configValues),
    llm: {
      async listModels(filter?: { family?: string }): Promise<LlmModel[]> {
        const family = filter?.family?.trim();
        if (family) {
          return models.filter((m) => m.family === family);
        }
        return models;
      },
    },
  } as unknown as PlatformAdapter;
}

function makeInvoker(models: LlmModel[], configValues: Record<string, unknown>) {
  return createCoreLlmInvoker({
    platform: fakePlatform(models, configValues),
    getPreferredModelFamily: () => 'direct:main-model',
    sendBackendMessage: () => {},
    debug: { llmTraceLog: () => {}, logUserAction: () => {} },
  });
}

const MAIN = fakeModel('direct:main-model', 'from-main');
const TESTW = fakeModel('direct:test-writer', 'from-test-writer');

test('invoker uses role model for test_write stage when configured', async () => {
  const invoke = makeInvoker([MAIN, TESTW], {
    llmApiKey: 'k',
    llmModelByRole: { 'test-write': 'direct:test-writer' },
  });
  assert.equal(await invoke('sys', 'user', 'stage_test_write_indicators'), 'from-test-writer');
  // impl 阶段不受影响，仍用全局模型
  assert.equal(await invoke('sys', 'user', 'stage_impl_indicators'), 'from-main');
});

test('invoker routes main integration impl/fix to integration model (Run #65)', async () => {
  const invoke = makeInvoker([MAIN, TESTW], {
    llmApiKey: 'k',
    llmModelByRole: { 'test-write': 'direct:test-writer', integration: 'direct:test-writer' },
  });
  // 集成切片 impl/fix → 出题人(强)模型
  assert.equal(await invoke('sys', 'user', 'stage_impl_main'), 'from-test-writer');
  assert.equal(await invoke('sys', 'user', 'stage_fix_if_failed_main'), 'from-test-writer');
  // 叶子切片 impl 仍用全局 flash
  assert.equal(await invoke('sys', 'user', 'stage_impl_indicators'), 'from-main');
});

test('invoker falls back to global family when role not configured (zero-config 现状)', async () => {
  const invoke = makeInvoker([MAIN, TESTW], { llmApiKey: 'k' });
  assert.equal(await invoke('sys', 'user', 'stage_test_write_indicators'), 'from-main');
  assert.equal(await invoke('sys', 'user', 'stage_impl_indicators'), 'from-main');
});

test('invoker falls back to global family when role family has no model', async () => {
  const invoke = makeInvoker([MAIN], {
    llmApiKey: 'k',
    llmModelByRole: { 'test-write': 'direct:not-registered' },
  });
  assert.equal(await invoke('sys', 'user', 'stage_test_write_indicators'), 'from-main');
});
