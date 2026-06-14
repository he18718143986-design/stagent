import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

/** 默认 MVP 交付目录（对照 T4 南华期货需求 §五）。 */
export const MVP_MODULE_DIRS = ['indicators', 'signals', 'risk', 'broker']

/**
 * Traceability 规则形态（SSOT，平台 + 量化任务共用）：
 *   - 声明式：{ id, dirs, pattern, requireDirPy?, hint } —— 读取 dirs（含 tests）正文，
 *     pattern 命中即通过；requireDirPy 要求该目录有非空 .py。
 *   - 函数式（兼容旧规则）：{ id, check: (ws, readText) => boolean, hint }。
 * 默认 TRACEABILITY_RULES 为 T4 量化语义规则；确定性平台任务由 spec.mvp.traceability 覆盖。
 */
export const TRACEABILITY_RULES = [
  {
    id: 'index-resonance',
    dirs: ['signals', 'tests'],
    pattern: /上证|深证|指数|index/i,
    hint: 'signals/ 或 tests/ 应含指数共振相关逻辑或 fixture',
  },
  {
    id: 'hedge-stop-loss',
    dirs: ['risk', 'tests'],
    requireDirPy: 'risk',
    pattern: /hedge|stop_loss|止损|对冲/i,
    hint: 'risk/ 非空且 tests/ 或 risk/ 含 hedge/stop_loss 相关符号',
  },
  {
    id: 'sim-broker',
    dirs: ['broker', 'src'],
    pattern: /SimBroker|BrokerAdapter/,
    hint: 'broker/ 或 src/ 含 SimBroker 或 BrokerAdapter',
  },
]

/**
 * 评估单条 traceability 规则（声明式或函数式）。
 * @param {string} ws 工作区根
 * @param {object} rule
 * @param {(subs: string[]) => string} readText
 */
export function evaluateTraceabilityRule(ws, rule, readText) {
  if (typeof rule.check === 'function') {
    return rule.check(ws, readText)
  }
  if (rule.requireDirPy && !dirHasPy(path.join(ws, rule.requireDirPy))) {
    return false
  }
  const hay = readText(Array.isArray(rule.dirs) ? rule.dirs : [])
  return rule.pattern instanceof RegExp ? rule.pattern.test(hay) : true
}

function dirHasPy(dir) {
  if (!fs.existsSync(dir)) return false
  return fs.readdirSync(dir).some((f) => f.endsWith('.py') && fs.statSync(path.join(dir, f)).size > 0)
}

function collectPyFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      collectPyFiles(full, acc)
    } else if (name.endsWith('.py') && st.size > 0) {
      acc.push(full)
    }
  }
  return acc
}

function readWorkspaceText(ws, subdirs) {
  const parts = []
  for (const sub of subdirs) {
    const root = path.join(ws, sub)
    for (const file of collectPyFiles(root)) {
      try {
        parts.push(fs.readFileSync(file, 'utf8'))
      } catch {
        /* skip */
      }
    }
    if (sub === 'tests' && fs.existsSync(root)) {
      for (const f of fs.readdirSync(root)) {
        if (f.endsWith('.py')) {
          try {
            parts.push(fs.readFileSync(path.join(root, f), 'utf8'))
          } catch {
            /* skip */
          }
        }
      }
    }
  }
  return parts.join('\n')
}

function findMainEntry(ws) {
  const candidates = ['main.py', 'cli.py', path.join('src', 'main.py')]
  for (const rel of candidates) {
    const p = path.join(ws, rel)
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return rel
  }
  return null
}

function findTestFiles(ws) {
  const testsDir = path.join(ws, 'tests')
  if (!fs.existsSync(testsDir)) return []
  return fs
    .readdirSync(testsDir)
    .filter((f) => f.startsWith('test_') && f.endsWith('.py'))
    .map((f) => path.join('tests', f))
}

/**
 * 运行 pytest（优先 .venv）。
 * @returns {{ exitCode: number, cmd: string }}
 */
export function runPytestInWorkspace(ws) {
  const venvPy = path.join(ws, '.venv', 'bin', 'python')
  const python = fs.existsSync(venvPy) ? venvPy : 'python3'
  const r = spawnSync(python, ['-m', 'pytest', 'tests/', '-q'], {
    cwd: ws,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: ws },
  })
  return {
    exitCode: r.status ?? 1,
    cmd: `${python} -m pytest tests/ -q`,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

/**
 * Strict MVP 验收（T4/T5 量化任务 + T6 确定性平台任务共用）。
 * 量化语义靶子（module dirs / traceability）默认为南华期货；确定性平台任务通过
 * opts.moduleDirs / opts.traceabilityRules 覆盖，使「平台正确性」与「量化语义」解耦
 * （决策记录 D2/D3）。
 * @param {string} ws 工作区根
 * @param {{ outcome?: string, requireTraceability?: boolean, moduleDirs?: string[], traceabilityRules?: object[] }} opts
 */
export function assertStrictMvpPass(ws, opts = {}) {
  const errors = []
  const warnings = []
  const moduleDirs = Array.isArray(opts.moduleDirs) && opts.moduleDirs.length > 0
    ? opts.moduleDirs
    : MVP_MODULE_DIRS
  const traceabilityRules = Array.isArray(opts.traceabilityRules)
    ? opts.traceabilityRules
    : TRACEABILITY_RULES

  if (opts.outcome && opts.outcome !== 'workflowCompleted') {
    errors.push(`strict requires workflowCompleted (got: ${opts.outcome})`)
  }

  const configPath = path.join(ws, 'config.yaml')
  if (!fs.existsSync(configPath) || fs.statSync(configPath).size === 0) {
    errors.push('missing or empty config.yaml')
  }

  for (const dir of moduleDirs) {
    const full = path.join(ws, dir)
    if (!dirHasPy(full)) {
      errors.push(`missing non-empty ${dir}/*.py`)
    }
  }

  if (!findMainEntry(ws)) {
    errors.push('missing main entry (main.py, cli.py, or src/main.py)')
  }

  const tests = findTestFiles(ws)
  if (tests.length === 0) {
    errors.push('missing tests/test_*.py')
  }

  const deliveryPath = path.join(ws, 'DELIVERY.md')
  if (!fs.existsSync(deliveryPath) || fs.statSync(deliveryPath).size === 0) {
    errors.push('missing or empty DELIVERY.md')
  } else {
    const delivery = fs.readFileSync(deliveryPath, 'utf8')
    if (/未实现指数共振/.test(delivery) && /完整.*测试|测试.*正确|全部.*PASSED/i.test(delivery)) {
      warnings.push('DELIVERY.md contradicts: claims full tests but notes missing index resonance')
    }
  }

  const pytest = runPytestInWorkspace(ws)
  if (pytest.exitCode !== 0) {
    errors.push(`pytest failed (exit ${pytest.exitCode}): ${pytest.stderr.slice(0, 400)}`)
  }

  if (opts.requireTraceability !== false) {
    const readText = (subs) => readWorkspaceText(ws, subs)
    for (const rule of traceabilityRules) {
      if (!evaluateTraceabilityRule(ws, rule, readText)) {
        errors.push(`traceability [${rule.id}]: ${rule.hint}`)
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`strict MVP acceptance failed:\n- ${errors.join('\n- ')}`)
  }

  return {
    pytestExit: pytest.exitCode,
    testFiles: tests,
    warnings,
  }
}
