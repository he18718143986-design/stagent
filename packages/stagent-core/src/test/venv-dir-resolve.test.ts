import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Stage } from '../WorkflowDefinition';
import {
  resolveVenvDirName,
  resolveVenvImportCheckCommand,
  resolveVenvPipInstallCommand,
} from '../contract-infra/InfraChainDetector';

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

test('resolveVenvDirName reads venv dir from prior setup stage', () => {
  const stages = [
    runnerStage(
      'stage_setup',
      'mkdir -p tests && python3 -m venv venv && venv/bin/pip install pytest',
    ),
  ];
  assert.equal(resolveVenvDirName(stages), 'venv');
  assert.match(resolveVenvPipInstallCommand(stages), /venv\/bin\/python -m pip install pytest/);
  assert.match(resolveVenvPipInstallCommand(stages), /get-pip\.py/);
  assert.match(resolveVenvImportCheckCommand(stages), /^venv\/bin\/python -c/);
});

test('resolveVenvDirName defaults to .venv', () => {
  assert.equal(resolveVenvDirName([]), '.venv');
});
