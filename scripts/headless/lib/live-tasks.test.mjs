import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

import { LIVE_TASK_TIERS, resolveLiveTiers } from './live-tasks.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { detectMultiModuleLayout, countPathLikeTokens } = await import(
  path.join(HERE, '../../../packages/stagent-core/dist/path-router/multiModuleLayoutDetect.js')
)

test('resolveLiveTiers accepts tier 6 and excludes it from "all"', () => {
  assert.deepEqual(resolveLiveTiers(6), [6])
  assert.deepEqual(resolveLiveTiers('6'), [6])
  assert.deepEqual(resolveLiveTiers('all'), [1, 2, 3, 4, 5])
  assert.throws(() => resolveLiveTiers(7), /must be 1, 2, 3, 4, 5, 6, or all/)
})

test('T6 is a strict software tier with its own deterministic MVP target', () => {
  const t6 = LIVE_TASK_TIERS[6]
  assert.ok(t6, 'tier 6 must exist')
  assert.equal(t6.id, 'live-t6-deterministic-platform')
  assert.equal(t6.taskType, 'software')
  assert.equal(t6.pass.strict, true)
  assert.equal(t6.generationAttempts, 2)
  // 平台靶子 module dirs 与量化 T4 完全不同（解耦）。
  assert.deepEqual(t6.mvp.moduleDirs, ['models', 'store', 'statemachine', 'pipeline'])
  assert.equal(t6.mvp.traceability.length, 3)
  for (const rule of t6.mvp.traceability) {
    assert.ok(rule.id && rule.hint, 'each traceability rule needs id + hint')
    assert.ok(rule.pattern instanceof RegExp, 'declarative rule needs a RegExp pattern')
  }
})

test('T6 userInput triggers multi-module layout (software + >=4 path-like tokens)', () => {
  const t6 = LIVE_TASK_TIERS[6]
  assert.ok(
    countPathLikeTokens(t6.userInput) >= 4,
    `expected >=4 path-like tokens, got ${countPathLikeTokens(t6.userInput)}`,
  )
  assert.equal(
    detectMultiModuleLayout({ taskType: t6.taskType, userInput: t6.userInput }),
    true,
    'T6 must be planned as a multi-module layout (express forbidden)',
  )
})
