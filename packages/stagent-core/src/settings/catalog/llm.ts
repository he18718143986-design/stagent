import type { SettingDomainEntry } from './types';

export const LLM_SETTINGS: SettingDomainEntry[] = [
  {
    key: 'llmApiKey',
    defaultSummary: '""（空，优先 Cursor/VS Code LM）',
    effect: '备用 Direct API Key；配置后启用 HTTP 调用。',
  },
  {
    key: 'llmBaseUrl',
    defaultSummary: 'https://api.openai.com/v1',
    effect: 'Direct API Base URL。',
  },
  {
    key: 'llmModel',
    defaultSummary: 'gpt-4o',
    effect: 'Direct API 模型名。',
  },
  {
    key: 'llmTimeoutSeconds',
    defaultSummary: '300',
    effect: '单次 LLM 调用最长等待秒数。',
  },
  {
    key: 'llmMaxOutputTokens',
    defaultSummary: '16384',
    effect: 'Direct API max_tokens 上限。',
  },
  {
    key: 'agentRoleOverrides',
    defaultSummary: '{}',
    effect: '按阶段角色分配模型（decision/implementation/integration/test-write/lightweight）。',
  },
];
