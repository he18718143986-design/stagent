import { extractJsonObject } from '../JsonExtract';
import {
  type DecisionArtifactsV1,
  isDecisionArtifactsV1,
} from './decisionArtifactsSchema';
import { validateBehaviorSpecForSemantic } from './behaviorSpecSchema';

const ARTIFACTS_MARKER_RE = /<!--\s*decisionArtifacts:json\s*-->/i;

export const DECISION_ARTIFACTS_PROMPT_SUFFIX = `

【决策机读 sidecar（decisionArtifacts）】
在 DecisionRecord Markdown 正文之后，另起一行输出标记行：
<!-- decisionArtifacts:json -->
随后输出**唯一**一个 JSON 对象（不要用 markdown 围栏），结构：
{"version":1,"files":[{"key":"configContent","path":"config.yaml","format":"yaml","content":"..."}],"modules":[{"name":"indicators","exports":["compute"]}],"dependencies":["pytest","numpy","pandas"],"testStack":"pytest"}
- files[].key 供下游 file-write 的 sourceOutputKey 引用；content 为完整文件正文。
- modules[]：全项目模块接口契约（name=Python 包名/切片语义名，exports=允许 test/impl 引用的公开符号）。
- dependencies[]：允许 impl/fix 使用的第三方包根名（如 numpy、pandas）；未声明的包不得在代码中 import。
- 全局架构决策须列出**全部**切片模块的 modules[]；若无额外落盘文件，files 可为 []。
- DecisionRecord 正文仍禁止代码块；JSON sidecar 不受此限。`;

/** 切片 decide：本模块 modules[] 单条（可细化全局表）。 */
export const SLICE_MODULE_CONTRACT_SUFFIX = `

【本切片模块契约（decisionArtifacts.modules）】
sidecar JSON 的 modules 须含**恰好一条**：{"name":"<本切片语义名>","exports":["公开符号1",...]}。
- exports 为 test_write / impl 唯一允许的 from <name> import <symbol> 集合；禁止发明未列符号。
- 可与全局架构 modules[] 不一致时，以本切片 sidecar 为准。`;

/** signals 等切片：decide 须产出 behaviorSpec 机读行为契约。 */
export const BEHAVIOR_SPEC_SLICE_SUFFIX = `

【本切片行为规格（decisionArtifacts.behaviorSpec）】
sidecar JSON 须含 behaviorSpec 对象（与 modules[] 并列），结构示例：
{"version":1,"modules":[{"name":"signals","exports":["generate_bear_signal","generate_bull_signal"]}],"behaviorSpec":{"module":"signals","functions":[{"name":"generate_bear_signal","returns":"Signal | None","when_non_null":"all","conditions":[{"id":"ma_convergence","desc":"MA5..MA9 spread < spread_threshold (strict <)"},{"id":"cci_cross_down","desc":"CCI[-2] >= cci_cross_band AND CCI[-1] < -cci_cross_band"}]}],"edge_rules":["Threshold comparisons use strict < unless noted.","Fixture helpers _set_ideal_* MUST run before boundary column overrides."],"fixture_hints":["typical_bear_indicators_ok must satisfy all condition ids for generate_bear_signal."]}}
- functions[].conditions[].id 为稳定标识，test_write / impl / fix 全链路引用。
- when_non_null：all=AND 链（默认），any=OR 链。
- edge_rules：跨用例边界纪律（比较符、helper 顺序、禁止 export 的占位符）。
- DecisionRecord 散文保留人读说明；与 behaviorSpec 冲突时以 behaviorSpec 为准。`;

/**
 * 从决策阶段 LLM 输出提取 decisionArtifacts JSON（marker 后或文末 JSON 对象）。
 */
export function parseDecisionArtifactsFromText(
  text: string,
  options?: { semantic?: string },
): {
  artifacts: DecisionArtifactsV1 | null;
  markdownBody: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return { artifacts: null, markdownBody: '', warnings: ['empty decision output'] };
  }

  const markerIdx = trimmed.search(ARTIFACTS_MARKER_RE);
  let markdownBody = trimmed;
  let jsonCandidate = '';

  if (markerIdx >= 0) {
    markdownBody = trimmed.slice(0, markerIdx).trim();
    jsonCandidate = trimmed.slice(markerIdx).replace(ARTIFACTS_MARKER_RE, '').trim();
  } else {
    const extracted = extractJsonObject(trimmed);
    if (extracted) {
      const jsonStart = trimmed.indexOf(extracted);
      if (jsonStart > 0) {
        markdownBody = trimmed.slice(0, jsonStart).trim();
        jsonCandidate = extracted;
      }
    }
  }

  if (!jsonCandidate) {
    return { artifacts: null, markdownBody, warnings };
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as unknown;
    if (!isDecisionArtifactsV1(parsed)) {
      warnings.push('decisionArtifacts JSON 结构无效');
      return { artifacts: null, markdownBody, warnings };
    }
    if (options?.semantic) {
      const mod = parsed.modules?.find((m) => m.name === options.semantic);
      for (const v of validateBehaviorSpecForSemantic(
        options.semantic,
        parsed.behaviorSpec,
        mod?.exports,
      )) {
        warnings.push(v.message);
      }
    }
    return { artifacts: parsed, markdownBody, warnings };
  } catch (e) {
    warnings.push(`decisionArtifacts JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`);
    return { artifacts: null, markdownBody, warnings };
  }
}
