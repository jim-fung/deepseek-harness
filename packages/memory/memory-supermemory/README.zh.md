# @deepseek-ai/dsh-memory-supermemory

[English](README.md) | 中文

由 [supermemory.ai](https://supermemory.ai) 支持的 `MemoryProvider`，用于 harness [记忆能力 seam](../memory/README.zh.md)（`ctx.memory`）。这是一个实现包：函数插件（`inject: ['memory']`），向 [`@deepseek-ai/dsh-memory`](../memory/README.zh.md) 持有的 seam 注册提供方 `memory-provider:supermemory`；它不注册面向模型的工具（后者属于 [`@deepseek-ai/dsh-tool-memory`](../tool-memory/README.zh.md)）。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `SUPERMEMORY_API_KEY` | 凭据引用，命名携带 API 密钥的环境变量。 |
| `baseURL` | `https://api.supermemory.ai` | 端点基址；追加 `/v3/documents`、`/v4/search` 与 `/v4/profile` 路径。 |
| `containerTagPrefix` | `dsh` | 远端划分 scope 的容器标签前缀。 |

API 密钥在每次操作时解析，从不缓存：挂载了 credentials 服务时由该服务解析引用，否则由启动环境变量提供，最后回退到只读的 `~/.codex/supermemory/credentials.json`（Codex 插件的登录文件，dsh 从不写入）。当没有任何来源给出可用密钥时，操作抛出 `MemoryError`，code 为 `MEMORY_PROVIDER_UNAVAILABLE`，消息列出全部查询过的来源；会话启动不触网络，也不访问密钥存储。

## 远端映射

scope 身份完全由容器标签承载，这是远端 API 提供的唯一分区机制：`global` 映射为 `<prefix>-global`，`project` 映射为 `<prefix>-project-<slug>`，其中 slug 保留项目 id 的小写 ASCII 字母数字并以单个连字符连接（无字符幸存时为 `unnamed`）。`add` 向 `/v3/documents` 提交一篇文档；`search` 请求 `/v4/search` 并保留同时携带 id 与内容的文档；`remove` 删除 `/v3/documents/<id>`，HTTP 404 视为成功；`profile` 读取 `/v4/profile`。其余任何非 2xx 响应抛出 `MEMORY_PROVIDER_UNAVAILABLE`；add 响应缺少文档 id 时抛出 `MEMORY_REQUEST_INVALID`。

## 模型体验

### 由消费方呈现的提供方数据

#### 模型看到的内容

`memory-provider:supermemory` 产出与取回的文本——`MemoryHit.content` 值与 `/v4/profile` 摘要——仅经由 [`dsh-tool-memory`](../tool-memory/README.zh.md) 的工具与召回节呈现；本提供方不注册自己的系统提示词节或工具。

#### Token 影响

无直接影响；token 只经消费方进入请求，规模由远端搜索命中与画像摘要决定。

#### KV Cache 影响

无；提供方不改变任何请求前缀。远端画像变化会在下一次组装起改变消费方的召回节。

## 已知限制与暂缓事项

- **对外不固定 wire 字段**：厂商请求与响应字段由 [`src/client.ts`](src/client.ts) 持有，漂移告警是自动跳过的真实 API e2e（`tests/supermemory.e2e.ts`）；包之外不得依赖这些字段。
- **项目 slug 可能冲突**：slug 化丢弃大小写与分隔符，仅大小写或分隔符不同的路径会共享同一个远端容器。
- **从不写入 Codex 凭据文件**：dsh 只把它作为回退读取，登录、登出与刷新留给 Codex 插件。
