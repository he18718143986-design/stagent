import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  VENV_CREATE_RESILIENT_COMMAND,
  withVenvPipBootstrap,
} from '../contract-infra/pythonVenvCommands';
import { resolveVenvPipInstallCommand } from '../contract-infra/InfraChainDetector';
import type { Stage } from '../WorkflowDefinition';

function runnerStage(id: string, command: string): Stage {
  return {
    id,
    title: id,
    tool: 'code-runner',
    toolConfig: { type: 'code-runner', command, captureOutput: true },
    input: { sources: [], mergeStrategy: 'concat' },
    outputs: [{ key: 'out', format: 'text' }],
    pauseAfter: false,
  };
}

test('VENV_CREATE_RESILIENT_COMMAND falls back to --without-pip（Run #63）', () => {
  assert.match(VENV_CREATE_RESILIENT_COMMAND, /python3 -m venv \.venv/);
  assert.match(VENV_CREATE_RESILIENT_COMMAND, /--without-pip/);
});

test('withVenvPipBootstrap bootstraps pip before install', () => {
  const cmd = withVenvPipBootstrap('.venv/bin/python', 'pip install pytest');
  assert.match(cmd, /pip --version/);
  assert.match(cmd, /get-pip\.py/);
  assert.match(cmd, /pip install pytest/);
});

test('resolveVenvPipInstallCommand uses pip bootstrap wrapper', () => {
  const cmd = resolveVenvPipInstallCommand([
    runnerStage('stage_venv_create', VENV_CREATE_RESILIENT_COMMAND),
  ]);
  assert.match(cmd, /get-pip\.py/);
  assert.match(cmd, /\.venv\/bin\/python -m pip install pytest/);
});
