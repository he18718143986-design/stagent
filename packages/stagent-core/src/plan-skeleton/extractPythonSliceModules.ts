import {
  detectMultiModuleLayout,
  extractPathLikeTokens,
} from '../path-router/multiModuleLayoutDetect';
import { T4_DEFAULT_SLICE_MODULES } from './constants';

const SLICE_NAME_DENYLIST = new Set([
  'config',
  'tests',
  'test',
  'src',
  'docs',
  'deliver',
  'delivery',
  'cli',
  'venv',
  'requirements',
  'mock',
  'csv',
]);

function canonicalizeT4DefaultModules(
  ordered: string[],
  userInput: string,
  taskType: string,
): string[] {
  if (!detectMultiModuleLayout({ taskType, userInput })) {
    return ordered;
  }
  const defaultSet = new Set<string>(T4_DEFAULT_SLICE_MODULES);
  const hit = ordered.filter((m) => defaultSet.has(m)).length;
  if (hit >= 4) {
    return [...T4_DEFAULT_SLICE_MODULES];
  }
  return ordered;
}

function sanitizeSemantic(raw: string): string | undefined {
  const name = raw
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\.py$/i, '')
    ?.replace(/[^a-zA-Z0-9_]/g, '_')
    .toLowerCase();
  if (!name || name.length < 2 || SLICE_NAME_DENYLIST.has(name)) {
    return undefined;
  }
  if (name.startsWith('test_')) {
    return undefined;
  }
  return name;
}

/**
 * 入口/集成切片语义（main 把各模块粘合，须在依赖切片之后实现）。
 * 与 AgentSpecializationRouter.INTEGRATION_SLICE_SEMANTIC 对齐。
 */
export const ENTRY_SLICE_SEMANTICS = new Set<string>(['main']);

/**
 * 将入口/集成切片（main）排到最后：垂直切片按序推进时，集成切片硬依赖前序切片落盘，
 * 必须最后实现/验证（否则 forward-slice import 必失败、fix 链空转）。T4 凭 canonicalize
 * 恰好 main 在末位才正常；非 T4 模块名（如 models/store/...）若 LLM 决策把 main 列在前，
 * 会导致 main 先跑而团灭——此处做确定性兜底重排。
 */
export function orderEntrySliceLast(modules: string[]): string[] {
  const rest: string[] = [];
  const entry: string[] = [];
  for (const m of modules) {
    (ENTRY_SLICE_SEMANTICS.has(m) ? entry : rest).push(m);
  }
  return [...rest, ...entry];
}

/**
 * 从需求文本提取 Python 绿场垂直切片模块语义（indicators / signals / …）。
 * multiModuleLayout 命中但 token 不足时回退 T4 默认五模块。入口切片（main）恒排末位。
 */
export function extractPythonSliceModules(userInput: string, taskType = 'software'): string[] {
  const modules = new Set<string>();
  for (const token of extractPathLikeTokens(userInput)) {
    if (token.endsWith('/')) {
      const semantic = sanitizeSemantic(token.slice(0, -1));
      if (semantic) {
        modules.add(semantic);
      }
      continue;
    }
    if (/\.py$/i.test(token)) {
      const semantic = sanitizeSemantic(token);
      if (semantic) {
        modules.add(semantic);
      }
    }
  }

  const ordered = [...modules];
  if (ordered.length >= 4) {
    return orderEntrySliceLast(canonicalizeT4DefaultModules(ordered.slice(0, 8), userInput, taskType));
  }

  if (detectMultiModuleLayout({ taskType, userInput })) {
    return [...T4_DEFAULT_SLICE_MODULES];
  }

  return orderEntrySliceLast(ordered);
}
