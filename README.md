# dsh-cli-mode

[English](README.en.md) | 中文

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话变成**终端可交互的 CLI**——在 terminal 里直接和 agent 对话、开发代码,不用一直盯着网页。逻辑类似 codex:**在哪个目录启动 CLI,哪个目录就是工作区**。

- **插件**(Cordis,Host-only):在 harness 的 web 端口上注册 `/dsh-cli/*` 路由,桥接会话、事件流、权限与审批。
- **客户端**(`dsh-cli`,纯 Node 零依赖):逐 token 流式输出、markdown 渲染、竖排菜单、会话切换、模式/模型/权限切换、审批 y/n。

## 特性

| 能力 | 说明 |
| --- | --- |
| 流式输出 + markdown 渲染 | 回答逐 token 流式显示,标题/加粗/代码块/表格实时渲染;思考内容默认折叠(`/think` 查看) |
| codex 式工作区 | 启动目录即会话工作区,`workspaceRegistry` 绑定 |
| 会话管理 | `/open` `/resume` `/switch` `/attach` `/close`,`/sessions` 按工作区过滤 |
| 竖排菜单 | 输入 `/` 弹出(claude 式:↑↓ 选择、打字过滤、备用屏幕渲染、主屏零滚动) |
| 模式/模型/权限 | `/mode`(agent preset)、`/model`、`/permission`(read-only / workspace-write / danger-full-access) |
| 授权桥接 | agent 需要审批时终端弹出 `🔐`,`y`/`n` 答复(走 harness mux 通道,与网页同源) |
| 工具折叠 | 工具调用默认折叠为一行汇总(`/tools on` 看详情),任务完成显示 `✓ 完成` 标记 |
| 自举安装 | 首次运行自动把插件装进 harness(经 `session.prompt` + `cordis_define`/`cordis_run`) |
| 底部状态行 | 提示符上方常驻显示当前模型与 reasoning 级别(灰色小字) |

## 安装

### 方式 A:作为 composition 插件挂载(推荐,重启自动加载)

在 harness 的 `cordis.yml`(或 agent preset)里加一行:

```yaml
- id: cli-mode
  name: 'dsh-cli-mode'
```

或通过 `dsh` CLI 安装依赖:

```bash
dsh plugin --profile web add dsh-cli-mode
```

### 方式 B:客户端自举(无需改配置)

`dsh-cli` 首次连接时若发现插件未激活,会**自动安装并启用**(需要一个 `cordis` preset 会话,没有则自动创建一个)。

## 使用

```bash
npm install -g dsh-cli-mode   # 安装客户端(或 npx / 本地运行 bin/dsh-cli.mjs)
dsh-cli                        # 首次会询问 web 地址,记录到 ~/.dsh/cli.config
dsh-cli --resume [id]          # 恢复历史会话
dsh-cli --attach <id>          # 接到某个 live 会话
```

### 内置命令

```
/help  /sessions  /switch  /attach  /open  /resume  /close
/mode  /model  /permission  /tools  /think  /transcript  /cancel  /clear  /exit
```

输入 `/` 弹出命令菜单;行尾 `\` 续行多行输入。

### 授权交互

```
🔐 授权请求 (bash)
  escalate sandbox to danger-full-access: 目标文件 ... 位于会话工作区之外...
  y = 允许一次 | n = 拒绝
```

## 配置

- `~/.dsh/cli.config`:`{ "url": "http://127.0.0.1:3080" }`(web 地址,`--url` 覆盖并写入)
- **API key 等基础配置在网页页面完成**,CLI 不做密钥管理。

## 架构

```
┌─ dsh-cli(终端)──────────────────────────────┐
│  bin/dsh-cli.mjs                             │
│   · /dsh-cli/* HTTP 路由调用(会话/权限)       │
│   · /dsh-cli/stream SSE(对话流式输出)         │
│   · /api/events.mux WebSocket(审批请求)       │
│   · /api/respond(审批答复)                    │
└──────────────┬───────────────────────────────┘
               │ http://127.0.0.1:3080
┌──────────────▼───────────────────────────────┐
│  harness(web 进程)                           │
│  lib/index.js —— cli-mode 插件(Host)          │
│   · /dsh-cli/* 路由(webServer)                │
│   · session/event → SSE 流(assistant/chunk 等)│
│   · permissionPresets 切换权限                │
│  apiProxy —— 会话/模型/预设 RPC、审批 pending  │
└──────────────────────────────────────────────┘
```

- **会话流**:输入经 `agent.followup()` 注入(与网页同通道),输出由 `session/event` 渲染为 SSE。
- **审批**:网页 answerer 拥有 `approval/request` 瀑布;客户端订阅 mux 流拿到 `approval/requested`(含 rpcId),经 `/api/respond` 答复。
- **自举**:客户端把 `lib/plugin-source.txt`(插件原始体)内嵌进安装消息,让 cordis preset 会话的 agent 执行 `cordis_define` + `cordis_run`。

## 开发

```bash
git clone <gitee 仓库地址>
cd dsh-cli-mode
npm run check         # 语法检查
npm test              # 冒烟测试
```

**保持 `lib/index.js` 与 `lib/plugin-source.txt` 同步**:自举安装用的是 `plugin-source.txt`(原始函数体文本),挂载安装用的是 `lib/index.js`。修改插件逻辑后执行:

```bash
npm run sync-source   # 从 lib/index.js 重新生成 plugin-source.txt
```

## 发布

项目托管于 Gitee。发布到 npm(发布包内容由 `package.json` 的 `files` 决定):

```bash
npm version patch     # 或 minor / major
npm publish           # 需 npm 账号与包名
```

CI/自动发布可在 Gitee 上自行配置(如 Gitee Go),本仓库不携带平台特定的工作流配置。

## License

MIT
