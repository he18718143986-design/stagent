import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  MVP_MODULE_DIRS,
  evaluateTraceabilityRule,
  assertStrictMvpPass,
} from './mvp-acceptance.mjs'

function tmpWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-acc-test-'))
  return ws
}

function writeFile(ws, rel, content) {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

function captureError(fn) {
  try {
    fn()
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
  throw new Error('expected function to throw')
}

test('evaluateTraceabilityRule: declarative pattern + requireDirPy', () => {
  const ws = tmpWs()
  writeFile(ws, 'store/__init__.py', 'def add(title, priority=3):\n    return 1\n')
  const readText = (subs) => {
    const parts = []
    for (const sub of subs) {
      const dir = path.join(ws, sub)
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.py')) parts.push(fs.readFileSync(path.join(dir, f), 'utf8'))
      }
    }
    return parts.join('\n')
  }
  const rule = {
    id: 'crud-store',
    dirs: ['store', 'tests'],
    requireDirPy: 'store',
    pattern: /\bdef\s+add\b/,
    hint: 'store/ add',
  }
  assert.equal(evaluateTraceabilityRule(ws, rule, readText), true)

  // requireDirPy 不满足（目录无非空 .py）→ false，即便 pattern 本可命中。
  const ws2 = tmpWs()
  assert.equal(evaluateTraceabilityRule(ws2, rule, () => 'def add():'), false)
})

test('evaluateTraceabilityRule: function-style rule still supported (backward compat)', () => {
  const ws = tmpWs()
  let called = false
  const rule = {
    id: 'fn',
    check: () => {
      called = true
      return true
    },
    hint: 'fn',
  }
  assert.equal(evaluateTraceabilityRule(ws, rule, () => ''), true)
  assert.equal(called, true)
})

test('assertStrictMvpPass: custom moduleDirs/traceability drive the platform target', () => {
  // 不完整的 T6 工作区 → 报错应点名 T6 切片目录与 traceability，而非 T4 量化目录。
  const ws = tmpWs()
  writeFile(ws, 'config.yaml', 'csv_path: data.csv\n')
  const err = captureError(() =>
    assertStrictMvpPass(ws, {
      outcome: 'workflowCompleted',
      moduleDirs: ['models', 'store', 'statemachine', 'pipeline'],
      traceabilityRules: [
        { id: 'crud-store', dirs: ['store'], requireDirPy: 'store', pattern: /def add/, hint: 'store crud' },
      ],
    }),
  )
  const msg = String(err.message)
  assert.match(msg, /missing non-empty store\/\*\.py/)
  assert.match(msg, /missing non-empty statemachine\/\*\.py/)
  assert.match(msg, /traceability \[crud-store\]/)
  // 不得泄漏 T4 量化目录名。
  assert.doesNotMatch(msg, /indicators|signals|broker/)
})

test('assertStrictMvpPass: defaults to the T4 quant target when no spec.mvp given', () => {
  const ws = tmpWs()
  writeFile(ws, 'config.yaml', 'x: 1\n')
  const err = captureError(() => assertStrictMvpPass(ws, { outcome: 'workflowCompleted' }))
  const msg = String(err.message)
  for (const dir of MVP_MODULE_DIRS) {
    assert.match(msg, new RegExp(`missing non-empty ${dir}/\\*\\.py`))
  }
})
