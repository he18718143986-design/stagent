/** 首期必填 behaviorSpec 的切片（T4 signals AND 链语义卡点）。 */
export const BEHAVIOR_SPEC_REQUIRED_SLICES = ['signals'] as const;

export type BehaviorSpecRequiredSlice = (typeof BEHAVIOR_SPEC_REQUIRED_SLICES)[number];

export interface BehaviorConditionV1 {
  /** 稳定标识，供 test / gate / 日志引用。 */
  id: string;
  /** 人读条件描述（机读 SSOT 的补充语义）。 */
  desc: string;
}

export interface BehaviorFunctionV1 {
  name: string;
  returns: string;
  /** AND 链默认 all；OR 链为 any。 */
  when_non_null?: 'all' | 'any';
  conditions: BehaviorConditionV1[];
}

export interface BehaviorSpecV1 {
  module: string;
  functions: BehaviorFunctionV1[];
  edge_rules: string[];
  fixture_hints?: string[];
}

export interface BehaviorSpecViolation {
  code:
    | 'missing-behavior-spec'
    | 'module-mismatch'
    | 'empty-functions'
    | 'empty-conditions'
    | 'duplicate-condition-id'
    | 'invalid-when-non-null'
    | 'function-not-in-exports';
  message: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function isBehaviorSpecV1(value: unknown): value is BehaviorSpecV1 {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const o = value as BehaviorSpecV1;
  if (!isNonEmptyString(o.module) || !Array.isArray(o.functions) || !Array.isArray(o.edge_rules)) {
    return false;
  }
  if (!o.edge_rules.every(isNonEmptyString)) {
    return false;
  }
  if (o.fixture_hints != null && !o.fixture_hints.every(isNonEmptyString)) {
    return false;
  }
  for (const fn of o.functions) {
    if (!fn || typeof fn !== 'object') {
      return false;
    }
    if (!isNonEmptyString(fn.name) || !isNonEmptyString(fn.returns)) {
      return false;
    }
    if (fn.when_non_null != null && fn.when_non_null !== 'all' && fn.when_non_null !== 'any') {
      return false;
    }
    if (!Array.isArray(fn.conditions) || fn.conditions.length === 0) {
      return false;
    }
    for (const c of fn.conditions) {
      if (!c || typeof c !== 'object' || !isNonEmptyString(c.id) || !isNonEmptyString(c.desc)) {
        return false;
      }
    }
  }
  return o.functions.length > 0;
}

export function normalizeBehaviorSpec(spec: BehaviorSpecV1): BehaviorSpecV1 {
  return {
    module: spec.module.trim(),
    functions: spec.functions.map((fn) => ({
      name: fn.name.trim(),
      returns: fn.returns.trim(),
      when_non_null: fn.when_non_null ?? 'all',
      conditions: fn.conditions.map((c) => ({
        id: c.id.trim(),
        desc: c.desc.trim(),
      })),
    })),
    edge_rules: [...new Set(spec.edge_rules.map((r) => r.trim()).filter(Boolean))],
    fixture_hints: spec.fixture_hints
      ? [...new Set(spec.fixture_hints.map((h) => h.trim()).filter(Boolean))]
      : undefined,
  };
}

/** decide 落盘前校验；signals 等必填切片缺 spec 或形状非法时返回 violations。 */
export function validateBehaviorSpecForSemantic(
  semantic: string,
  behaviorSpec: unknown,
  moduleExports?: string[],
): BehaviorSpecViolation[] {
  const required = (BEHAVIOR_SPEC_REQUIRED_SLICES as readonly string[]).includes(semantic);
  if (!behaviorSpec) {
    if (required) {
      return [
        {
          code: 'missing-behavior-spec',
          message: `切片 ${semantic} 须在 decisionArtifacts.behaviorSpec 中声明行为规格（conditions + edge_rules）`,
        },
      ];
    }
    return [];
  }
  if (!isBehaviorSpecV1(behaviorSpec)) {
    return [
      {
        code: 'missing-behavior-spec',
        message: 'decisionArtifacts.behaviorSpec JSON 形状无效',
      },
    ];
  }
  const spec = normalizeBehaviorSpec(behaviorSpec);
  const violations: BehaviorSpecViolation[] = [];
  if (spec.module !== semantic) {
    violations.push({
      code: 'module-mismatch',
      message: `behaviorSpec.module=${spec.module} 与切片语义 ${semantic} 不一致`,
    });
  }
  if (spec.functions.length === 0) {
    violations.push({ code: 'empty-functions', message: 'behaviorSpec.functions 不能为空' });
  }
  for (const fn of spec.functions) {
    if (fn.conditions.length === 0) {
      violations.push({
        code: 'empty-conditions',
        message: `behaviorSpec.functions.${fn.name}.conditions 不能为空`,
      });
    }
    const ids = new Set<string>();
    for (const c of fn.conditions) {
      if (ids.has(c.id)) {
        violations.push({
          code: 'duplicate-condition-id',
          message: `behaviorSpec 条件 id 重复: ${c.id}`,
        });
      }
      ids.add(c.id);
    }
    if (fn.when_non_null != null && fn.when_non_null !== 'all' && fn.when_non_null !== 'any') {
      violations.push({
        code: 'invalid-when-non-null',
        message: `behaviorSpec.functions.${fn.name}.when_non_null 须为 all 或 any`,
      });
    }
    if (moduleExports?.length && !moduleExports.includes(fn.name)) {
      violations.push({
        code: 'function-not-in-exports',
        message: `behaviorSpec 函数 ${fn.name} 未在 modules.exports 中声明（当前 exports: ${moduleExports.join(', ')}）`,
      });
    }
  }
  return violations;
}
