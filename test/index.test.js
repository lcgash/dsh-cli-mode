import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('plugin module exports the cordis shape', async () => {
  const mod = await import(path.join(root, 'lib', 'index.js'))
  assert.equal(mod.name, 'cli-mode')
  assert.deepEqual(mod.inject, ['webServer'])
  assert.equal(typeof mod.apply, 'function')
})

test('plugin-source.txt carries the raw plugin body', () => {
  const txt = readFileSync(path.join(root, 'lib', 'plugin-source.txt'), 'utf8')
  assert.ok(txt.includes('return {'))
  assert.ok(txt.includes('async apply(ctx)'))
  assert.ok(txt.includes('/dsh-cli/health'))
})

test('client script parses', () => {
  const src = readFileSync(path.join(root, 'bin', 'dsh-cli.mjs'), 'utf8')
  assert.ok(src.includes('function loadPluginSource'))
  assert.ok(src.includes('/dsh-cli/permission'))
})
