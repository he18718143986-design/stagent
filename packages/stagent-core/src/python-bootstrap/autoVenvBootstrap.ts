import * as fs from 'fs';
import * as path from 'path';
import type { CodeRunnerConfig } from '../WorkflowDefinition';
import { VENV_CREATE_RESILIENT_COMMAND, withVenvPipBootstrap } from '../contract-infra/pythonVenvCommands';
import { discoverPythonTestInfraOnDisk } from '../test-infra/pythonDiskScan';

export function venvPythonExists(cwd: string): boolean {
  return discoverPythonTestInfraOnDisk(cwd).artifacts.venvPython;
}

export function buildVenvCreateRunnerConfig(cwd: string): CodeRunnerConfig {
  return {
    type: 'code-runner',
    command: VENV_CREATE_RESILIENT_COMMAND,
    captureOutput: true,
    pathBase: 'workspace',
    workingDir: cwd === '.' ? '.' : cwd,
  };
}

export function buildVenvPipRunnerConfig(cwd: string, useRequirements: boolean): CodeRunnerConfig {
  const pipTail = useRequirements ? 'pip install -r requirements.txt' : 'pip install pytest';
  const pipCmd = withVenvPipBootstrap('.venv/bin/python', pipTail);
  return {
    type: 'code-runner',
    command: pipCmd,
    captureOutput: true,
    pathBase: 'workspace',
    workingDir: cwd === '.' ? '.' : cwd,
  };
}

export function requirementsTxtOnDisk(workspaceRoot: string, cwd: string): boolean {
  const abs = path.resolve(workspaceRoot, cwd === '.' ? '' : cwd, 'requirements.txt');
  try {
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}
