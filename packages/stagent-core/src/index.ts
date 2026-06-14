/* ------------------------------------------------------------------ */
/*  @stagent/core — 平台中立的工作流引擎公共出口                        */
/*                                                                     */
/*  宿主(VS Code 扩展 / Electron)只通过本 barrel 消费 core，            */
/*  core 自身不依赖任何宿主(无运行时 vscode)。                          */
/* ------------------------------------------------------------------ */

export * from './platform/PlatformAdapter';
export { WorkflowEngine, isFrontendMessage } from './WorkflowEngine';
export { buildWorkflowWebviewHtml } from './WebviewPanel';
export type { TaskListItem } from './WorkflowInstanceQuery';
export { parseSseDeltaStream } from './SseDeltaStream';
export { readLlmMaxOutputTokens } from './StagentSettings';

/* 协议与领域类型（供宿主 UI 渲染消费；type-only，渲染层可安全 import type） */
export type {
  FrontendMessage,
  BackendMessage,
  WorkflowDefinition,
  WorkflowMeta,
  WorkflowInstance,
  WorkflowStatus,
  Stage,
  StageRuntime,
  StageStatus,
  StageOutput,
  Question,
  ToolType,
  ErrorType,
} from './WorkflowDefinition';
export type { PlanSummary, StageSourceEdge } from './WorkflowPlanSummary';
export type { StageArtifactHint } from './ArtifactUiHints';
export type { DeleteScope } from './WorkflowDeletePlan';
export type { QualityReportPayload } from './quality-report/QualityReportTypes';
export type { TaskTypeClassificationInfo } from './TaskTypeResolution';
export type { WorkflowTemplate as PathRouterWorkflowTemplate } from './path-router/WorkflowTemplateTypes';

/* ── S0：Skills × Engine 集成（场景化调用原版 SKILL.md）──────────────── */
/*  见 stagent_docs/SKILLS-ENGINE-INTEGRATION.md。                       */
export {
  STAGE_TOOL_SKILL_INVOKE,
  SKILL_STAGE_ID_PREFIX,
  skillRefToSlug,
  skillStageId,
  isSkillStageId,
  skillSlugFromStageId,
} from './SkillToolKinds';
export { SkillRegistry, hashSkillContent } from './SkillRegistry';
export type { SkillSource, SkillFsPort, SkillRegistryOptions } from './SkillRegistry';
export {
  routeScenario,
  SKILL_SETUP,
  SKILL_GRILL_WITH_DOCS,
  SKILL_GRILL_ME,
  SKILL_PROTOTYPE,
  SKILL_TO_PRD,
  SKILL_TO_ISSUES,
  SKILL_TDD,
  SKILL_TRIAGE,
  SKILL_DIAGNOSE,
  SKILL_ZOOM_OUT,
  SKILL_IMPROVE_ARCH,
} from './ScenarioRouter';
export type {
  WorkflowTemplate,
  EstimatedScope,
  RepoSnapshot,
  ScenarioInput,
  ScenarioRoute,
} from './ScenarioRouter';
export {
  assembleSkillSystemPrompt,
  buildEscalationInstruction,
} from './SkillPromptAssembler';
export type { AutoAnswerMode, SkillContextBundle } from './SkillPromptAssembler';
export { buildSkillStage, buildGrillStage } from './SkillStageFactory';
export type { BuildSkillStageOptions } from './SkillStageFactory';
export {
  assembleSkillWorkflow,
  buildStageForSkillRef,
} from './SkillWorkflowAssembler';
export type {
  AssembleSkillWorkflowOptions,
  AssembleSkillWorkflowResult,
} from './SkillWorkflowAssembler';

export {
  buildDecisionLintRetryUserComment,
  buildBehaviorSpecRetryUserComment,
  buildArchitectureConfigRetryUserComment,
} from './DecisionRecordVerify';
export {
  DECISION_LINT_REJECTED_MARKER,
  formatDecisionRejectionError,
  isDecisionLintRejectedError,
  decisionRejectionKindFromError,
} from './hitl/DecisionRejection';
export type { DecisionRejectionKind } from './hitl/DecisionRejection';
