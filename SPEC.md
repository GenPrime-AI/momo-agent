# momo — multi-vendor / multi-client delegation plugin for Claude Code

> 本文件是唯一事实来源(single source of truth)。所有实现必须严格遵循本规格。
> 实现语言:脚本用 Node.js (`.mjs`, ESM)。命令用 Markdown。不引入第三方依赖,只用 Node 内置模块。

## 0. 一句话定位

momo 是一个 Claude Code 插件:让当前主对话(主 agent)把"一段活"**委派**给任意厂商、任意 CLI 客户端的大模型去后台跑,跑完取回结果。本质是复刻 OpenAI 的 codex 插件模式(command 薄路由 → subagent 薄转发 → companion 厚运行时),但抽象成"多 provider × 多 client"。

参考实现就在本机:`~/.claude/plugins/marketplaces/openai-codex/plugins/codex/`(可读其 `scripts/lib/state.mjs`、`tracked-jobs.mjs`、`process.mjs`、`job-control.mjs`、`commands/*.md`、`agents/codex-rescue.md`、`hooks/`)。借鉴其分层与 job 持久化/杀进程树,**不要**照搬其 app-server/broker(momo 不需要)。

## 1. 核心抽象(两层)

### 1.1 三个实体

- **Provider(厂商)**:提供 endpoint + api key。例:`zhipu`(智谱)、`openai`、`anthropic`、`minimax`。一个 provider 可暴露一/多种**协议**。
- **Model(模型)**:属于某 provider,有一个传给 client 的 `model_id`,可被一/多个 client 驱动,有一份 effort 候选清单。例:`glm-5.2`、`gpt-5-codex`。
- **Client(客户端 CLI)**:真正跑 agent loop 的二进制。**只会说某种协议**,有自己的配置注入方式与 effort 词表。v1 支持两个:`claude`(说 anthropic)、`codex`(说 openai)。

### 1.2 协议层(protocol layer)

回答"某 model 能被哪些 client 驱动":`client 会说的协议 ∈ model 所属 provider 暴露的协议集`。
- GLM 暴露 anthropic 协议 → 可被 `claude` CLI 驱动(纯 env 注入)。
- 只支持自家工具的 model(如 gpt-5-codex)→ 只要该 client 暴露 base_url/key/model/effort 参数,照样驱动。
- 协议层还负责**参数注入映射**(见 §5 client 适配器)。

### 1.3 应用层(application layer)

`/momo:work` 等命令:解析参数 → 调协议层解析出 `(provider, protocol, client, 注入配置)` → 起 client 子进程把活干完 → 结果回主对话。

## 2. 全局约束(不可违背)

1. **委派永远后台、非阻塞**:`/momo:work` 立刻返回 job-id,绝不阻塞主 agent。主 agent 可同时并行派发多个 work。
2. **主 session 关闭即全杀**:Claude 主 session 结束时,杀掉本 session 派生的所有 momo job(SessionEnd hook)。不留孤儿。
3. **委派子进程看不到主对话**:子进程只看到任务正文 + 它自己 resume 的线程历史。任务正文必须自带上下文。
4. **不做跨 job 文件协调**:多个 work 改乱同一批文件是调用方(调度者)的责任,**不在 momo scope**。momo 只保证每个 job 自身独立(独立 pid/log/state)。
5. **api key 明文存** `~/.momo/config.json`(用户已接受)。
6. **参数形态:全 flag(form C)**。任务正文放在 `--` 之后。
7. **不指定就吃默认**:`--client` 不给 = 该 model 的 clients 列表第一个;`--effort` 不给 = 该 model 的 effort 清单里、对所选 client 合法的第一个。`--model` 必填。
8. **零第三方依赖**,只用 Node 内置。

## 3. 配置文件 `~/.momo/config.json`

```jsonc
{
  "version": 1,
  "providers": {
    "zhipu": {
      "protocols": ["anthropic", "openai"],
      "base_url": {
        "anthropic": "https://open.bigmodel.cn/api/anthropic",
        "openai": "https://open.bigmodel.cn/api/paas/v4"
      },
      "api_key": "<plaintext>"
    },
    "openai": {
      "protocols": ["openai"],
      "base_url": { "openai": "https://api.openai.com/v1" },
      "api_key": "<plaintext>"
    }
  },
  "models": {
    "glm-5.2": {
      "provider": "zhipu",
      "model_id": "GLM-5.2",          // 实际传给 client 的模型名
      "clients": ["claude", "codex"], // 有序,第一个=默认 client
      "effort":  ["high", "medium", "low"] // 有序,第一个合法项=默认 effort
    },
    "gpt-5-codex": {
      "provider": "openai",
      "model_id": "gpt-5-codex",
      "clients": ["codex"],
      "effort":  ["high", "medium", "low"]
    }
  }
}
```

- 写盘必须**原子**(临时文件 + rename)且并发安全(写锁)。
- 解析失败(被手改坏)时**禁止覆盖**,报错并保留原文件。
- `effort` 列表是用户偏好顺序;某项是否对所选 client 合法由 client 适配器的 `allowedEffort` 决定(见 §5)。默认 effort = 列表中第一个对该 client 合法的值。

## 4. Job 状态(每个 job 一条)

存于 `~/.momo/jobs/<job-id>.json` + 同名 `.log`。

```jsonc
{
  "id": "glm-5.2-a1b2",          // 全局唯一,人可读前缀 + 短哈希
  "status": "running",           // queued|running|done|failed|timeout|killed|crashed
                                 // queued=已派发等 thread 锁;running=真正在跑 client
  "pid": 8123,
  "model": "glm-5.2",
  "client": "claude",
  "effort": "high",
  "thread_key": "<sha1(cwd|model|client)>", // resume 用
  "session_id": "<client 侧会话 id>",        // resume 用
  "claude_session": "<主 session id>",       // SessionEnd 清理用
  "cwd": "/abs/path",
  "started_at": "ISO",
  "last_heartbeat": "ISO",
  "exit_code": null,
  "error": null
}
```

### 4.1 存活判定(status 命令的核心)

`/momo:status` 不能只读 `status` 字段,必须三招叠加:
1. **pid 探活** `process.kill(pid, 0)`:`status==running` 但 pid 已死 → 判定 `crashed`(硬崩没写终态)。
2. **心跳新鲜度**:runner 每 ≤5s 更新 `last_heartbeat`;超阈值(如 30s)没动 → 标"疑似卡死",提示可 cancel。
3. **超时兜底**:runner 自带 wall-clock 上限(默认 600s,可配),超时 → 杀进程树 → `status=timeout`。

### 4.2 杀进程树

cancel / 超时 / session 关闭都要杀**整棵进程树**(client 会派生自己的子进程)。参考 codex `lib/process.mjs` 的 `terminateProcessTree`。

### 4.3 同线程串行

同一 `thread_key` 被并发 continue/resume → 加文件锁串行(避免线程历史写坏)。不同 thread_key 照常并行。

## 5. Client 适配器(协议层关键)

每个 client 适配器(`scripts/lib/clients/<name>.mjs`)导出统一接口:

```js
export default {
  name: "claude",
  protocol: "anthropic",                  // 该 client 会说的协议
  allowedEffort: new Set(["low","medium","high","xhigh","max"]),
  // 构造 spawn 参数(纯函数)
  buildInvocation({ taskPrompt, modelId, baseUrl, apiKey, effort, sessionId, resume }) {
    // 返回 { command, argv, env, files }  files=需先落盘的临时配置文件[]
  },
  // 从原始 stdout 提取最终文本
  parseResult(rawStdout) { /* -> string */ },
  // 从输出/会话目录解析出可 resume 的 session id
  extractSessionId(rawStdout, ctx) { /* -> string|null */ }
}
```

### 5.1 claude 适配器
- 协议 anthropic。effort 词表:`low, medium, high, xhigh, max`。
- 注入:`env` 设 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL=model_id`;**先 unset** `ANTHROPIC_AUTH_TOKEN`。
- argv:`["-p","--output-format","json","--session-id",sessionId,"--effort",effort, taskPrompt]`;
  resume 时:`["-p","--output-format","json","--resume",sessionId,"--effort",effort, taskPrompt]`。
- `parseResult`:解析 `--output-format json` 的最终 result 文本字段。
- 自检:`claude --help` 可跑即视为可用(claude 一定已装)。

### 5.2 codex 适配器
- 协议 openai。effort 词表:`none, minimal, low, medium, high, xhigh`。
- 指向自定义 OpenAI 兼容 endpoint 需用 codex 的 `-c key=value` 覆盖 `model_providers`:
  argv 形如:`["exec","-m",model_id,
    "-c","model_provider=\"momo\"",
    "-c","model_providers.momo.name=\"momo\"",
    "-c","model_providers.momo.base_url=\"<baseUrl>\"",
    "-c","model_providers.momo.env_key=\"MOMO_API_KEY\"",
    "-c","model_reasoning_effort=\"<effort>\"",
    "--skip-git-repo-check", taskPrompt]`;
  env 设 `MOMO_API_KEY=apiKey`。**精确 flag 以本机 `codex exec --help` 为准**,实现时务必先跑 help 校正。
- resume:codex 的 session 续接以 `codex exec --help` 输出为准(可能是 `resume`/`--last`);拿不准则本次先不支持 codex 的 resume,`continue` 对 codex client 报"暂不支持",但 claude client 必须支持 resume。
- `parseResult`:codex exec 的最终输出解析。
- 自检:`which codex` 存在即可用;不存在 → 友好报错。

> 适配器是唯一知道"各 client 怎么配"的地方。新增 client = 加一个适配器文件,registry/runtime 不改。

## 6. 命令面(全部在 `commands/` 下,plugin 名 momo)

### 6.1 `/momo:config` —— 裸命令 + 反问(NL 配置)
- **命令后不跟参数**。命令 .md 指示主 agent:回车后**反问**用户要配置什么(provider / model / api-key / base-url / effort 清单 / 默认 client),用户用自然语言回复,主 agent(LLM)把它解析成结构化,回显确认,然后调
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs config-set --json '<结构化JSON>'` 持久化。
- runtime 的 `config-set` 只负责**校验 + 原子写盘**,不做 NL 解析(NL 解析是 LLM 的事)。
- 校验:provider 协议合法、base_url 与协议对应、model.provider 存在、model.clients ⊆ 已知 client 且协议兼容、effort 项对至少一个 client 合法。冲突(覆盖已有 key)在 .md 里要求 agent 先确认。

### 6.2 `/momo:list` —— 裸命令
- `node momo.mjs list` 打印表格:model / provider / 协议 / clients(默认*) / effort(默认*)。

### 6.3 `/momo:work` —— flag 形态,永远后台
- 形态:`/momo:work --model <m> [--client <c>] [--effort <e>] -- <任务正文>`
- 裸 `/momo:work` (无参) → 命令 .md 指示 agent 反问("派给哪个 model?干什么?")。
- 命令 .md 把请求转发给薄 subagent `momo-runner`(见 §7),由其**一次 Bash** 调
  `node momo.mjs work --model .. --client .. --effort .. -- <task>`。
- runtime `work`:校验(§8)→ 派生后台进程 → 立刻打印 `job-id` 与提示,**不等结果**。
- `--` 之后全是任务正文(含 `--xxx` 也安全)。

### 6.4 `/momo:status [job-id]` —— 看状态(可裸,看全部)
- `node momo.mjs status [job-id]`,按 §4.1 做存活判定后输出。

### 6.5 `/momo:result <job-id>` —— 取最终输出
- `node momo.mjs result <job-id>`,done 则打印完整结果,未完成则提示当前 status。

### 6.6 `/momo:cancel <job-id>` —— 杀 job
- `node momo.mjs cancel <job-id>`,杀进程树,status=killed。

### 6.7 `/momo:continue <job-id> -- <追加指令>` —— 续线程
- 复用该 job 的 `(thread_key, session_id)` 起一个**新后台 job**(同线程串行锁),返回新 job-id。claude client 必须支持;codex 视 §5.2 而定。

## 7. Subagent + Hook

- `agents/momo-runner.md`:薄转发器,`tools: Bash`,系统提示强调"只转发,不自己读文件/思考/总结",一次 Bash 调 `momo.mjs work/continue`,stdout 原样返回。用于 work/continue(隔离 + 后台)。status/result/list/cancel 可由命令 .md 直接 Bash,不必经 subagent。
- `hooks/hooks.json`:注册 **SessionEnd** hook → `node scripts/cleanup-session.mjs`(或 momo.mjs 子命令)杀掉 `claude_session == 当前` 的所有 running job 进程树。主 session id 从 hook 输入/环境取(参考 codex `scripts/session-lifecycle-hook.mjs` 与 `SESSION_ID_ENV`)。

## 8. 运行时校验(work/continue 起进程前)

按顺序 fail-fast,报错要给可用项:
1. `--model` 缺失 → 报错。
2. model 不在 config → 报错 + 列已知 model。
3. 解析 client:给了 `--client` 则必须 ∈ model.clients 且协议兼容,否则报错 + 列可用 client;没给则取 model.clients[0]。
4. client 二进制未安装 → 报错(提示装/换 client)。
5. 解析 effort:给了 `--effort` 则必须 ∈ model.effort 且 ∈ client.allowedEffort,否则报错 + 列该 client 合法值;没给则取 model.effort 中第一个 ∈ client.allowedEffort 的值。
6. provider 的 api_key/base_url 缺失 → 报错,提示 `/momo:config`。
7. 任务正文为空 → 报错。
- 运行后才暴露的错(401/网络)→ 子进程 stderr 映射成友好提示写进 job.error。

## 9. 目录结构(产出)

```
momo-work/
├── SPEC.md                       # 本文件
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── commands/
│   ├── config.md  list.md  work.md  status.md  result.md  cancel.md  continue.md
├── agents/momo-runner.md
├── scripts/
│   ├── momo.mjs                  # 入口:子命令分发 work/continue/status/result/cancel/list/config-set/cleanup
│   ├── cleanup-session.mjs       # SessionEnd 清理(或并入 momo.mjs)
│   └── lib/
│       ├── config.mjs            # 读写 ~/.momo/config.json(原子+锁+校验)
│       ├── registry.mjs          # 从 config 解析 model→provider→protocol;default 解析
│       ├── resolve.mjs           # (model,client?,effort?) → 完整执行上下文 + 全部校验(§8)
│       ├── jobs.mjs              # job 状态 CRUD、存活判定(§4.1)、心跳
│       ├── process.mjs           # spawn 后台、terminateProcessTree、kill -0
│       ├── lock.mjs              # 文件锁(config 写锁、同 thread_key 串行)
│       ├── render.mjs            # list/status/result 文本渲染
│       └── clients/
│           ├── index.mjs         # 适配器注册表
│           ├── claude.mjs
│           └── codex.mjs
└── test/
    ├── mock-bin/claude           # 假 claude(可执行),模拟 -p/--output-format json/--session-id/--resume,可注入 sleep/crash/hang
    ├── mock-bin/codex            # 假 codex
    └── *.test.mjs                # node --test 跑
```

## 10. 测试要求(完整测试,用 mock,不花真钱)

用 `node --test`(Node 内置),mock client 二进制放 `test/mock-bin/`,通过把 `test/mock-bin` 前置到 `PATH` 或适配器可注入 binary 路径来替换真 client。必须覆盖:

- **registry/resolve**:default client/effort 解析;`--client` 协议不兼容报错;`--effort` 对 client 非法报错(claude=max 合法/codex=max 非法;codex=none 合法/claude=none 非法);model 不存在;key 缺失。
- **config**:NL 已解析后的结构化 `config-set` 校验通过/失败;原子写;坏 JSON 不被覆盖。
- **work 生命周期(mock client)**:
  - 正常:work 返回 job-id 且不阻塞;mock 跑完 → status=done → result 拿到输出。
  - 崩溃:mock 立即非零退出 → status=failed,error 有内容。
  - 硬崩:mock 被 kill -9 → pid 死但没写终态 → status 探活判定为 crashed。
  - 卡死:mock 永久 sleep → 超时兜底杀掉 → status=timeout。
  - cancel:running 中 cancel → 进程树被杀 → status=killed。
- **并行**:连发 3 个 work → 3 个独立 job-id、独立 log/state、互不串扰、`/momo:status` 全列出。
- **同线程串行**:同 thread_key 两个 continue 不会写坏线程状态(锁生效)。
- **session 清理**:模拟 SessionEnd → 该 claude_session 的 running job 被杀。
- **arg 解析(form C)**:`--` 后含 `--verbose` 的任务正文不被当 flag;未知 flag 报错;空任务报错。

所有 mock 测试必须全绿,才进入真实 key 端到端测试(由主流程在 workflow 之外用真实 GLM key 跑一条 `/momo:work`)。

## 11. 不做(明确 out of scope)

- 跨 job 的文件冲突协调 / 合并(调度者负责)。
- codex 的 app-server/broker 常驻。
- 数字 thinking budget(只用 effort 等级)。
- 把主对话历史喂给委派子进程。
- 整 session 换模型(那是 wrapper 启动器的事,momo 只做委派)。
