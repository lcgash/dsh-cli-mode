#!/usr/bin/env node
/**
 * dsh-cli — 在终端里直接和 DeepSeek Harness 的 agent 对话,不用打开 GUI 页面。
 * 逻辑类似 codex:在哪个目录启动,哪个目录就是工作区(会话 cwd = 终端 pwd)。
 *
 * 前提:harness 里运行着 cli-mode 插件(注册 /dsh-cli/* 路由)。
 *
 * 用法:
 *   node dsh-cli.mjs                    # 默认:在当前目录开一个全新会话(Codex 式)
 *   node dsh-cli.mjs --resume [id]      # 恢复历史会话(不带 id 时弹出选择菜单)
 *   node dsh-cli.mjs --attach <id>      # 接到某个 live 会话
 *   node dsh-cli.mjs --show-reasoning   # 思考内容实时显示(默认折叠,/think 可看)
 *   node dsh-cli.mjs --url http://127.0.0.1:3080
 *
 * 输入 / 即弹出竖排命令菜单(↑↓ 选择,输入过滤,Enter 执行,Esc 取消);命令:
 *   /help            帮助
 *   /sessions        列出 live 会话和可恢复的历史会话
 *   /switch [id]     切换对话:不带 id 时从 live 会话里选(↑↓ 选择)
 *   /attach <id>     切到某个 live 会话
 *   /open [cwd]      开一个全新会话(默认用当前终端目录)
 *   /resume [id]     恢复历史:不带 id 时弹出选择菜单
 *   /close <id>      关闭本 CLI 开出的会话(历史保留,可再 resume)
 *   /think           显示最近一次思考内容(默认折叠,不占屏)
 *   /cancel          取消当前 turn
 *   /clear           清屏
 *   /exit 或 Ctrl+C  退出
 * 行尾加反斜杠 \ 可续行(多行输入)。
 */
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const take = (flag, fb) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fb
}
const resumeId = take('--resume', undefined)
const attachId = take('--attach', take('--session', undefined))
const openCwd = take('--cwd', undefined)
const showReasoning = args.includes('--show-reasoning')
const resumePicker = args.includes('--resume') && resumeId === undefined
let sessionId = resumeId || attachId || ''

// ---- local config (~/.dsh/cli.config): remembers the web address ----
const CONFIG_DIR = path.join(homedir(), '.dsh')
const CONFIG_FILE = path.join(CONFIG_DIR, 'cli.config')
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch (e) { return {} }
}
function saveConfig(newCfg) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(newCfg, null, 2) + '\n')
  } catch (e) { /* non-fatal */ }
}

const cfg = loadConfig()
const urlFromArg = take('--url', undefined)
let BASE = (urlFromArg || cfg.url || 'http://127.0.0.1:3080').replace(/\/+$/, '')
if (urlFromArg) { cfg.url = BASE; saveConfig(cfg) }

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
}

const COMMANDS = ['/help', '/sessions', '/switch', '/attach', '/open', '/resume', '/close', '/mode', '/model', '/permission', '/tools', '/think', '/transcript', '/cancel', '/clear', '/exit', '/url']

// ---- approval bridging via the harness mux stream ----
// the web answerer owns approval/request, so the CLI subscribes to the mux
// (GET /api/events.mux) and answers through POST /api/respond — the GUI path.
let pendingApproval = null  // { rpcId, approvalId, sessionId }
let muxCtrl = null

async function startMux() {
  while (true) {
    let ws
    try {
      const wsUrl = BASE.replace(/^http/, 'ws') + '/api/events.mux'
      ws = new WebSocket(wsUrl)
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', () => reject(new Error('mux ws connect failed')), { once: true })
      })
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return
        try { handleMuxFrame(JSON.parse(ev.data)) } catch (e) { /* bad frame */ }
      })
      await new Promise((resolve) => {
        ws.addEventListener('close', resolve, { once: true })
        ws.addEventListener('error', resolve, { once: true })
      })
      writeLine(C.dim + '↻ mux disconnected, reconnecting…' + C.reset)
    } catch (e) {
      if (muxCtrl && muxCtrl.signal && muxCtrl.signal.aborted) return
      writeLine(C.dim + '↻ mux error: ' + e.message + ', retrying…' + C.reset)
      try { if (ws) ws.close() } catch (e2) { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
}

function handleMuxFrame(frame) {
  const payload = frame && frame.payload
  if (!payload) return
  if (payload.type === 'approval/requested') {
    if (sessionId && payload.sessionId && payload.sessionId !== sessionId) return
    pendingApproval = { rpcId: frame.rpcId, approvalId: payload.approvalId, sessionId: payload.sessionId }
    writeLine(C.yellow + C.bold + '🔐 授权请求' + C.reset + C.yellow + ' (' + (payload.toolName || 'tool') + ')' + C.reset)
    if (payload.reason) writeLine(C.yellow + '  ' + payload.reason + C.reset)
    writeLine(C.dim + '  y = 允许一次 | n = 拒绝' + C.reset)
  } else if (payload.type === 'approval/resolved') {
    if (pendingApproval && pendingApproval.rpcId === frame.rpcId) pendingApproval = null
  }
}

async function answerApproval(approve) {
  const p = pendingApproval
  if (!p) { writeLine(C.yellow + '(没有待处理的授权请求)' + C.reset); return }
  pendingApproval = null
  try {
    const res = await fetch(BASE + '/api/respond', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response', rpcId: p.rpcId,
        result: { ok: true, value: { sessionId: p.sessionId, approvalId: p.approvalId, outcome: approve ? 'allowed-once' : 'rejected' } },
      }),
    })
    const j = await res.json()
    if (j && j.accepted) writeLine(approve ? C.green + '✓ 已允许' + C.reset : C.red + '✗ 已拒绝' + C.reset)
    else writeLine(C.yellow + '(授权响应未接受,可能已过期)' + C.reset)
  } catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
}

// ---- streaming / reasoning state ----
let streaming = false        // mid-stream: current line belongs to the agent
let sawText = false          // this step saw live text deltas
let reasoningActive = false  // model is emitting reasoning right now
let lastReasoning = ''       // accumulated reasoning of the current turn (/think)
let agentBusy = false        // agent turn in flight — don't flash the prompt
let thinkShown = false       // ⋯ thinking… indicator currently visible
let thinkTimer = null
let reasoningChars = 0
let toolVerbose = false      // /tools on: 显示每个工具调用;off(默认): 仅错误 + 回合汇总
let turnToolCount = 0
const turnToolNames = new Set()
let outBuf = ''
let outTimer = null
let menuActive = false       // a raw-mode menu owns the screen

// raw-mode-safe output: readline keeps the terminal in raw mode, which disables
// the \n -> \r\n translation (ONLCR), so every newline must carry an explicit \r
function crlf(text) {
  return String(text).replace(/\n/g, '\r\n')
}

function log(...parts) {
  process.stdout.write(crlf(parts.map((p) => (p === undefined ? 'undefined' : p)).join(' ') + '\n'))
}

function err(...parts) {
  log(C.red + parts.map((p) => (p === undefined ? 'undefined' : p)).join(' ') + C.reset)
}

function flushOut() {
  if (outBuf && !menuActive) { process.stdout.write(outBuf); outBuf = '' }
}

function visibleLen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length
}

function renderInline(s) {
  s = String(s)
  s = s.replace(/`([^`]+)`/g, (_m, c) => C.yellow + c + C.reset)
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => C.bold + t + C.reset)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p, t) => p + C.italic + t + C.reset)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => t + C.dim + ' (' + u + ')' + C.reset)
  return s
}

function renderCodeBlock(code, lang) {
  const fence = '```' + (lang || '')
  return [C.dim + fence + C.reset, ...code.split('\n').map((l) => '    ' + l), C.dim + '```' + C.reset].join('\r\n')
}

function renderTable(lines) {
  const rows = lines.map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
  let headerIdx = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length > 0 && rows[i].every((c) => /^:?-{1,}:?$/.test(c))) { headerIdx = i; break }
  }
  const body = headerIdx >= 0 ? rows.filter((_r, i) => i !== headerIdx) : rows
  if (body.length === 0) return lines.map((l) => renderInline(l)).join('\r\n')
  const cols = Math.max(...body.map((r) => r.length))
  const widths = []
  for (let c = 0; c < cols; c++) {
    widths.push(Math.max(3, ...body.map((r) => (r[c] !== undefined ? visibleLen(renderInline(r[c])) : 0))))
  }
  const fmt = (cells) => {
    const padded = []
    for (let c = 0; c < cols; c++) {
      const cell = renderInline(cells[c] !== undefined ? cells[c] : '')
      padded.push(cell + ' '.repeat(Math.max(0, widths[c] - visibleLen(cell))))
    }
    return '  ' + padded.join(C.dim + ' │ ' + C.reset)
  }
  const out = []
  if (headerIdx >= 0) out.push(fmt(body[0]))
  out.push('  ' + widths.map((w) => '─'.repeat(w)).join('─┼─'))
  for (let i = headerIdx >= 0 ? 1 : 0; i < body.length; i++) out.push(fmt(body[i]))
  return out.join('\r\n')
}

function renderMarkdown(text) {
  const lines = String(text).split('\n')
  const out = []
  let inCode = false
  let codeLang = ''
  let codeBuf = []
  let tableBuf = []
  const flushTable = () => {
    if (tableBuf.length > 0) { out.push(renderTable(tableBuf)); tableBuf = [] }
  }
  const flushCode = () => {
    if (codeBuf.length > 0) { out.push(renderCodeBlock(codeBuf.join('\n'), codeLang)); codeBuf = [] }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const fence = /^```+/.exec(line)
    if (fence) {
      flushTable()
      if (!inCode) { inCode = true; codeLang = line.slice(fence[0].length).trim() }
      else flushCode()
      inCode = !inCode
      continue
    }
    if (inCode) { codeBuf.push(raw); continue }
    if (/^\s*\|/.test(line)) { tableBuf.push(line); continue }
    flushTable()
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { out.push((h[1].length <= 2 ? C.bold + C.cyan : C.bold) + renderInline(h[2]) + C.reset); continue }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push(C.dim + '─'.repeat(Math.min(48, process.stdout.columns || 80)) + C.reset); continue }
    if (/^\s*>\s?/.test(line)) { out.push(C.dim + '│ ' + C.reset + renderInline(line.replace(/^\s*>\s?/, ''))); continue }
    const li = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (li) { out.push('  ' + (li[1].match(/\d/) ? C.dim + li[1] + C.reset : C.dim + '•' + C.reset) + ' ' + renderInline(li[2])); continue }
    out.push(renderInline(line))
  }
  flushTable()
  flushCode()
  return out.join('\r\n')
}

// ---- 流式:文本先攒起来,~90ms 原地重渲染成 markdown(保持流式 + 渲染) ----
let stepText = ''
let stepLines = 0
let renderTimer = null

function renderStepText() {
  renderTimer = null
  if (!streaming || stepText === '') return
  if (stepLines > 0) process.stdout.write('\x1b[' + stepLines + 'A')
  process.stdout.write('\x1b[J')
  const rendered = renderMarkdown(stepText)
  process.stdout.write(rendered)
  stepLines = rendered.split('\r\n').length
}

function clearThink() {
  if (thinkTimer !== null) { clearTimeout(thinkTimer); thinkTimer = null }
  if (thinkShown) { process.stdout.write('\x1b[2K\r'); thinkShown = false }
}

function finalizeStream() {
  clearThink()
  if (streaming) {
    if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null }
    renderStepText()
    process.stdout.write('\r\n')
    streaming = false
  }
  reasoningActive = false
  stepText = ''
  stepLines = 0
}

function pushText(t) {
  if (!streaming) { process.stdout.write('\x1b[2K\r'); streaming = true }
  thinkShown = false
  sawText = true
  stepText += t
  if (renderTimer === null) renderTimer = setTimeout(renderStepText, 90)
}

// 清掉当前行再输出(适合整行消息)
function writeLine(text) {
  if (menuActive) return
  finalizeStream()
  process.stdout.write('\x1b[2K\r' + crlf(text) + '\r\n')
}

async function api(path, opts) {
  const res = await fetch(BASE + path, opts)
  return res.json()
}

// native harness RPC (POST /api/<method>), same wire as the web GUI
async function rpc(method, payload) {
  const res = await fetch(BASE + '/api/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'cli-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), method, payload }),
  })
  let j
  try { j = await res.json() } catch (e) { throw new Error('rpc ' + method + ': bad response (http ' + res.status + ')') }
  const r = j && j.result
  if (!r) throw new Error('rpc ' + method + ': bad envelope')
  if (!r.ok) throw new Error('rpc ' + method + ': ' + ((r.error && (r.error.message || r.error.code)) || 'failed'))
  return r.value
}

// read one line WITHOUT raw mode: the terminal keeps cooked echo, so typing,
// IME composition and paste behave like a normal prompt (no double-echo)
function ask(question, def) {
  return new Promise((resolve) => {
    process.stdout.write(crlf(question))
    const r = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
    r.on('line', (line) => { r.close(); resolve(line.trim() || def) })
  })
}

// first use: install the cli-mode plugin into the harness via a session agent
// (the harness only installs plugins through the model's cordis_define/run tools,
// and those tools only exist in sessions composed from the `cordis` preset)
// 自举安装的插件源码:包布局 lib/plugin-source.txt,开发布局 dsh-cli-plugin.js
function loadPluginSource() {
  const candidates = [
    path.join(CLI_DIR, '..', 'lib', 'plugin-source.txt'),
    path.join(CLI_DIR, 'dsh-cli-plugin.js'),
    path.join(CLI_DIR, '..', 'dsh-cli-plugin.js'),
  ]
  for (const p of candidates) {
    try {
      const txt = readFileSync(p, 'utf8')
      if (txt.includes('return {')) return txt
    } catch (e) { /* try next */ }
  }
  return null
}

async function bootstrap() {
  let pluginSrc = loadPluginSource()
  if (!pluginSrc) return { ok: false, reason: 'plugin-file-missing' }
  let sid
  try {
    const items = (await rpc('session.list', {})).items || []
    const cordisSessions = items.filter((it) => it.agentPreset === 'cordis')
    const idle = cordisSessions.find((it) => !it.running)
    sid = (idle || cordisSessions[0] || {}).sessionId
  } catch (e) { /* fall through to create */ }
  if (!sid) {
    try {
      const created = await rpc('session.create', { cwd: process.cwd(), agentPreset: 'cordis' })
      sid = created.sessionId
    } catch (e) {
      return { ok: false, reason: 'no-cordis-session', detail: e.message }
    }
  }
  const msg = [
    '【CLI 自举安装】请立即执行以下两步,不要修改任何代码:',
    '1. 调用 cordis_define 工具,参数:plugin.kind = "new",idPrefix = "clim",name = "cli-mode",purpose = "终端 CLI 桥接插件(由 dsh-cli 自举安装)",code.host 必须为下面 ```js 围栏内的代码,逐字原样使用(不要修改、不要省略、不要加 TypeScript 类型)。',
    '2. 定义成功后,调用 cordis_run 工具,参数:pluginId 和 packageId 用步骤 1 返回的,mode = "run"。',
    '3. 两步都成功后,用一句话确认。',
    '```js',
    pluginSrc,
    '```',
  ].join('\n')
  try {
    await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: msg }] })
  } catch (e) {
    return { ok: false, reason: 'prompt-failed', detail: e.message }
  }
  return { ok: true, sessionId: sid }
}

async function ensurePlugin() {
  try {
    const h = await api('/dsh-cli/health')
    if (h && h.ok) return true
  } catch (e) { /* not active */ }
  writeLine(C.yellow + 'cli-mode 插件未激活,正在自动安装(约需数十秒)…' + C.reset)
  const boot = await bootstrap()
  if (!boot.ok) {
    if (boot.reason === 'no-session') err(C.red + '✗ 没有可用会话:请先打开一次网页页面(会自动创建会话并配置 API key),再运行本 CLI。' + C.reset)
    else if (boot.reason === 'plugin-file-missing') err(C.red + '✗ 缺少 ' + C.reset + path.join(CLI_DIR, 'dsh-cli-plugin.js'))
    else err(C.red + '✗ 安装消息发送失败: ' + C.reset + (boot.detail || boot.reason))
    return false
  }
  writeLine(C.dim + '  安装消息已发给会话 ' + shortId(boot.sessionId) + ',等待插件上线…' + C.reset)
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const h = await api('/dsh-cli/health')
      if (h && h.ok) { writeLine(C.green + '✓ cli-mode 插件已自动安装并启用' + C.reset); return true }
    } catch (e) { /* keep polling */ }
  }
  err(C.red + '✗ 安装超时:请到网页会话查看安装进度(可能缺少 API key,需在网页配置)后重试。' + C.reset)
  return false
}

function shortId(id) {
  return typeof id === 'string' && id.length > 16 ? id.slice(0, 8) + '…' + id.slice(-6) : String(id)
}

// ---- vertical menu (claude-style: ↑↓ navigate, type to filter, Enter/Esc) ----
// opts: { title?, items: [{id,label,detail?}], filter?, initial?, onEnterNoMatch? }
function showMenu(opts) {
  if (!process.stdin.isTTY) return showMenuFallback(opts)
  return new Promise((resolve) => {
    if (menuActive) return resolve(null)
    menuActive = true
    finalizeStream()
    let query = opts.initial || ''
    let cursor = 0
    let pendingBuf = ''
    let escTimer = null
    let done = false

    const items = opts.items || []
    const filtered = () => items.filter((it) => !query || String(it.label).toLowerCase().includes(query.toLowerCase()))

    // alternate screen: the menu is modal and full-screen, so navigating
    // never scrolls the main conversation and closing restores it exactly
    function render() {
      const list = filtered()
      if (list.length > 0 && cursor > list.length - 1) cursor = list.length - 1
      const out = []
      if (opts.title) out.push(C.bold + opts.title + C.reset)
      if (opts.filter) out.push(C.gray + '> ' + query + '_' + C.reset)
      const rows = process.stdout.rows || 24
      const height = Math.max(4, rows - out.length - 2)
      const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), Math.max(0, list.length - height)))
      const end = Math.min(list.length, start + height)
      for (let i = start; i < end; i++) {
        const it = list[i]
        const sel = i === cursor
        out.push((sel ? C.cyan + '▸ ' : '  ') + it.label + C.reset + (it.detail ? C.dim + '  ' + it.detail + C.reset : ''))
      }
      if (list.length === 0) out.push(C.yellow + '  (no match)' + C.reset)
      let s = '\x1b[?25l\x1b[H\x1b[2J' + out.join('\r\n')
      if (list.length > end) s += '\r\n' + C.dim + '… ' + (list.length - end) + ' more' + C.reset
      s += C.gray + '\r\n\r\n↑↓ move · enter select · esc cancel' + C.reset + '\x1b[?25h'
      process.stdout.write(s)
    }

    const finish = (val) => {
      if (done) return
      done = true
      if (escTimer !== null) clearTimeout(escTimer)
      process.stdin.removeListener('data', onData)
      try { process.stdout.write('\x1b[?25h\x1b[?1049l\x1b8') } catch (e) { /* ignore */ }
      rl.resume()
      try { process.stdin.setRawMode(true) } catch (e) { /* ignore */ } // readline expects raw mode
      menuActive = false
      resolve(val)
    }

    function handleKeys(chunk) {
      pendingBuf += chunk.toString('utf8')
      while (pendingBuf.length) {
        if (pendingBuf.startsWith('\x1b[') || pendingBuf.startsWith('\x1bO')) {
          if (pendingBuf.length < 3) return
          if (escTimer !== null) { clearTimeout(escTimer); escTimer = null }
          const seq = pendingBuf.slice(0, 3)
          pendingBuf = pendingBuf.slice(3)
          const c = seq[2]
          if (c === 'A') { const l = filtered().length; if (cursor > 0) { cursor--; render() } }
          else if (c === 'B') { const l = filtered().length; if (cursor < l - 1) { cursor++; render() } }
          continue
        }
        if (pendingBuf === '\x1b') {
          // lone escape: cancel after a short grace (may be start of a sequence)
          if (escTimer === null) escTimer = setTimeout(() => { escTimer = null; finish(null) }, 60)
          return
        }
        if (escTimer !== null) { clearTimeout(escTimer); escTimer = null }
        const ch = pendingBuf[0]
        pendingBuf = pendingBuf.slice(1)
        if (ch === '\r' || ch === '\n') {
          const list = filtered()
          if (list.length > 0) { finish(list[cursor].id); return }
          if (opts.onEnterNoMatch) opts.onEnterNoMatch('/' + query)
          finish(null)
          return
        }
        if (ch === '\x03') { finish(null); return }
        if (ch === '\x7f' || ch === '\x08') {
          if (query.length) { query = query.slice(0, -1); cursor = 0; render() }
          continue
        }
        if (opts.filter && ch >= ' ') { query += ch; cursor = 0; render() }
      }
    }

    const onData = (chunk) => { try { handleKeys(chunk) } catch (e) { finish(null) } }
    try {
      rl.pause()
      process.stdout.write('\x1b7\x1b[?1049h') // save cursor + enter alternate screen (modal menu)
      process.stdin.setRawMode(true)
      process.stdin.on('data', onData)
      process.stdin.resume()
      render()
    } catch (e) {
      finish(null)
    }
  })
}

// non-TTY fallback: numbered list + numbered answer (for piped use/tests)
function showMenuFallback(opts) {
  const items = opts.items || []
  if (items.length === 0) { writeLine(C.yellow + '(nothing to pick)' + C.reset); return Promise.resolve(null) }
  items.forEach((it, i) => {
    writeLine('  ' + C.cyan + (i + 1) + C.reset + '  ' + it.label + (it.detail ? C.dim + '  ' + it.detail + C.reset : ''))
  })
  asking = true
  rl.setPrompt(C.dim + 'select # (Enter = cancel) > ' + C.reset)
  rl.prompt()
  const p = new Promise((resolve) => { pickState = { items, resolve } })
  while (pickState !== null && holdQueue.length > 0) routeToPicker(holdQueue.shift())
  return p.then((it) => { asking = false; rl.setPrompt(PROMPT); return it ? it.id : null })
}

function routeToPicker(line) {
  const n = parseInt(line.trim(), 10)
  const items = pickState.items
  const chosen = Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : null
  const resolve = pickState.resolve
  pickState = null
  resolve(chosen)
}

function renderEvent(ev) {
  if (menuActive) return
  switch (ev.type) {
    case 'hello': {
      if (!streamBannerShown) {
        streamBannerShown = true
        log(
          C.bold + '◉ DSH CLI' + C.reset + ' → ' + C.cyan + BASE + C.reset +
          (ev.sessionId ? '  (session ' + C.yellow + shortId(ev.sessionId) + C.reset + ')' : '')
        )
        if (ev.cwd) log(C.bold + '  workspace' + C.reset + ' ' + C.green + ev.cwd + C.reset)
      }
      // first prompt waits for the banner so the input box lands at the bottom
      if (!promptShown) { promptShown = true; prompt() }
      break
    }
    case 'status':
      if (ev.status === 'running') { agentBusy = true; writeLine(C.yellow + '● agent working…' + C.reset) }
      else if (ev.status === 'idle') { agentBusy = false; justSent = false; prompt() }
      break
    case 'text-delta':
      pushText(ev.text)
      break
    case 'reasoning-start':
      reasoningActive = true
      reasoningChars = 0
      clearThink()
      if (!showReasoning) {
        thinkTimer = setTimeout(() => {
          thinkTimer = null
          if (!streaming && reasoningChars > 12 && !menuActive) {
            thinkShown = true
            process.stdout.write('\x1b[2K\r' + C.gray + '⋯ thinking…' + C.reset)
          }
        }, 250)
      }
      break
    case 'reasoning-delta':
      reasoningChars += (ev.text || '').length
      lastReasoning += ev.text
      if (showReasoning) {
        if (!streaming) { process.stdout.write('\x1b[2K\r'); streaming = true }
        outBuf += C.gray + C.italic + ev.text + C.reset
        if (outTimer === null) outTimer = setTimeout(() => { outTimer = null; flushOut() }, 16)
      } else if (thinkTimer !== null && reasoningChars > 12 && !streaming && !thinkShown) {
        clearTimeout(thinkTimer)
        thinkTimer = null
        thinkShown = true
        process.stdout.write('\x1b[2K\r' + C.gray + '⋯ thinking…' + C.reset)
      }
      break
    case 'reasoning-end':
      if (showReasoning) flushOut()
      clearThink()
      break
    case 'step-end':
      finalizeStream()
      sawText = false
      break
    case 'assistant':
      // fallback: provider streamed no chunks, print assembled text now
      if (!sawText) {
        for (const b of ev.blocks || []) {
          if (b.kind === 'text') writeLine(b.text)
          else if (b.kind === 'reasoning') lastReasoning += b.text
        }
      }
      break
    case 'tool-start': {
      turnToolCount++
      if (ev.name) turnToolNames.add(ev.name)
      if (toolVerbose) {
        const raw = String(ev.args || '')
        const preview = raw.replace(/\s+/g, ' ').slice(0, 120)
        writeLine(C.cyan + '⚙ ' + ev.name + C.dim + (preview ? ' ' + preview + (raw.length > 120 ? '…' : '') : '') + C.reset)
      }
      break
    }
    case 'tool-end':
      if (ev.error) writeLine(C.red + '✗ ' + ev.name + ' failed: ' + ev.error + C.reset)
      break
    case 'turn-end':
      agentBusy = false
      finalizeStream()
      if (ev.reason === 'aborted') writeLine(C.yellow + '⏹ turn cancelled' + C.reset)
      else if (ev.reason !== 'completed') writeLine(C.yellow + '⏹ turn ended: ' + ev.reason + C.reset)
      if (turnToolCount > 0 && !toolVerbose) {
        const names = [...turnToolNames].join(', ')
        writeLine(C.dim + '⚙ ' + turnToolCount + ' 个工具调用' + (names ? ' (' + names + ')' : '') + C.reset)
      }
      if (ev.reason === 'completed') {
        writeLine(C.green + '✓ 完成' + C.reset + C.dim + ' ─────────────────────' + C.reset)
      }
      turnToolCount = 0
      turnToolNames.clear()
      reasoningChars = 0
      lastReasoning = ''
      prompt()
      break
    case 'agent-error':
      writeLine(C.red + '✗ agent error: ' + (ev.message || 'unknown') + C.reset)
      break
  }
}

// ---- SSE stream: reconnect whenever the target session changes ----
let streamCtrl = null
let streamBannerShown = false

function reconnectStream() {
  if (streamCtrl) { try { streamCtrl.abort() } catch (e) { /* ignore */ } streamCtrl = null }
}

async function startStream() {
  while (true) {
    const ctrl = new AbortController()
    streamCtrl = ctrl
    try {
      const url = BASE + '/dsh-cli/stream' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '')
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok || !res.body) throw new Error('stream http ' + res.status)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const ln of frame.split('\n')) {
            if (ln.startsWith('data: ')) {
              try { renderEvent(JSON.parse(ln.slice(6))) } catch (e) { /* bad frame */ }
            }
          }
        }
      }
      writeLine(C.dim + '↻ stream disconnected, reconnecting…' + C.reset)
    } catch (e) {
      if (!ctrl.signal.aborted) writeLine(C.dim + '↻ stream error: ' + e.message + ', retrying…' + C.reset)
    } finally {
      if (streamCtrl === ctrl) streamCtrl = null
    }
    await new Promise((r) => setTimeout(r, ctrl.signal.aborted ? 60 : 1500))
  }
}

// created lazily in initUI(), after the first-use config prompt (so ask() owns stdin first)
let rl = null
const PROMPT = 'dsh ❯ '
let pending = ''
let asking = false
let pickState = null          // non-TTY picker fallback: { items, resolve }
const holdQueue = []          // serialized input processing
let busy = false
let ready = false             // input queue only drains after bootstrap completes
let promptShown = false        // first prompt waits for the stream hello banner
let justSent = false          // message just sent — prompt returns at turn end             // input queue only drains after bootstrap completes

let promptTimer = null
let currentModel = null      // { provider, model, reasoningEffort } — bottom status line

async function refreshModel() {
  if (!sessionId) return
  try {
    const m = await rpc('session.models', { sessionId: sessionId })
    if (m && m.current) currentModel = m.current
  } catch (e) { /* keep the last known model */ }
}

function prompt() {
  if (rl === null || rl.closed) return // stdin EOF (piped input) already closed the interface
  if (promptTimer !== null) return     // coalesce rapid calls (menu close + command tail)
  promptTimer = setTimeout(() => {
    promptTimer = null
    if (rl === null || rl.closed) return
    // codex-like bottom status line: current model + reasoning effort, dim
    if (currentModel && currentModel.model) {
      let st = 'dsh · ' + currentModel.model
      if (currentModel.reasoningEffort) st += ' · ' + currentModel.reasoningEffort
      process.stdout.write('\x1b[2K\r' + C.dim + st + C.reset + '\r\n')
    }
    rl.setPrompt(PROMPT)
    rl.prompt()
  }, 30)
}

// typing `/` opens the claude-style command menu
async function openCommandMenu() {
  const cmd = await showMenu({
    title: 'commands',
    filter: true,
    items: COMMANDS.map((c) => ({ id: c, label: c })),
    onEnterNoMatch: (q) => command(q),
  })
  if (cmd) await command(cmd)
  prompt() // restore the input box after the menu flow
}

function initUI() {
  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  rl.input.on('keypress', (str, key) => {
    if (!process.stdin.isTTY) return            // piped input: readline still emits keypress per char
    if (menuActive || asking || streaming) return
    if (!str || key.ctrl || key.meta) return
    if (key.name === 'return') return
    if (rl.line.startsWith('/')) {
      rl.line = ''
      openCommandMenu()
    }
  })
  rl.on('line', (line) => {
    if (pickState !== null) { routeToPicker(line); return }
    holdQueue.push(line)
    pump()
  })
  rl.on('SIGINT', () => {
    if (menuActive) return
    process.stdout.write('\r\n' + C.dim + 'bye' + C.reset + '\r\n')
    process.exit(0)
  })
}

async function doOpen(cwd) {
  try {
    const j = await api('/dsh-cli/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: cwd || process.cwd() }),
    })
    if (j.sessionId) {
      sessionId = j.sessionId
      reconnectStream()
      writeLine(C.green + '◇ opened session ' + shortId(j.sessionId) + C.reset +
        (j.cwd ? C.dim + '  [workspace ' + j.cwd + ']' + C.reset : ''))
    } else writeLine(C.red + '✗ ' + (j.error || 'open failed') + C.reset)
    await refreshModel()
} catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
}

async function doResume(id) {
  try {
    const j = await api('/dsh-cli/resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id }),
    })
    if (j.sessionId) {
      sessionId = j.sessionId
      reconnectStream()
      writeLine(C.green + '↩ resumed session ' + shortId(j.sessionId) + C.reset +
        (j.title ? '  ' + C.yellow + j.title + C.reset : '') +
        (j.cwd ? C.dim + '  [workspace ' + j.cwd + ']' + C.reset : ''))
      await printTranscript(id, 15)
    } else writeLine(C.red + '✗ ' + (j.error || 'resume failed') + C.reset)
    await refreshModel()
} catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
}

async function printTranscript(id, limit) {
  try {
    const j = await api('/dsh-cli/transcript?sessionId=' + encodeURIComponent(id) + '&limit=' + (limit || 30))
    const msgs = j.messages || []
    if (msgs.length === 0) { writeLine(C.dim + '(no previous messages)' + C.reset); return }
    writeLine(C.dim + '── history ' + (j.title || '') + ' · ' + shortId(id) + ' · last ' + msgs.length + ' ──' + C.reset)
    for (const m of msgs) {
      if (m.role === 'user') writeLine(C.green + '❯ ' + m.text + C.reset)
      else writeLine(C.reset + m.text + C.reset)
    }
    writeLine(C.dim + '──────────────────────────' + C.reset)
  } catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
}

async function doAttach(id) {
  try {
    const j = await api('/dsh-cli/attach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id }),
    })
    if (j.attached) {
      sessionId = j.attached
      reconnectStream()
      writeLine(C.green + '⇄ attached session ' + shortId(sessionId) + C.reset +
        (j.cwd ? C.dim + '  [workspace ' + j.cwd + ']' + C.reset : ''))
    } else writeLine(C.red + '✗ ' + (j.error || 'attach failed') + C.reset)
    await refreshModel()
} catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
}

function fmtWhen(t) {
  if (!t) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

// menu rows: title as label, cwd + time as detail — no meaningless uuid
function sessionItems(rows) {
  return rows.map((r) => {
    const bits = []
    if (r.cwd) bits.push(r.cwd)
    if (r.createdAt) bits.push(fmtWhen(r.createdAt))
    else if (r.status) bits.push(r.status)
    if (r.current) bits.push('*')
    return { id: r.id, label: r.title || 'new session', detail: bits.join(' · ') }
  })
}

// switching stays inside the current workspace
function workspaceOf(sessions) {
  const cur = (sessions || []).find((s) => s.current)
  return cur && cur.cwd ? cur.cwd : undefined
}

function inWorkspace(rows, ws) {
  if (!ws) return rows
  return rows.filter((r) => r.cwd === ws)
}

async function command(line) {
  const parts = line.trim().split(/\s+/)
  const name = parts[0]
  const rest = parts.slice(1)
  switch (name) {
    case '/help':
      writeLine('commands: ' + COMMANDS.join('  '))
      writeLine('default launch opens a new session with the current pwd as workspace (codex-like)')
      writeLine('/resume and /switch without an id open an interactive menu (↑↓ select)')
      writeLine('reasoning is folded by default — /think shows the latest, --show-reasoning streams it live')
      writeLine('multi-line: end a line with \\ to continue; plain text is sent to the agent')
      break
    case '/sessions':
      try {
        const j = await api('/dsh-cli/sessions')
        const live = j.sessions || []
        const hist = j.history || []
        const ws = workspaceOf(live)
        const liveWs = inWorkspace(live, ws)
        const histWs = inWorkspace(hist, ws)
        const otherLive = live.length - liveWs.length
        const otherHist = hist.length - histWs.length
        writeLine(C.bold + 'workspace: ' + C.green + (ws || '(unknown)') + C.reset +
          (ws ? C.dim + '  (' + (liveWs.length + histWs.length) + ' sessions)' + C.reset : ''))
        writeLine(C.bold + 'live:' + C.reset)
        if (liveWs.length === 0) writeLine('  (none)')
        for (const s of liveWs) {
          writeLine('  ' + (s.current ? C.green + '*' + C.reset + ' ' : '  ') + C.cyan + (s.title || 'new session') + C.reset +
            C.dim + '  ' + s.status + C.reset)
        }
        writeLine(C.bold + 'history (resumable):' + C.reset)
        if (histWs.length === 0) writeLine('  (none — sessions persist after they run)')
        for (const h of histWs) {
          writeLine('  ' + C.cyan + (h.title || 'new session') + C.reset +
            (h.cwd ? C.dim + '  ' + h.cwd + C.reset : '') +
            (h.createdAt ? C.dim + '  ' + fmtWhen(h.createdAt) + C.reset : ''))
        }
        if (otherLive + otherHist > 0) {
          writeLine(C.dim + '(other workspaces: ' + otherLive + ' live, ' + otherHist + ' historical — /switch and /resume only show the current workspace)' + C.reset)
        }
      } catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
      break
    case '/switch':
    case '/attach':
      if (rest[0]) await doAttach(rest[0])
      else {
        const j = await api('/dsh-cli/sessions')
        const ws = workspaceOf(j.sessions || [])
        const items = sessionItems(inWorkspace(j.sessions || [], ws))
        const row = await showMenu({ title: 'live in this workspace (↑↓ select)', items })
        if (row) await doAttach(row)
      }
      break
    case '/open':
      await doOpen(rest[0])
      break
    case '/resume':
      if (rest[0]) await doResume(rest[0])
      else {
        const j = await api('/dsh-cli/sessions')
        const ws = workspaceOf(j.sessions || [])
        const items = sessionItems(inWorkspace(j.history || [], ws))
        const row = await showMenu({ title: 'history in this workspace (↑↓ select, resume)', items })
        if (row) await doResume(row)
      }
      break
    case '/close':
      if (!rest[0]) return writeLine(C.yellow + 'usage: /close <sessionId>' + C.reset)
      try {
        const j = await api('/dsh-cli/close', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: rest[0] }),
        })
        if (j.closed) { writeLine(C.green + '✓ closed ' + shortId(j.closed) + C.reset + C.dim + ' (still resumable from history)' + C.reset) }
        else writeLine(C.red + '✗ ' + (j.error || 'close failed') + C.reset)
      } catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
      break
    case '/mode':
    case '/preset':
      try {
        const list = await rpc('agentPreset.list', {})
        const items = (list.presets || []).map((p) => ({
          id: p.id,
          label: p.name || p.id,
          detail: (p.isDefault ? 'default · ' : '') + (p.trust || '') + (p.description ? ' · ' + p.description : '') + (p.broken ? ' · broken' : ''),
        }))
        if (items.length === 0) { writeLine(C.yellow + '(no presets)' + C.reset); break }
        const pick = await showMenu({ title: 'mode / agent preset (↑↓ select)', items })
        if (pick) {
          const r = await rpc('agentPreset.select', { sessionId: sessionId, agentPreset: pick })
          writeLine(C.green + '✓ mode → ' + (r.agentPreset || pick) + C.reset)
        }
      } catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
      break
    case '/permission':
    case '/perm':
      try {
        const p = await api('/dsh-cli/permission')
        if (p.error) throw new Error(p.error)
        const items = (p.options || []).map((m) => ({ id: m, label: m + (m === p.current ? '  (当前)' : '') }))
        const pick = await showMenu({ title: 'permission mode (↑↓ select)', items })
        if (pick) {
          const r = await api('/dsh-cli/permission', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: pick }),
          })
          if (r.error) throw new Error(r.error)
          writeLine(C.green + '✓ 权限模式 → ' + (r.current || pick) + C.reset)
        }
      } catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
      break
    case '/model':
      try {
        const m = await rpc('session.models', { sessionId: sessionId })
        if (m.current) writeLine(C.dim + 'current: ' + C.reset + C.cyan + m.current.provider + '/' + m.current.model + C.reset)
        const items = []
        for (const g of m.groups || []) {
          for (const mdl of g.models || []) {
            items.push({ id: g.id + '|' + mdl.id, label: mdl.name || mdl.id, detail: g.name })
          }
        }
        if (items.length === 0) { writeLine(C.yellow + '(no models available — check API keys on the web page)' + C.reset); break }
        const pick = await showMenu({ title: 'select model (↑↓ select, type to filter)', items })
        if (pick) {
          const [provider, model] = pick.split('|')
          const r = await rpc('session.selectModel', { sessionId: sessionId, provider: provider, model: model })
          if (r && r.selected) currentModel = r.selected
          writeLine(C.green + '✓ model → ' + provider + '/' + ((r.selected && r.selected.model) || model) + C.reset)
        }
      } catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
      break
    case '/tools':
      if (rest[0] === 'on') toolVerbose = true
      else if (rest[0] === 'off') toolVerbose = false
      else toolVerbose = !toolVerbose
      writeLine(toolVerbose ? C.green + '✓ 工具调用详情: 显示(每步 ⚙ 行)' + C.reset : C.dim + '工具调用详情: 折叠(仅错误与回合汇总),/tools on 打开' + C.reset)
      break
    case '/think':
      if (lastReasoning) {
        finalizeStream()
        process.stdout.write('\x1b[2K\r')
        log(C.gray + C.italic + '── reasoning ──' + C.reset)
        log(C.gray + C.italic + lastReasoning + C.reset)
        log(C.gray + C.italic + '──────────────' + C.reset)
      } else writeLine(C.yellow + '(no reasoning captured)' + C.reset)
      break
    case '/transcript':
    case '/context':
      await printTranscript(sessionId, parseInt(rest[0], 10) || 30)
      break
    case '/cancel':
      try {
        const j = await api('/dsh-cli/cancel', { method: 'POST' })
        if (!j.cancelled) writeLine(C.yellow + 'nothing to cancel' + C.reset)
      } catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
      break
    case '/clear':
      process.stdout.write('\x1b[2J\x1b[H')
      break
    case '/url':
      writeLine(BASE)
      break
    case '/exit':
      process.exit(0)
    default:
      writeLine(C.yellow + 'unknown command: ' + name + ' (try /help)' + C.reset)
  }
}

// ---- serialized input processing: no line is lost while a command awaits ----
async function handleLine(raw) {
  if (raw.endsWith('\\')) { pending += raw.slice(0, -1) + '\n'; return }
  const text = pending + raw
  pending = ''
  if (!text.trim()) return
  if (pendingApproval !== null) {
    const ans = text.trim().toLowerCase()
    if (ans === 'y' || ans === 'yes' || ans === '允许' || ans === '是' || ans === '1') await answerApproval(true)
    else if (ans === 'n' || ans === 'no' || ans === '拒绝' || ans === '否' || ans === '0') await answerApproval(false)
    else writeLine(C.yellow + '(请输入 y 允许或 n 拒绝)' + C.reset)
    return
  }
  const first = text.trim().split(/\s+/)[0]
  if (first.startsWith('/')) { await command(text.trim()); return }
  writeLine(C.green + '❯ ' + text + C.reset)
  try {
    const j = await api('/dsh-cli/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sessionId: sessionId || undefined }),
    })
    if (j && j.accepted) justSent = true // 交给回合结束再画 prompt
    else writeLine(C.red + '✗ ' + (j && (j.error || j.message)) || 'send failed' + C.reset)
  } catch (e) { writeLine(C.red + '✗ ' + e.message + C.reset) }
}

function pump() {
  if (!ready || busy || holdQueue.length === 0) return
  busy = true
  const raw = holdQueue.shift()
  handleLine(raw)
    .catch((e) => writeLine(C.red + '✗ ' + ((e && e.message) || String(e)) + C.reset))
    .finally(() => {
      busy = false
      if (justSent) justSent = false
      else prompt()
      pump()
    })
}

async function main() {
  try {
    // first use: ask for the web address and remember it in ~/.dsh/cli.config
    if (!cfg.url && !urlFromArg) {
      let ans
      for (;;) {
        ans = await ask('首次使用:请输入 DSH Web 地址(默认 http://127.0.0.1:3080): ', 'http://127.0.0.1:3080')
        if (!/^https?:\/\//.test(ans)) ans = 'http://' + ans
        const m = /^https?:\/\/([^/:]+)(?::\d{1,5})?\/?$/.exec(ans)
        const host = m ? m[1] : ''
        const looksLikeHost = host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(host)
        if (m && looksLikeHost) break
        err(C.red + '✗ 地址格式不对(应形如 http://127.0.0.1:3080),请重新输入。' + C.reset)
      }
      BASE = ans.replace(/\/+$/, '')
      cfg.url = BASE
      saveConfig(cfg)
      log(C.dim + '已记录到 ' + CONFIG_FILE + C.reset)
    }
    initUI() // readline owns stdin only after the config prompt
    if (!(await ensurePlugin())) process.exit(1)
    const health = await api('/dsh-cli/health')
    if (resumePicker) {
      const j = await api('/dsh-cli/sessions')
      const ws = workspaceOf(j.sessions || [])
      const items = sessionItems(inWorkspace(j.history || [], ws))
      const row = await showMenu({ title: 'history in this workspace (↑↓ select, resume)', items })
      if (row) await doResume(row)
    } else if (resumeId) {
      await doResume(resumeId)
    } else if (attachId) {
      await doAttach(attachId)
    } else {
      // codex-like default: open a fresh session in the current pwd
      await doOpen(openCwd)
    }
  } catch (e) {
    err(C.red + '✗ cannot reach DSH CLI bridge at ' + BASE + ': ' + e.message + C.reset)
    err('  make sure the harness is running and the cli-mode plugin is active.')
    process.exit(1)
  }
  startStream()
  startMux() // approval requests arrive over the harness mux stream
  ready = true
  pump() // drain anything typed during bootstrap
  // first prompt lands after the hello banner (fallback if the stream never opens)
  setTimeout(() => { if (!promptShown) { promptShown = true; prompt() } }, 4000)
}

main()
