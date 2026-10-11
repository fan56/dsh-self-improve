import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 纯本地模式守卫（用户 2026-10-11 拍板）：回路在「无 GitHub、无同步配置」的
// bundle 上必须完整可跑——saveLesson / feed / setLessonStatus 三环全通，
// 且 bundle 没有 git remote（本地提交只是回滚机制，不是上传；GitHub 同步
// 只存在于 topics-memory 的可选 onboard 配置里，与回路无关）。

let home
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'si-pure-local-'))
  process.env.DSH_TOPICS_HOME = home
  delete process.env.DSH_TOPICS_WORKSPACE_ID
})
afterEach(() => {
  delete process.env.DSH_TOPICS_HOME
  rmSync(home, { recursive: true, force: true })
})

const openPeer = async () => {
  const { openPeerHandle } = await import('../lib/feed.js')
  const handle = await openPeerHandle()
  assert.ok(handle, 'peer handle must open against a plain local bundle')
  return handle
}

test('pure-local: full lesson mini-loop runs without any remote or sync config', async () => {
  const handle = await openPeer()

  // ① 信号观察落本地 bundle（蒸馏 lane 的输入）
  const feed = await handle.feed([
    { type: 'tool-error', at: new Date().toISOString(), detail: { toolName: 'edit', errorCode: 'FS_NOT_OBSERVED', count: 3 } },
  ])
  assert.equal(feed.error, undefined)
  assert.ok(feed.accepted >= 1, 'observation must be accepted into the local bundle')

  // ② 快速通道：hint lesson 经 peer 数据面落库（saveLesson 钉 hint/workspace/correction）
  const saved = await handle.saveLesson({
    title: '纯本地守卫：编辑前先观察目标文件',
    conclusion: '编辑报 FS_NOT_OBSERVED 时先观察目标文件再改。',
    triggers: ['edit', 'fs-not-observed'],
  })
  assert.equal(saved.ok, true, 'fast-lane hint lesson must land on a sync-less local bundle')
  assert.ok(saved.slug, 'saveLesson returns the slug')

  // ③ 审批语义：hint → established 走缝②
  const promoted = await handle.setLessonStatus(saved.slug, 'established', { actor: 'dsh-self-improve:test' })
  assert.equal(promoted.ok, true, 'hint→established must work on a sync-less local bundle')

  // ④ bundle 没有 git remote——本地提交只是回滚机制，不是上传
  const { execFileSync } = await import('node:child_process')
  let remotes = ''
  try {
    remotes = execFileSync('git', ['-C', home, 'remote', 'show'], { encoding: 'utf8' })
  } catch { /* bundle 未启 git = 更纯 */ }
  assert.equal(remotes.trim(), '', 'a pure-local bundle must have no git remote configured')
})

test('pure-local: lessons() roster reflects established lessons for the BL-3 check', async () => {
  const handle = await openPeer()
  const saved = await handle.saveLesson({
    title: '纯本地守卫二：重复报错先查账本',
    conclusion: '同类错误重复出现时先查行动账再重试。',
    triggers: ['repeat', 'retry'],
  })
  assert.equal(saved.ok, true)
  await handle.setLessonStatus(saved.slug, 'established', { actor: 'dsh-self-improve:test' })
  const established = handle.lessons().filter((l) => l.slug === saved.slug)
  assert.ok(established.length >= 1, 'established lesson must be visible to the BL-3 related-lesson check')
})
