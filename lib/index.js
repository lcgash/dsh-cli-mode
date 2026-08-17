// dsh-cli-mode — DeepSeek Harness CLI 终端模式插件(Host 半)
// Cordis 插件包入口:composition 以 `- id: cli-mode / name: dsh-cli-mode` 挂载。
// 也可由 dsh-cli 客户端通过 cordis_define 动态自举安装(见 lib/plugin-source.txt)。

const name = 'cli-mode'
const inject = ['webServer']

async function apply(ctx) {

    const webServer = ctx.webServer
    const agents = ctx.get('agents')
    if (agents === undefined) return

    // ---- state ----
    let targetId = null
    const clients = new Set()
    const callNames = new Map()
    const owned = new Map()
    const pendingApprovals = new Map()   // approvalId -> { resolve }

    // ---- helpers ----
    function resolveTarget() {
      try {
        if (targetId) {
          const a = agents.get(targetId)
          if (a !== undefined) return a
          targetId = null
        }
        try {
          const via = ctx.get('agent')
          if (via && via.id && agents.get(via.id) !== undefined) { targetId = via.id; return via }
        } catch (e) { /* ignore */ }
        const initiator = agents.currentInitiator()
        if (initiator) { targetId = initiator.id; return initiator }
        const roots = agents.roots()
        if (roots.length > 0) { targetId = roots[0].id; return roots[0] }
        const all = agents.list()
        if (all.length > 0) { targetId = all[0].id; return all[0] }
      } catch (e) { /* containment */ }
      return undefined
    }

    function uuidv4() {
      let s = ''
      const hex = '0123456789abcdef'
      for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) s += '-'
        else if (i === 14) s += '4'
        else if (i === 19) s += hex[8 + Math.floor(Math.random() * 4)]
        else s += hex[Math.floor(Math.random() * 16)]
      }
      return s
    }

    function seedOptions() {
      try {
        const def = ctx.get('agentDefaultModel')
        if (def === undefined) return undefined
        const sel = def.currentSelection()
        if (!sel || !sel.provider || !sel.model) return undefined
        return { provider: sel.provider, model: sel.model }
      } catch (e) { return undefined }
    }

    function headerOf(agent) {
      try { return agent && agent.session && agent.session.header ? agent.session.header : undefined } catch (e) { return undefined }
    }

    function titleOf(agent) {
      try {
        const svc = ctx.get('sessionTitle')
        if (svc === undefined || agent === undefined || agent.session === undefined) return undefined
        const snap = svc.get(agent.session)
        if (snap && typeof snap.title === 'string' && snap.title !== '') return snap.title
      } catch (e) { /* ignore */ }
      return undefined
    }

    function blocksText(content) {
      if (!Array.isArray(content)) return ''
      let s = ''
      for (const b of content) {
        if (b && b.type === 'text' && typeof b.text === 'string') {
          if (s) s += '\n'
          s += b.text
        }
      }
      return s
    }

    async function composeSetup(presetId) {
      const presets = ctx.get('agentPresets')
      if (presets === undefined) return { id: undefined, setup: undefined }
      const attempt = async (id) => {
        const resolved = await presets.resolve(id)
        const rid = resolved.id
        return { id: rid, setup: async (agentCtx) => { await presets.mount(agentCtx, rid) } }
      }
      try {
        if (presetId !== undefined) return await attempt(presetId)
        return await attempt(undefined)
      } catch (e) {
        try { return await attempt(undefined) } catch (e2) { return { id: undefined, setup: undefined } }
      }
    }

    async function openSession(cwd, presetId) {
      const sessionId = 'session-' + uuidv4()
      const target = resolveTarget()
      const fallbackCwd = (headerOf(target) && headerOf(target).cwd) || '.'
      const givenCwd = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : fallbackCwd
      let sessionCwd = givenCwd
      let workspace
      const wreg = ctx.get('workspaceRegistry')
      if (wreg !== undefined) {
        try {
          workspace = await wreg.resolveByPath(givenCwd)
          if (workspace === undefined) workspace = await wreg.create(givenCwd)
          sessionCwd = workspace.path
        } catch (e) { workspace = undefined }
      }
      const wantPreset = presetId || (headerOf(target) && headerOf(target).agentPreset) || undefined
      const comp = await composeSetup(wantPreset)
      const handle = await agents.create({
        sessionId: sessionId,
        agentOptions: seedOptions(),
        meta: Object.assign({ cwd: sessionCwd }, comp.id ? { agentPreset: comp.id } : {}),
        setup: comp.setup
      })
      if (workspace !== undefined) {
        try { await workspace.attachSession(handle.agent.id) } catch (e) { /* non-fatal */ }
      }
      owned.set(handle.agent.id, handle)
      targetId = handle.agent.id
      return handle.agent
    }

    async function resumeSession(sessionId) {
      const live = agents.get(sessionId)
      if (live !== undefined) { targetId = sessionId; return live }
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) throw new Error('session persistence is not configured')
      const headers = await persistence.list()
      const meta = headers.find((h) => h && h.id === sessionId)
      if (meta === undefined) throw new Error('session not found in history: ' + sessionId)
      const comp = await composeSetup(meta.agentPreset)
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: seedOptions(),
        setup: comp.setup
      })
      owned.set(handle.agent.id, handle)
      targetId = handle.agent.id
      return handle.agent
    }

    async function historyRows() {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return []
      const query = ctx.get('sessionQuery')
      const liveIds = new Set(agents.list().map((a) => { try { return a.id } catch (e) { return null } }))
      let headers = []
      try { headers = await persistence.list() } catch (e) { return [] }
      const sorted = headers
        .filter((h) => h && !liveIds.has(h.id))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 40)
      const rows = []
      for (const h of sorted) {
        let title
        if (query !== undefined) {
          try {
            const snap = await query.readTitle(h.id)
            if (snap && typeof snap.title === 'string' && snap.title !== '') title = snap.title
          } catch (e) { /* ignore */ }
        }
        rows.push({ id: h.id, title: title, cwd: h.cwd, agentPreset: h.agentPreset, createdAt: h.createdAt })
      }
      return rows
    }

    function broadcast(payload, sessionId) {
      let frame
      try { frame = 'data: ' + JSON.stringify(payload) + '\n\n' } catch (e) { return }
      for (const c of clients) {
        if (sessionId && c.sessionId && c.sessionId !== sessionId) continue
        try { c.res.write(frame) } catch (e) { /* drop */ }
      }
    }

    function renderEvent(session, event) {
      try {
        const data = event && event.data
        switch (event.type) {
          case 'assistant/chunk': {
            const chunk = data && data.chunk
            if (!chunk) return
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              broadcast({ type: 'text-delta', text: chunk.text }, session.id)
            } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
              broadcast({ type: 'reasoning-delta', text: chunk.text }, session.id)
            } else if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
              broadcast({ type: 'reasoning-start' }, session.id)
            } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'reasoning') {
              broadcast({ type: 'reasoning-end' }, session.id)
            }
            return
          }
          case 'assistant/message': {
            const blocks = []
            const content = data && data.message && data.message.content
            if (Array.isArray(content)) {
              for (const b of content) {
                if (!b || typeof b !== 'object') continue
                if (b.type === 'text' && typeof b.text === 'string') blocks.push({ kind: 'text', text: b.text })
                else if (b.type === 'reasoning' && typeof b.text === 'string') blocks.push({ kind: 'reasoning', text: b.text })
              }
            }
            if (blocks.length > 0) broadcast({ type: 'assistant', blocks: blocks }, session.id)
            broadcast({ type: 'step-end' }, session.id)
            return
          }
          case 'tool/call': {
            const name = data && data.name
            if (data && data.callId) callNames.set(data.callId, String(name || '?'))
            broadcast({ type: 'tool-start', name: String(name || '?'), args: String((data && data.arguments) || '') }, session.id)
            return
          }
          case 'tool/result': {
            const msg = data && data.message
            const block = msg && msg.content && msg.content[0]
            const callId = block && block.toolCallId
            const name = callId ? (callNames.get(callId) || 'tool') : 'tool'
            const err = data && data.error
            broadcast({ type: 'tool-end', name: name, error: err ? String(err.code || err.name || 'error') : null }, session.id)
            return
          }
          case 'turn/end': {
            const reason = data && data.reason
            broadcast({ type: 'turn-end', reason: (reason && reason.kind) || 'completed' }, session.id)
            return
          }
          default:
            return
        }
      } catch (e) { /* containment */ }
    }

    function renderStatus(payload) {
      try {
        if (!payload || !payload.agent || !payload.agent.id) return
        if (targetId && payload.agent.id !== targetId) return
        broadcast({ type: 'status', status: payload.status }, payload.agent.id)
      } catch (e) { /* ignore */ }
    }

    function readBody(req) {
      return new Promise((resolve) => {
        let s = ''
        req.on('data', (c) => { try { s += c.toString('utf8') } catch (e) { /* ignore */ } })
        req.on('end', () => resolve(s))
        req.on('error', () => resolve(s))
      })
    }

    function queryString(url) {
      const out = {}
      const i = url ? url.indexOf('?') : -1
      if (i >= 0) {
        for (const pair of url.slice(i + 1).split('&')) {
          if (!pair) continue
          const eq = pair.indexOf('=')
          const k = eq >= 0 ? pair.slice(0, eq) : pair
          const v = eq >= 0 ? pair.slice(eq + 1) : ''
          try { out[decodeURIComponent(k)] = decodeURIComponent(v) } catch (e) { out[k] = v }
        }
      }
      return out
    }

    function json(res, code, payload) {
      try {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      } catch (e) { /* client gone */ }
    }

    function requirePost(req, res) {
      if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return false }
      return true
    }

    // ---- lifecycle ----
    ctx.effect(() => {
      const offSession = ctx.on('session/event', (session, event) => {
        try {
          if (session && session.id && targetId && session.id !== targetId) return
          renderEvent(session, event)
        } catch (e) { /* containment */ }
      })
      const offStatus = ctx.on('agent/status', (payload) => renderStatus(payload))
      const disposers = []

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/health', handler: (req, res) => {
        const t = resolveTarget()
        const h = headerOf(t)
        json(res, 200, { ok: true, session: t ? t.id : null, title: titleOf(t), agentPreset: h ? h.agentPreset : undefined, cwd: h ? h.cwd : undefined, endpoint: '/dsh-cli' })
      } }))

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/sessions', handler: async (req, res) => {
        try {
          const live = agents.list().map((a) => {
            const h = headerOf(a)
            return { id: a.id, title: titleOf(a), status: a.status, current: a.id === targetId, agentPreset: h ? h.agentPreset : undefined, cwd: h ? h.cwd : undefined }
          })
          const history = await historyRows()
          json(res, 200, { sessions: live, history: history })
        } catch (e) { json(res, 500, { error: String(e) }) }
      } }))

      // permission: GET = 当前模式 + 可选模式;POST = 切换
      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/permission', handler: async (req, res) => {
        const presets = ctx.get('permissionPresets')
        if (!presets) return json(res, 404, { error: 'permission service unavailable' })
        try {
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}')
            const target = body.sessionId ? agents.get(body.sessionId) : resolveTarget()
            if (!target) return json(res, 404, { error: 'no live agent' })
            if (typeof body.mode !== 'string' || !presets.names.includes(body.mode)) return json(res, 400, { error: 'unknown mode: ' + String(body.mode), options: presets.names })
            targetId = target.id
            presets.set(target.session, body.mode)
            json(res, 200, { current: body.mode, session: target.id })
          } else {
            const t = resolveTarget()
            if (!t) return json(res, 404, { error: 'no live agent' })
            json(res, 200, { session: t.id, current: presets.current(t.session.events), options: presets.names })
          }
        } catch (e) { json(res, 500, { error: String(e) }) }
      } }))

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/attach', handler: async (req, res) => {
        if (!requirePost(req, res)) return
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const id = body.sessionId
          const a = id && agents.get(id)
          if (!a) return json(res, 404, { error: 'unknown live session', sessionId: id })
          targetId = id
          json(res, 200, { attached: id, title: titleOf(a), cwd: headerOf(a) ? headerOf(a).cwd : undefined })
        } catch (e) { json(res, 400, { error: String(e) }) }
      } }))

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/open', handler: async (req, res) => {
        if (!requirePost(req, res)) return
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const agent = await openSession(body.cwd, body.agentPreset)
          json(res, 200, { sessionId: agent.id, title: titleOf(agent), cwd: headerOf(agent) ? headerOf(agent).cwd : undefined })
        } catch (e) { json(res, 500, { error: String(e) }) }
      } }))

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/resume', handler: async (req, res) => {
        if (!requirePost(req, res)) return
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          if (!body.sessionId) return json(res, 400, { error: 'sessionId required' })
          const agent = await resumeSession(body.sessionId)
          json(res, 200, { sessionId: agent.id, title: titleOf(agent), cwd: headerOf(agent) ? headerOf(agent).cwd : undefined })
        } catch (e) { json(res, 500, { error: String(e) }) }
      } }))

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/close', handler: async (req, res) => {
        if (!requirePost(req, res)) return
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const id = body.sessionId
          const handle = id && owned.get(id)
          if (handle === undefined) return json(res, 404, { error: 'not a CLI-created session', sessionId: id })
          await handle.dispose()
          owned.delete(id)
          if (targetId === id) targetId = null
          json(res, 200, { closed: id })
        } catch (e) { json(res, 500, { error: String(e) }) }
      } }))

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/send', handler: async (req, res) => {
        if (!requirePost(req, res)) return
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const text = typeof body.text === 'string' ? body.text : ''
          if (!text.trim()) return json(res, 400, { error: 'empty text' })
          if (body.sessionId) {
            let a = agents.get(body.sessionId)
            if (a === undefined) {
              try { a = await resumeSession(body.sessionId) } catch (e) { return json(res, 404, { error: 'session not found', sessionId: body.sessionId }) }
            }
            targetId = body.sessionId
          }
          const agent = resolveTarget()
          if (!agent) return json(res, 404, { error: 'no live agent; open or resume a session first' })
          const message = {
            id: 'cli-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
            role: 'user',
            content: [{ type: 'text', text: text }],
            source: { kind: 'user' }
          }
          agent.followup(message)
          json(res, 200, { accepted: true, sessionId: agent.id })
        } catch (e) { json(res, 500, { error: String(e) }) }
      } }))

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/transcript', handler: (req, res) => {
        const qs = queryString(req.url)
        const id = qs.sessionId
        const limit = Math.min(100, Math.max(1, parseInt(qs.limit || '30', 10) || 30))
        const a = id && agents.get(id)
        if (!a) return json(res, 404, { error: 'session not live', sessionId: id })
        const messages = []
        try {
          for (const ev of a.session.events) {
            if (!ev || !ev.type) continue
            if (ev.type === 'user/message') {
              const text = blocksText(ev.data && ev.data.content)
              if (text) messages.push({ role: 'user', text: text })
            } else if (ev.type === 'assistant/message') {
              const text = blocksText(ev.data && ev.data.message && ev.data.message.content)
              if (text) messages.push({ role: 'assistant', text: text })
            }
          }
        } catch (e) { /* ignore */ }
        json(res, 200, { sessionId: id, title: titleOf(a), messages: messages.slice(-limit) })
      } }))

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/cancel', handler: async (req, res) => {
        if (!requirePost(req, res)) return
        const agent = resolveTarget()
        if (!agent) return json(res, 404, { error: 'no live agent' })
        try {
          agent.cancel({ kind: 'user' })
          json(res, 200, { cancelled: true })
        } catch (e) { json(res, 500, { error: String(e) }) }
      } }))

      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-cli/stream', handler: (req, res) => {
        const qs = queryString(req.url)
        const t = resolveTarget()
        const wanted = qs.sessionId || (t ? t.id : null)
        try {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          })
        } catch (e) { return }
        const client = { res: res, sessionId: wanted }
        clients.add(client)
        try {
          const h = wanted ? headerOf(agents.get(wanted)) : headerOf(t)
          res.write('data: ' + JSON.stringify({ type: 'hello', sessionId: wanted, title: wanted ? titleOf(agents.get(wanted)) : titleOf(t), cwd: h ? h.cwd : undefined }) + '\n\n')
        } catch (e) { /* ignore */ }
        req.on('close', () => clients.delete(client))
        req.on('error', () => clients.delete(client))
        res.on('error', () => clients.delete(client))
      } }))

      console.log('dsh-cli: CLI bridge active — send/open/resume/close/transcript/permission + SSE; target=' + (resolveTarget() ? targetId : 'none'))

      return () => {
        offSession()
        offStatus()
        for (const d of disposers) { try { d() } catch (e) { /* ignore */ } }
        for (const c of clients) { try { c.res.end() } catch (e) { /* ignore */ } }
        clients.clear()
        callNames.clear()
        for (const handle of owned.values()) { try { handle.dispose() } catch (e) { /* ignore */ } }
        owned.clear()
      }
    })
  
}

export { name, inject, apply }
