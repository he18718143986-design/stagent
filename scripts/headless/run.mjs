#!/usr/bin/env node
/**
 * Headless workflow feedback loop — no Electron, mock LLM by default.
 *
 * Usage:
 *   npm run feedback              # build core + mock journey (~10s)
 *   npm run feedback:quick        # skip build, mock only
 *   npm run feedback:live         # real API tier T1 (DEEPSEEK_API_KEY or LLM_API_KEY)
 *   npm run feedback:live:all     # real API tiers T1→T2→T3→T4→T5(charter suggest)
 *
 * Options:
 *   --scenario construct|polish|generate|execute|charter-suggest|charter-auto|all   (default: all)
 *   --live-tier 1|2|3|4|5|all   live execute 任务档位（T4=南华期货；T5=T4+charter suggest）
 *   --keep          retain temp workspace for inspection
 *   --workspace P   use fixed workspace path
 *   --json          machine-readable stdout only
 *   --with-unit     also run @stagent/core unit tests
 *   --repeat N      批量跑批：同一套 scenario 连跑 N 次，输出成功率汇总
 *                   （artifacts/headless-batch.json + artifacts/batch/run-<i>.json）
 *   --pass-threshold M   批量判定阈值：通过次数 ≥ M 则 exit 0（默认 ceil(0.6*N)，
 *                        对齐 §6.1 成功率口径 N=5 ≥3）
 *
 * Env:
 *   HEADLESS_VERBOSE=1          逐步 phase/backend 日志打到 stderr
 *   LLM_BASE_URL                支持官网 https://api.deepseek.com（自动补 /v1）
 *   LLM_MODEL_TEST_WRITE        可选：test_write 阶段专属模型（异族出题人；不设=单模型）
 *   LLM_BASE_URL_TEST_WRITE     可选：test_write 模型 baseUrl（缺省回退 LLM_BASE_URL）
 *   LLM_API_KEY_TEST_WRITE      可选：test_write 模型 API key（缺省回退主 key）
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkflowEngine, buildDecisionLintRetryUserComment } from '@stagent/core'
import { createHeadlessPlatform, findArtifacts, tailDebugLog } from './lib/headless-platform.mjs'
import {
  CHARTER_REL_PATH,
  LIVE_TASK_TIERS,
  copyCharterToWorkspace,
  defaultT4Workspace,
  isT4FamilyTier,
  prepareT4IterWorkspace,
  findResumableInstance,
  resolveLiveTiers,
} from './lib/live-tasks.mjs'
import { MOCK_MODEL_ID, startMockLlmServer } from './lib/mock-llm-server.mjs'
import { normalizeLlmBaseUrl } from './lib/normalize-base-url.mjs'
import { runCharterSuggestSmoke } from './lib/charter-suggest-smoke.mjs'
import { runCharterAutoEscalationSmoke } from './lib/charter-auto-escalation-smoke.mjs'
import { RunTrace } from './lib/trace.mjs'
import { assertStrictMvpPass } from './lib/mvp-acceptance.mjs'
import { checkDemoDelivery } from './lib/demo-delivery-acceptance.mjs'
import { promoteIterToT4Root } from './lib/promote-workspace.mjs'
import { createLlmUsageMeter, formatUsageLine } from './lib/llm-usage.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

/** Load autoAI/.env.local (gitignored) — KEY=value per line, no export prefix. */
function loadEnvLocal() {
  const envPath = path.join(REPO_ROOT, '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts')
const REPORT_PATH = path.join(ARTIFACTS_DIR, 'headless-feedback.json')
const TRACE_PATH = path.join(ARTIFACTS_DIR, 'headless-feedback.trace.jsonl')
const BATCH_DIR = path.join(ARTIFACTS_DIR, 'batch')
const BATCH_REPORT_PATH = path.join(ARTIFACTS_DIR, 'headless-batch.json')

const MOCK_EXECUTE_TASK = {
  id: 'execute',
  label: 'Mock prototype 三文件闭环',
  taskType: 'prototype',
  userInput:
    '读取本地 input.xlsx，抓取线上价格库存并对比，导出 diff 结果 CSV（headless feedback）',
  polish: false,
  timeoutMs: 60_000,
  pass: { terminal: 'workflowCompleted', artifactCheck: true },
}

const EXPECTED_ARTIFACTS = ['requirements.txt', 'writer.py', 'main.py']

function parseArgs(argv) {
  const opts = {
    live: false,
    keep: false,
    json: false,
    withUnit: false,
    scenario: 'all',
    liveTier: '1',
    workspace: undefined,
    resume: false,
    repeat: 1,
    passThreshold: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--live') opts.live = true
    else if (a === '--keep') opts.keep = true
    else if (a === '--resume') opts.resume = true
    else if (a === '--json') opts.json = true
    else if (a === '--with-unit') opts.withUnit = true
    else if (a === '--scenario') opts.scenario = argv[++i] ?? 'all'
    else if (a === '--live-tier') opts.liveTier = argv[++i] ?? '1'
    else if (a === '--workspace') opts.workspace = argv[++i]
    else if (a === '--repeat') opts.repeat = Math.max(1, Number(argv[++i]) || 1)
    else if (a === '--pass-threshold') opts.passThreshold = Math.max(1, Number(argv[++i]) || 1)
  }
  return opts
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function gitShortCommit() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

function msgType(m) {
  return typeof m === 'object' && m !== null && 'type' in m ? String(m.type) : 'unknown'
}

function matchesTerminalType(actual, expected) {
  if (Array.isArray(expected)) {
    return expected.includes(actual)
  }
  return actual === expected
}

function isCodeRunnerPipelineFailure(terminal, sent) {
  if (msgType(terminal) !== 'workflowFailed') {
    return false
  }
  const reason =
    typeof terminal === 'object' && terminal !== null && 'reason' in terminal
      ? String(terminal.reason)
      : ''
  if (reason.includes('code-runner')) {
    return true
  }
  return sent.some((m) => {
    if (msgType(m) !== 'stageError') return false
    if (typeof m !== 'object' || m === null || !('error' in m)) return false
    return String(m.error).includes('code-runner')
  })
}

function findInstanceKey(sent) {
  for (const t of ['userTaskPolished', 'workflowGenerated']) {
    const hit = sent.find((m) => msgType(m) === t)
    if (hit && typeof hit === 'object' && hit !== null && 'instanceKey' in hit && hit.instanceKey) {
      return String(hit.instanceKey)
    }
  }
  return undefined
}

/** @param {unknown[]} sent @param {Map<string, string>} stageOutputs */
function syncStageOutputs(sent, stageOutputs) {
  for (const m of sent) {
    if (msgType(m) !== 'stageOutputUpdate') continue
    if (typeof m !== 'object' || m === null || !('stageId' in m) || !('outputKey' in m)) continue
    const stageId = String(m.stageId)
    const outputKey = String(m.outputKey)
    const content = 'content' in m ? m.content : ''
    const text =
      typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content)
    if (text.trim()) {
      stageOutputs.set(`${stageId}:${outputKey}`, text)
    }
  }
}

// decision lint 拒绝（decisionRecord 缺章节等）→ AFK 驾驶员带 lint 反馈自动重试 decide
// stage 的次数上限（T4 Run #25：拒绝后 stage 停 paused，无人值守即挂死到 timeout）。
const MAX_DECISION_LINT_RETRIES = 2

const DECISION_LINT_RETRY_COMMENT = buildDecisionLintRetryUserComment()

/**
 * Auto-approve HITL gates so live runs can finish without a UI.
 * Decision stages (isDecisionStage) require approveDecision + decisionRecord, not approve.
 * @param {WorkflowEngine} engine
 * @param {unknown[]} sent
 * @param {Set<unknown>} handled
 * @param {Map<string, string>} stageOutputs
 * @param {Set<string>} decisionApprovalAttempted
 * @param {Map<string, number>} decisionLintRetries
 */
async function drainHitl(engine, sent, handled, stageOutputs, decisionApprovalAttempted, decisionLintRetries) {
  syncStageOutputs(sent, stageOutputs)

  for (const m of sent) {
    if (typeof m !== 'object' || m === null || !('type' in m)) continue
    const type = m.type

    if (
      type === 'stageError' &&
      'error' in m &&
      String(m.error).includes('decisionLintRejected') &&
      'stageId' in m
    ) {
      if (handled.has(m)) continue
      handled.add(m)
      const stageId = String(m.stageId)
      const n = decisionLintRetries?.get(stageId) ?? 0
      if (n >= MAX_DECISION_LINT_RETRIES) {
        // 快速失败并给出确定性终因，避免挂死到 timeout
        throw new Error(`decision lint rejected after ${n} retries @ ${stageId}`)
      }
      decisionLintRetries?.set(stageId, n + 1)
      // 允许重试后的新 decisionRecord 再次走 approveDecision
      decisionApprovalAttempted.delete(stageId)
      await engine.retry(stageId, DECISION_LINT_RETRY_COMMENT)
      continue
    }

    if (type === 'stageQuestionsBefore' || type === 'stageQuestions') {
      if (handled.has(m)) continue
      handled.add(m)
      const stageId = 'stageId' in m ? String(m.stageId) : ''
      const questions = 'questions' in m && Array.isArray(m.questions) ? m.questions : []
      const answers = {}
      for (const q of questions) {
        if (typeof q !== 'object' || q === null || !('id' in q)) continue
        const id = String(q.id)
        if ('suggestedAnswer' in q && typeof q.suggestedAnswer === 'string' && q.suggestedAnswer.trim()) {
          answers[id] = q.suggestedAnswer.trim()
          continue
        }
        const options = 'options' in q && Array.isArray(q.options) ? q.options : []
        const first = options[0]
        answers[id] =
          typeof first === 'object' && first !== null && 'value' in first
            ? String(first.value)
            : 'headless-auto'
      }
      if (type === 'stageQuestionsBefore') {
        await engine.answerQuestionsBefore(stageId, answers)
      } else {
        await engine.answerQuestions(stageId, answers)
      }
      continue
    }

    if (type === 'stageStatusUpdate' && 'status' in m && m.status === 'paused' && 'stageId' in m) {
      const stageId = String(m.stageId)
      const isDecision = 'isDecisionStage' in m && m.isDecisionStage === true
      if (isDecision) {
        if (decisionApprovalAttempted.has(stageId)) continue
        const record = stageOutputs.get(`${stageId}:decisionRecord`)
        if (!record) continue
        decisionApprovalAttempted.add(stageId)
        handled.add(m)
        await engine.approveDecision(stageId, record)
      } else {
        if (handled.has(m)) continue
        handled.add(m)
        await engine.approve(stageId)
      }
    }
  }
}

/**
 * @param {WorkflowEngine} engine
 * @param {() => unknown[]} getSent
 * @param {number} timeoutMs
 */
function findTerminalStageErrorReason(sent) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i]
    if (msgType(m) !== 'stageError') continue
    const err = typeof m === 'object' && m !== null && 'error' in m ? String(m.error) : ''
    if (/blockDeliveryOnTestFailure|module-contract/i.test(err)) {
      return err
    }
  }
  return ''
}

// instance.status='failed' 同步置位，但 stageError/workflowFailed 经异步 delivery chain
// 下发；轮询命中两者之间的窗口会误报「failed without workflowFailed」（T4 Run #24）。
// 检测到 failed 后给 delivery chain 一个 flush 宽限期再下结论。
const TERMINAL_FLUSH_GRACE_MS = 3_000

async function waitForTerminal(engine, getSent, timeoutMs) {
  const handled = new Set()
  const stageOutputs = new Map()
  const decisionApprovalAttempted = new Set()
  const decisionLintRetries = new Map()
  const deadline = Date.now() + timeoutMs
  let failedDetectedAt = 0
  while (Date.now() < deadline) {
    const sent = getSent()
    await drainHitl(engine, sent, handled, stageOutputs, decisionApprovalAttempted, decisionLintRetries)
    const terminal = sent.find((m) => {
      const t = msgType(m)
      return t === 'workflowCompleted' || t === 'workflowFailed'
    })
    if (terminal) {
      return terminal
    }
    const summaries = typeof engine.getTaskSummaries === 'function' ? engine.getTaskSummaries() : []
    const failedInst = summaries.find((i) => i.status === 'failed')
    if (failedInst && !engine.isExecutionInFlight()) {
      if (failedDetectedAt === 0) {
        failedDetectedAt = Date.now()
      }
      if (Date.now() - failedDetectedAt >= TERMINAL_FLUSH_GRACE_MS) {
        const gateReason = findTerminalStageErrorReason(sent)
        if (gateReason) {
          throw new Error(`execution ended early (${gateReason})`)
        }
        throw new Error(
          `instance status failed without workflowFailed — last messages: ${sent.slice(-5).map(msgType).join(', ')}`,
        )
      }
    } else if (failedInst) {
      const gateReason = findTerminalStageErrorReason(sent)
      if (gateReason) {
        throw new Error(`execution ended early (${gateReason})`)
      }
    }
    if (!engine.isExecutionInFlight() && !failedInst) {
      const completed = sent.find((m) => msgType(m) === 'workflowCompleted')
      if (completed) return completed
    }
    await sleep(80)
  }
  throw new Error(`timeout after ${timeoutMs}ms — last messages: ${getSent().slice(-5).map(msgType).join(', ')}`)
}

function makeWorkspace(opts) {
  if (opts.workspace) {
    const abs = path.resolve(opts.workspace)
    fs.mkdirSync(abs, { recursive: true })
    return abs
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stagent-feedback-'))
  const ws = path.join(base, 'task')
  fs.mkdirSync(ws, { recursive: true })
  return ws
}

const T4_FAMILY_TASK_IDS = new Set(['live-t4-nanhua-futures', 'live-t5-t4-charter-suggest'])
const LIVE_T4_MAX_OUTPUT_TOKENS = 16_384

/** Live 档位 configOverrides：生成重试 + 可选 Charter。 */
function buildLiveConfigOverrides(spec) {
  const overrides = {
    'generation.maxParseRetries': 3,
    'contract.planPreflightV2': true,
  }
  if (T4_FAMILY_TASK_IDS.has(spec.id)) {
    overrides['plan.requireCompleteness'] = true
    overrides['contract.skeletonCompiler'] = true
    overrides['afk.enabled'] = true
    overrides['python.verifyImportsStrict'] = true
    overrides.llmMaxOutputTokens = LIVE_T4_MAX_OUTPUT_TOKENS
    // T4 Run #28：test_write（deepseek-v4-pro）长输出偶发 180s 空闲超时 → AFK 拉满上限
    overrides.llmTimeoutSeconds = 600
    // 可体验交付（价值档）：STAGENT_DEMO_DELIVERY=1 时注入 demo 链；独立度量，不污染 strict。
    if (process.env.STAGENT_DEMO_DELIVERY === '1') {
      overrides['delivery.demoDelivery'] = true
      overrides['delivery.demoArtifactLint'] = 'warn'
    }
  }
  if (spec.charter?.enabled) {
    overrides['charter.enabled'] = true
    overrides['charter.autoAnswerMode'] = spec.charter.autoAnswerMode ?? 'suggest'
    overrides['charter.path'] = spec.charter.path ?? CHARTER_REL_PATH
    if (spec.charter.grillAdaptiveMode === false) {
      overrides['grill.adaptiveMode'] = false
    }
  }
  return overrides
}

function assertCharterPass(spec, ws, sent, taskDir) {
  const charterRel = spec.charter?.path ?? CHARTER_REL_PATH
  if (spec.pass?.charterFileRequired || spec.charter?.enabled) {
    const charterPath = path.join(ws, charterRel)
    if (!fs.existsSync(charterPath)) {
      throw new Error(`charter file missing: ${charterPath}`)
    }
  }
  if (!spec.pass?.charterActivityRequired) return
  const hasSuggestBefore = sent.some((m) => {
    if (msgType(m) !== 'stageQuestionsBefore') return false
    const qs = 'questions' in m && Array.isArray(m.questions) ? m.questions : []
    return qs.some(
      (q) =>
        typeof q === 'object' &&
        q !== null &&
        'suggestedAnswer' in q &&
        String(q.suggestedAnswer ?? '').trim(),
    )
  })
  const debugTail = taskDir ? tailDebugLog(taskDir) : ''
  const hasDebugCharter = /charter_coverage|charter_grill|charter_constraints_inject/.test(debugTail)
  if (!hasSuggestBefore && !hasDebugCharter) {
    throw new Error(
      'charter activity not observed (no stageQuestionsBefore.suggestedAnswer nor charter_* debug events)',
    )
  }
}

/** Temp run root (parent of `task/` workspace dir). */
function tempBaseFromWorkspace(ws) {
  return path.dirname(ws)
}

/**
 * @param {{ live: boolean, keep: boolean, workspace?: string, mockUrl?: string, mockModel?: string }} ctx
 */
function buildLlmConfig(ctx) {
  if (ctx.live) {
    const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? '').trim()
    if (!apiKey) {
      throw new Error('live mode requires DEEPSEEK_API_KEY or LLM_API_KEY')
    }
    const baseUrl = normalizeLlmBaseUrl(process.env.LLM_BASE_URL ?? 'https://api.deepseek.com')
    const model = (process.env.LLM_MODEL ?? 'deepseek-chat').trim()
    // 异族出题人：LLM_MODEL_TEST_WRITE 设了即为 test_write 阶段启用专属模型；
    // baseUrl / apiKey 缺省回退主配置。不设 = 单模型，行为与历史一致。
    const testWriteModel = (process.env.LLM_MODEL_TEST_WRITE ?? '').trim()
    const testWrite = testWriteModel
      ? {
          model: testWriteModel,
          baseUrl: process.env.LLM_BASE_URL_TEST_WRITE?.trim()
            ? normalizeLlmBaseUrl(process.env.LLM_BASE_URL_TEST_WRITE)
            : baseUrl,
          apiKey: (process.env.LLM_API_KEY_TEST_WRITE ?? '').trim() || apiKey,
        }
      : undefined
    return {
      apiKey,
      baseUrl,
      model,
      maxOutputTokens: LIVE_T4_MAX_OUTPUT_TOKENS,
      ...(testWrite ? { testWrite } : {}),
    }
  }
  if (!ctx.mockUrl) {
    throw new Error('mockUrl required for mock mode')
  }
  return {
    apiKey: 'mock-key',
    baseUrl: `${ctx.mockUrl}/v1`,
    model: ctx.mockModel ?? MOCK_MODEL_ID,
    maxOutputTokens: 4096,
  }
}

async function runConstruct(ctx) {
  const started = Date.now()
  const ws = makeWorkspace(ctx)
  const globalDir = path.join(path.dirname(ws), 'global')
  const sent = []
  const platform = createHeadlessPlatform({
    workspace: ws,
    globalDir,
    onMessage: (m) => sent.push(m),
  })
  const engine = new WorkflowEngine(platform)
  const checks = [
    ['instances', engine.instances],
    ['generation', engine.generation],
    ['execution', engine.execution],
    ['hitl', engine.hitl],
    ['artifacts', engine.artifacts],
    ['platform', engine.platform],
    ['getActiveInstanceKey', typeof engine.getActiveInstanceKey === 'function'],
    ['startExecution', typeof engine.startExecution === 'function'],
  ]
  for (const [name, val] of checks) {
    if (!val) {
      throw new Error(`construct missing: ${name}`)
    }
  }
  return {
    id: 'construct',
    status: 'pass',
    elapsedMs: Date.now() - started,
    workspace: ws,
    messageTypes: sent.map(msgType),
  }
}

async function runPolish(ctx) {
  const started = Date.now()
  const ws = makeWorkspace(ctx)
  const globalDir = path.join(path.dirname(ws), 'global')
  const sent = []
  const llm = buildLlmConfig(ctx)
  const usageMeter = createLlmUsageMeter()
  const platform = createHeadlessPlatform({
    workspace: ws,
    globalDir,
    llm,
    usageMeter,
    onMessage: (m) => sent.push(m),
  })
  const engine = new WorkflowEngine(platform)
  engine.setPreferredModelFamily(`direct:${llm.model}`)
  await engine.polishUserTask('做个 CSV diff 小工具', 'prototype', ws)

  const polished = sent.find((m) => msgType(m) === 'userTaskPolished')
  if (!polished) {
    throw new Error(`expected userTaskPolished, got: ${sent.map(msgType).join(', ')}`)
  }
  const key = findInstanceKey(sent)
  const taskDir = key ? path.join(ws, '.stagent', 'instances', key) : undefined
  return {
    id: 'polish',
    status: 'pass',
    elapsedMs: Date.now() - started,
    workspace: ws,
    instanceKey: key,
    llmUsage: usageMeter.summary(),
    debugLogTail: taskDir ? tailDebugLog(taskDir) : undefined,
    messageTypes: sent.map(msgType),
  }
}

async function runGenerate(ctx) {
  const started = Date.now()
  const ws = makeWorkspace(ctx)
  const globalDir = path.join(path.dirname(ws), 'global')
  const sent = []
  const llm = buildLlmConfig(ctx)
  const usageMeter = createLlmUsageMeter()
  const platform = createHeadlessPlatform({
    workspace: ws,
    globalDir,
    llm,
    usageMeter,
    onMessage: (m) => sent.push(m),
  })
  const engine = new WorkflowEngine(platform)
  engine.setPreferredModelFamily(`direct:${llm.model}`)

  const userInput =
    '读取本地 input.xlsx，抓取线上价格库存并对比，导出 diff 结果 CSV（headless feedback）'
  await engine.generateWorkflow(userInput, 'prototype', ws)

  const gen = sent.find((m) => msgType(m) === 'workflowGenerated')
  if (!gen || typeof gen !== 'object' || gen === null) {
    throw new Error(`expected workflowGenerated, got: ${sent.map(msgType).join(', ')}`)
  }
  if ('blocked' in gen && gen.blocked) {
    const reasons = 'blockReasons' in gen && Array.isArray(gen.blockReasons) ? gen.blockReasons : []
    throw new Error(`workflow blocked: ${reasons.join('; ')}`)
  }
  const key = findInstanceKey(sent)
  const stageCount =
    'workflow' in gen &&
    typeof gen.workflow === 'object' &&
    gen.workflow !== null &&
    'stages' in gen.workflow &&
    Array.isArray(gen.workflow.stages)
      ? gen.workflow.stages.length
      : 0
  return {
    id: 'generate',
    status: 'pass',
    elapsedMs: Date.now() - started,
    workspace: ws,
    instanceKey: key,
    stageCount,
    llmUsage: usageMeter.summary(),
    messageTypes: sent.map(msgType),
  }
}

/**
 * @param {typeof MOCK_EXECUTE_TASK} spec
 */
async function runFullJourney(ctx, spec) {
  const trace = new RunTrace(spec.id)
  const started = Date.now()
  const sent = []
  const usageMeter = createLlmUsageMeter()
  let ws
  let taskDir

  try {
    trace.setPhase('workspace')
    ws = makeWorkspace(ctx)
    if (spec.charter?.enabled) {
      copyCharterToWorkspace(ws, REPO_ROOT)
    }
    const globalDir = path.join(path.dirname(ws), 'global')
    const llm = buildLlmConfig(ctx)

    trace.setPhase('platform')
    const liveOverrides = ctx.live ? buildLiveConfigOverrides(spec) : undefined
    // 异族出题人：第二模型注册 + llmModelByRole 配置注入（无 testWrite 时两者均为空，与历史等价）
    // 异族出题人 + 集成切片增强（T4 Run #65）：test_write 用出题人(pro)；
    // main 集成切片 impl/fix/replan-fix 同样路由到 pro（#62/#64 收敛墙，flash 在多模块编排不收敛）。
    // 叶子切片 impl/fix 仍用全局 flash，保持异族非对称。
    const roleOverrides = llm.testWrite
      ? {
          llmModelByRole: {
            'test-write': `direct:${llm.testWrite.model}`,
            integration: `direct:${llm.testWrite.model}`,
          },
        }
      : undefined
    const platform = createHeadlessPlatform({
      workspace: ws,
      globalDir,
      llm,
      llmExtraModels: llm.testWrite ? [llm.testWrite] : undefined,
      usageMeter,
      configOverrides:
        liveOverrides || roleOverrides ? { ...(liveOverrides ?? {}), ...(roleOverrides ?? {}) } : undefined,
      onMessage: (m) => {
        sent.push(m)
        trace.onBackendMessage(m)
      },
    })
    trace.log('config', {
      mode: ctx.live ? 'live' : 'mock',
      model: llm.model,
      baseUrl: llm.baseUrl,
      testWriteModel: llm.testWrite?.model,
      llmMaxOutputTokens: platform.config.get('llmMaxOutputTokens'),
      planRequireCompleteness: platform.config.get('plan.requireCompleteness'),
      liveOverrides,
      charter: spec.charter?.enabled
        ? { autoAnswerMode: spec.charter.autoAnswerMode ?? 'suggest' }
        : undefined,
    })
    const engine = new WorkflowEngine(platform)
    engine.setPreferredModelFamily(`direct:${llm.model}`)

    const resumePayload = ctx.resume ? findResumableInstance(ws) : null
    let workflow
    let instanceKey
    let stageCount = 0

    if (resumePayload) {
      trace.setPhase('resume')
      trace.log('resume_instance', { instanceKey: resumePayload.instanceKey })
      workflow = { ...resumePayload.workflow }
      if (!workflow.meta) {
        workflow.meta = {}
      }
      workflow.meta.taskWorkspacePath = path.resolve(ws)
      instanceKey = resumePayload.instanceKey
      stageCount = Array.isArray(workflow.stages) ? workflow.stages.length : 0
    } else {
      if (spec.polish) {
        trace.setPhase('polish')
        await engine.polishUserTask(spec.userInput, spec.taskType, ws)
        if (!sent.some((m) => msgType(m) === 'userTaskPolished')) {
          throw new Error(`polish failed — messages: ${sent.map(msgType).join(', ')}`)
        }
      }

      trace.setPhase('generate')
      const maxGenAttempts = spec.generationAttempts ?? 1
      let gen
      for (let attempt = 1; attempt <= maxGenAttempts; attempt++) {
        if (attempt > 1) {
          trace.log('generate_retry', { attempt, maxGenAttempts })
          await sleep(4000)
        }
        await engine.generateWorkflow(spec.userInput, spec.taskType, ws)

        const genFailed = sent.find((m) => msgType(m) === 'workflowFailed')
        if (genFailed && typeof genFailed === 'object' && genFailed !== null) {
          const reason = 'reason' in genFailed ? String(genFailed.reason) : 'unknown'
          if (attempt < maxGenAttempts) continue
          throw new Error(`generate failed: ${reason}`)
        }

        gen = [...sent].reverse().find((m) => msgType(m) === 'workflowGenerated')
        if (!gen || typeof gen !== 'object' || gen === null) {
          const tail = sent.map(msgType).slice(-8).join(', ')
          if (attempt < maxGenAttempts) continue
          throw new Error(`generate missing — last messages: ${tail}`)
        }
        if ('blocked' in gen && gen.blocked) {
          const reasons =
            'blockReasons' in gen && Array.isArray(gen.blockReasons) ? gen.blockReasons : []
          if (attempt < maxGenAttempts) {
            trace.log('generate_blocked_retry', { attempt, reasons })
            continue
          }
          throw new Error(`workflow blocked: ${reasons.join('; ')}`)
        }
        break
      }
      if (!gen || typeof gen !== 'object' || gen === null) {
        throw new Error('generate missing after retries')
      }

      stageCount =
        'workflow' in gen &&
        typeof gen.workflow === 'object' &&
        gen.workflow !== null &&
        'stages' in gen.workflow &&
        Array.isArray(gen.workflow.stages)
          ? gen.workflow.stages.length
          : 0

      workflow =
        'workflow' in gen && typeof gen.workflow === 'object' && gen.workflow !== null
          ? { ...gen.workflow }
          : undefined
      if (!workflow) {
        throw new Error('workflowGenerated missing workflow payload')
      }
      if (!workflow.meta) {
        workflow.meta = {}
      }
      workflow.meta.taskWorkspacePath = path.resolve(ws)
      instanceKey =
        'instanceKey' in gen && gen.instanceKey ? String(gen.instanceKey) : undefined
    }

    if (spec.pass?.minStages && stageCount < spec.pass.minStages) {
      throw new Error(`stage count ${stageCount} < min ${spec.pass.minStages}`)
    }
    if (spec.pass?.maxStages && stageCount > spec.pass.maxStages) {
      throw new Error(`stage count ${stageCount} > max ${spec.pass.maxStages}`)
    }

    trace.setPhase('start_execution')
    await engine.startExecution(workflow, instanceKey)

    trace.setPhase('await_terminal')
    const terminal = await waitForTerminal(engine, () => sent, spec.timeoutMs ?? 60_000)
    const terminalType = msgType(terminal)
    const expectTerminal = spec.pass?.terminal ?? 'workflowCompleted'
    if (!matchesTerminalType(terminalType, expectTerminal)) {
      const reason =
        typeof terminal === 'object' && terminal !== null && 'reason' in terminal
          ? String(terminal.reason)
          : terminalType
      throw new Error(`execution ended with ${terminalType}: ${reason}`)
    }
    let outcome = terminalType
    if (terminalType === 'workflowFailed') {
      if (spec.pass?.acceptRunnerFailure && isCodeRunnerPipelineFailure(terminal, sent)) {
        outcome = 'runner-failed-accepted'
        trace.log('runner_failure_accepted', {
          reason:
            typeof terminal === 'object' && terminal !== null && 'reason' in terminal
              ? String(terminal.reason)
              : '',
        })
      } else {
        const reason =
          typeof terminal === 'object' && terminal !== null && 'reason' in terminal
            ? String(terminal.reason)
            : terminalType
        throw new Error(`execution ended with workflowFailed: ${reason}`)
      }
    }

    const key = findInstanceKey(sent) ?? engine.getActiveInstanceKey()
    taskDir = key ? path.join(ws, '.stagent', 'instances', key) : undefined

    let artifacts
    let missingArtifacts
    if (spec.pass?.artifactCheck) {
      artifacts = findArtifacts(ws, EXPECTED_ARTIFACTS, key)
      missingArtifacts = EXPECTED_ARTIFACTS.filter((a) => !artifacts.includes(a))
      if (missingArtifacts.length > 0) {
        throw new Error(`missing artifacts: ${missingArtifacts.join(', ')}`)
      }
    }

    assertCharterPass(spec, ws, sent, taskDir)

    let strictMvp
    if (spec.pass?.strict) {
      strictMvp = assertStrictMvpPass(ws, { outcome, requireTraceability: true })
      trace.log('strict_mvp_pass', {
        testFiles: strictMvp.testFiles,
        warnings: strictMvp.warnings,
      })
      if (ctx.keep && ws.includes('.headless-iter')) {
        const t4Root = path.resolve(REPO_ROOT, '../T4')
        strictMvp.promoted = promoteIterToT4Root(ws, t4Root, {
          instanceKey: key,
          commit: gitShortCommit(),
        })
        trace.log('promoted_to_t4_root', { copied: strictMvp.promoted.copied })
      }
    }

    /** 可体验交付独立度量（demo-able）；仅当 STAGENT_DEMO_DELIVERY=1 时启用，不污染 strict 口径。 */
    let demoDelivery
    if (process.env.STAGENT_DEMO_DELIVERY === '1' && T4_FAMILY_TASK_IDS.has(spec.id)) {
      demoDelivery = checkDemoDelivery(ws, { exitCode: 0 })
      trace.log(demoDelivery.pass ? 'demo_delivery_pass' : 'demo_delivery_fail', {
        artifacts: demoDelivery.artifacts,
        issues: demoDelivery.issues,
      })
    }

    trace.setPhase('done')
    return {
      id: spec.id,
      label: spec.label,
      status: 'pass',
      outcome,
      elapsedMs: Date.now() - started,
      workspace: ws,
      instanceKey: key,
      stageCount,
      artifacts,
      missingArtifacts,
      llmCalls: typeof ctx.mockCalls === 'function' ? ctx.mockCalls() : undefined,
      llmUsage: usageMeter.summary(),
      debugLogPath: taskDir ? path.join(taskDir, '.wf-debug.log') : undefined,
      debugLogTail: taskDir ? tailDebugLog(taskDir) : undefined,
      messageTypes: sent.map(msgType),
      strictMvp,
      demoDelivery,
      trace: trace.summary(),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    trace.fail(message, {
      messageTypes: sent.map(msgType),
      debugLogTail: taskDir ? tailDebugLog(taskDir) : undefined,
    })
    const failure = new Error(message)
    failure.trace = trace.summary()
    failure.workspace = ws
    failure.llmUsage = usageMeter.summary()
    failure.debugLogTail = taskDir ? tailDebugLog(taskDir) : undefined
    failure.messageTypes = sent.map(msgType)
    throw failure
  } finally {
    trace.flush(ARTIFACTS_DIR)
  }
}

async function runExecute(ctx) {
  return runFullJourney(ctx, MOCK_EXECUTE_TASK)
}

async function runLiveTier(ctx, tierNum) {
  const spec = LIVE_TASK_TIERS[tierNum]
  if (!spec) {
    throw new Error(`unknown live tier: ${tierNum}`)
  }
  const tierCtx =
    isT4FamilyTier(tierNum) && !ctx.workspace
      ? { ...ctx, workspace: prepareT4IterWorkspace(REPO_ROOT, { resume: ctx.resume }) }
      : ctx
  return runFullJourney(tierCtx, spec)
}

async function runCharterSuggest(ctx) {
  if (ctx.live) {
    return runCharterSuggestSmoke({ ...ctx, liveLlm: buildLlmConfig(ctx) })
  }
  if (!ctx.mockUrl) {
    throw new Error('charter-suggest smoke requires mock LLM or --live')
  }
  return runCharterSuggestSmoke(ctx)
}

async function runCharterAuto(ctx) {
  if (ctx.live) {
    const { runCharterAutoEscalationSmoke: runAuto } = await import('./lib/charter-auto-escalation-smoke.mjs')
    return runAuto({ ...ctx, liveLlm: buildLlmConfig(ctx) })
  }
  if (!ctx.mockUrl) {
    throw new Error('charter-auto smoke requires mock LLM or --live')
  }
  return runCharterAutoEscalationSmoke(ctx)
}

const SCENARIOS = {
  construct: runConstruct,
  polish: runPolish,
  generate: runGenerate,
  execute: runExecute,
  'charter-suggest': runCharterSuggest,
  'charter-auto': runCharterAuto,
}

function shouldRun(name, filter) {
  return filter === 'all' || filter === name
}

function printHuman(report) {
  console.log('')
  console.log('── headless feedback ─────────────────────────────')
  console.log(`mode: ${report.mode}  commit: ${report.commit}`)
  for (const s of report.scenarios) {
    const mark = s.status === 'pass' ? '✓' : '✗'
    const extra = []
    if (s.label) extra.push(s.label)
    if (s.outcome && s.outcome !== 'workflowCompleted') extra.push(`outcome: ${s.outcome}`)
    if (s.stageCount) extra.push(`${s.stageCount} stages`)
    if (s.artifacts?.length) extra.push(`artifacts: ${s.artifacts.join(', ')}`)
    if (s.llmUsage) extra.push(formatUsageLine(s.llmUsage))
    if (s.workspace) extra.push(`ws: ${s.workspace}`)
    if (s.demoDelivery) {
      extra.push(
        s.demoDelivery.pass
          ? 'demo: pass'
          : `demo: fail (${(s.demoDelivery.issues ?? []).slice(0, 2).join('; ')})`,
      )
    }
    console.log(`  ${mark} ${s.id} (${s.elapsedMs}ms)${extra.length ? ' — ' + extra.join('; ') : ''}`)
    if (s.status === 'fail') {
      console.log(`      ${s.error}`)
      if (s.failurePhase) {
        console.log(`      phase: ${s.failurePhase} (last ok: ${s.lastGoodPhase ?? '?'})`)
      }
      if (s.trace?.failure) {
        console.log(`      trace: ${TRACE_PATH}`)
      }
      if (s.debugLogPath) {
        console.log(`      engine log: ${s.debugLogPath}`)
      }
      if (s.debugLogTail) {
        console.log('      --- .wf-debug.log (tail) ---')
        for (const line of s.debugLogTail.split('\n')) {
          console.log(`      ${line}`)
        }
      }
    }
  }
  console.log(`summary: ${report.summary.passed}/${report.summary.total} passed`)
  const strictScenarios = report.scenarios.filter((s) => s.strictMvp || s.id?.includes('t4') || s.id?.includes('charter'))
  const strictPassed = strictScenarios.filter((s) => s.status === 'pass' && s.strictMvp).length
  if (report.mode === 'live' && strictScenarios.length > 0) {
    console.log(
      `strict delivery: ${strictPassed}/${strictScenarios.filter((s) => s.status === 'pass' || s.strictMvp !== undefined).length} (pipeline vs MVP 验收)`,
    )
  }
  const demoScenarios = report.scenarios.filter((s) => s.demoDelivery)
  if (demoScenarios.length > 0) {
    const demoPassed = demoScenarios.filter((s) => s.demoDelivery?.pass).length
    console.log(`demo delivery: ${demoPassed}/${demoScenarios.length} (可体验交付，独立度量，不污染 strict)`)
  }
  console.log(`report: ${REPORT_PATH}`)
  if (report.mode === 'live' || report.scenarios.some((s) => s.trace)) {
    console.log(`trace:  ${TRACE_PATH}`)
  }
  console.log('──────────────────────────────────────────────────')
  console.log('')
}

/** 单轮完整 suite：写 REPORT_PATH / TRACE_PATH，返回 report 与 exitCode（不直接退出）。 */
async function runSuite(opts) {
  fs.writeFileSync(TRACE_PATH, '', 'utf8')

  let mockServer
  const ctx = {
    live: opts.live,
    keep: opts.keep,
    resume: opts.resume || process.env.STAGENT_HEADLESS_RESUME === '1',
    workspace: opts.workspace,
    mockUrl: undefined,
    mockModel: MOCK_MODEL_ID,
    mockCalls: undefined,
  }

  if (!opts.live) {
    mockServer = await startMockLlmServer()
    ctx.mockUrl = mockServer.url
    ctx.mockCalls = () => mockServer.calls
  }

  const report = {
    timestamp: new Date().toISOString(),
    commit: gitShortCommit(),
    mode: opts.live ? 'live' : 'mock',
    scenarios: [],
    summary: { passed: 0, failed: 0, total: 0 },
  }

  const order = ['construct', 'polish', 'generate', 'execute', 'charter-suggest', 'charter-auto']
  let exitCode = 0

  try {
    for (const name of order) {
      if (!shouldRun(name, opts.scenario)) continue

      const runners =
        opts.live && name === 'execute'
          ? resolveLiveTiers(opts.liveTier).map((tier) => ({
              id: LIVE_TASK_TIERS[tier].id,
              run: () => runLiveTier(ctx, tier),
            }))
          : [{ id: name, run: () => SCENARIOS[name](ctx) }]

      for (let ri = 0; ri < runners.length; ri++) {
        const { id, run } = runners[ri]
        if (opts.live && opts.liveTier === 'all' && ri > 0) {
          await sleep(12_000)
        }
        const scenarioStarted = Date.now()
        try {
          const result = await run()
          report.scenarios.push(result)
          report.summary.passed++
        } catch (err) {
          exitCode = 1
          const e = err
          report.scenarios.push({
            id,
            label: Object.values(LIVE_TASK_TIERS).find((t) => t.id === id)?.label,
            status: 'fail',
            elapsedMs: Date.now() - scenarioStarted,
            error: e instanceof Error ? e.message : String(e),
            workspace: e.workspace ?? opts.workspace,
            llmUsage: e.llmUsage,
            failurePhase: e.trace?.failure?.failurePhase ?? e.trace?.phase,
            lastGoodPhase: e.trace?.lastGoodPhase,
            messageTypes: e.messageTypes,
            debugLogPath: e.trace?.failure?.debugLogTail ? undefined : e.workspace
              ? path.join(e.workspace, '.stagent', 'instances')
              : undefined,
            debugLogTail: e.debugLogTail,
            trace: e.trace,
          })
          report.summary.failed++
          if (opts.scenario !== 'all' && !opts.live) break
          if (opts.live && opts.liveTier !== 'all') break
        }
      }
    }
    report.summary.total = report.scenarios.length
  } finally {
    if (mockServer) await mockServer.close()
    if (!opts.keep) {
      for (const s of report.scenarios) {
        if (s.workspace && !opts.workspace) {
          const base = tempBaseFromWorkspace(s.workspace)
          try {
            fs.rmSync(base, { recursive: true, force: true })
          } catch {
            /* best effort */
          }
        }
      }
    }
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
  return { report, exitCode }
}

/**
 * 批量聚合（缺口 1 · §6.1 成功率口径）：
 * 按 scenario id 跨 run 统计 pass / strict pass 次数，与阈值比对给出 verdict。
 */
function aggregateBatch(runs, opts) {
  const threshold = opts.passThreshold ?? Math.ceil(0.6 * opts.repeat)
  const byScenario = new Map()
  runs.forEach((report, runIdx) => {
    for (const s of report.scenarios) {
      const g = byScenario.get(s.id) ?? {
        id: s.id,
        label: s.label,
        attempts: 0,
        passed: 0,
        strictPassed: 0,
        failures: [],
        elapsedMsTotal: 0,
        llm: { calls: 0, promptTokens: 0, completionTokens: 0, estimatedCost: 0, hasCost: false },
      }
      g.attempts += 1
      g.elapsedMsTotal += s.elapsedMs ?? 0
      if (s.status === 'pass') {
        g.passed += 1
        if (s.strictMvp) g.strictPassed += 1
      } else {
        g.failures.push({ run: runIdx + 1, error: s.error, failurePhase: s.failurePhase })
      }
      if (s.llmUsage) {
        g.llm.calls += s.llmUsage.calls
        g.llm.promptTokens += s.llmUsage.promptTokens
        g.llm.completionTokens += s.llmUsage.completionTokens
        if (s.llmUsage.estimatedCost !== undefined) {
          g.llm.estimatedCost += s.llmUsage.estimatedCost
          g.llm.hasCost = true
        }
      }
      byScenario.set(s.id, g)
    }
  })

  const scenarios = [...byScenario.values()].map((g) => ({
    id: g.id,
    label: g.label,
    attempts: g.attempts,
    passed: g.passed,
    strictPassed: g.strictPassed,
    successRate: g.attempts > 0 ? Math.round((g.passed / g.attempts) * 100) / 100 : 0,
    meetsThreshold: g.passed >= threshold,
    avgElapsedMs: g.attempts > 0 ? Math.round(g.elapsedMsTotal / g.attempts) : 0,
    llmUsage: g.llm.calls
      ? {
          calls: g.llm.calls,
          promptTokens: g.llm.promptTokens,
          completionTokens: g.llm.completionTokens,
          ...(g.llm.hasCost ? { estimatedCost: Math.round(g.llm.estimatedCost * 1e4) / 1e4 } : {}),
        }
      : undefined,
    failures: g.failures,
  }))

  return {
    timestamp: new Date().toISOString(),
    commit: gitShortCommit(),
    mode: opts.live ? 'live' : 'mock',
    repeat: opts.repeat,
    threshold,
    scenarios,
    verdict: {
      pass: scenarios.every((s) => s.meetsThreshold),
      rule: `每个 scenario 通过次数 ≥ ${threshold}/${opts.repeat}（§6.1 成功率口径）`,
    },
  }
}

function printBatch(batch) {
  console.log('')
  console.log('── headless batch（成功率口径）───────────────────')
  console.log(`mode: ${batch.mode}  commit: ${batch.commit}  repeat: ${batch.repeat}  threshold: ≥${batch.threshold}`)
  for (const s of batch.scenarios) {
    const mark = s.meetsThreshold ? '✓' : '✗'
    const extra = []
    if (s.strictPassed > 0 || s.id.includes('t4') || s.id.includes('t5')) {
      extra.push(`strict ${s.strictPassed}/${s.attempts}`)
    }
    extra.push(`avg ${Math.round(s.avgElapsedMs / 1000)}s`)
    if (s.llmUsage) {
      extra.push(`tok in ${s.llmUsage.promptTokens} / out ${s.llmUsage.completionTokens}`)
      if (s.llmUsage.estimatedCost !== undefined) extra.push(`cost≈${s.llmUsage.estimatedCost}`)
    }
    console.log(`  ${mark} ${s.id} — pass ${s.passed}/${s.attempts} (${Math.round(s.successRate * 100)}%); ${extra.join('; ')}`)
    for (const f of s.failures) {
      console.log(`      run#${f.run} ${f.failurePhase ?? '?'}: ${String(f.error).slice(0, 140)}`)
    }
  }
  console.log(`verdict: ${batch.verdict.pass ? 'PASS' : 'FAIL'} — ${batch.verdict.rule}`)
  console.log(`report: ${BATCH_REPORT_PATH}`)
  console.log(`per-run: ${BATCH_DIR}/run-<i>.json`)
  console.log('──────────────────────────────────────────────────')
  console.log('')
}

async function main() {
  loadEnvLocal()
  const opts = parseArgs(process.argv.slice(2))
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })

  if (opts.withUnit) {
    const unit = spawnSync('npm', ['test'], {
      cwd: path.join(REPO_ROOT, 'packages/stagent-core'),
      encoding: 'utf8',
      stdio: 'inherit',
    })
    if (unit.status !== 0) {
      process.exit(unit.status ?? 1)
    }
  }

  if (opts.repeat <= 1) {
    const { report, exitCode } = await runSuite(opts)
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      printHuman(report)
    }
    process.exit(exitCode)
  }

  // 批量模式：N 连跑 + 成功率聚合（每轮 REPORT/TRACE 归档到 artifacts/batch/）
  if (opts.resume) {
    throw new Error('--repeat 与 --resume 不能同时使用（批量要求每轮独立采样）')
  }
  fs.rmSync(BATCH_DIR, { recursive: true, force: true })
  fs.mkdirSync(BATCH_DIR, { recursive: true })
  const runs = []
  for (let i = 1; i <= opts.repeat; i++) {
    if (i > 1 && opts.live) {
      await sleep(12_000)
    }
    if (!opts.json) {
      console.log(`\n=== batch run ${i}/${opts.repeat} ===`)
    }
    const { report } = await runSuite(opts)
    fs.copyFileSync(REPORT_PATH, path.join(BATCH_DIR, `run-${i}.json`))
    if (fs.existsSync(TRACE_PATH)) {
      fs.copyFileSync(TRACE_PATH, path.join(BATCH_DIR, `run-${i}.trace.jsonl`))
    }
    runs.push(report)
    if (!opts.json) {
      printHuman(report)
    }
  }

  const batch = aggregateBatch(runs, opts)
  fs.writeFileSync(BATCH_REPORT_PATH, JSON.stringify(batch, null, 2), 'utf8')
  if (opts.json) {
    console.log(JSON.stringify(batch, null, 2))
  } else {
    printBatch(batch)
  }
  process.exit(batch.verdict.pass ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
