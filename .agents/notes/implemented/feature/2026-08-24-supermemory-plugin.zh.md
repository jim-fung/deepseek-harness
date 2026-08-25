# Agent Note: Supermemory 托管记忆插件

Status: implemented

[English](2026-08-24-supermemory-plugin.md) | 中文

## 问题

dsh 会话在两次运行之间不保留任何状态。会话日志只持久化一次对话；用户的偏好、长期有效的决定和项目知识都不会进入下一次会话。用户已经通过 Codex 插件把这些知识保存在 supermemory.ai 中（`~/.codex/supermemory/credentials.json`，按容器标签划分作用域），数据存在且持续更新——只是 harness 目前无法访问它。现在直接做集成还意味着把单一厂商硬编码进工具代码，因为 harness 没有记忆能力缝（capability seam）供提供方注册。

## 决策

harness 以包组 `packages/memory/` 交付 `memory` 能力缝，沿用 `web` 缝的三角色结构，并通过 `packages/bundle/supermemory/` 下的可选安装 bundle `@deepseek-ai/dsh-supermemory` 组合使用。

### 包拓扑

| 包 | 角色 | 内容 |
| --- | --- | --- |
| `@deepseek-ai/dsh-memory` | Service Definition | 上下文键 `memory` 下的 `MemoryRuntime extends Service`；`src/types.ts` 中的 `MemoryProvider` 接口与作用域类型；返回 disposer 的 `registerMemoryProvider()` |
| `@deepseek-ai/dsh-memory-supermemory` | Service Provider | 注入 `['memory']` 的函数式插件；对接 supermemory.ai REST API 的 `SupermemoryClient` |
| `@deepseek-ai/dsh-tool-memory` | Consumer | 注入 `['tools', 'memory', 'systemPrompt']`；注册 `memory_*` 工具与召回节 |

### 服务契约

`ctx.memory` 提供 `add`、`search`、`remove` 与 `profile`，全部委托给唯一活跃提供方。`registerMemoryProvider()` 保存一个活跃提供方；后注册者替换当前提供方，disposer 负责恢复被替换者。未注册任何提供方时执行操作抛出 code 为 `MEMORY_NO_PROVIDER` 的 `MemoryError`；后端无法服务抛出 code `MEMORY_PROVIDER_UNAVAILABLE`；scope 取值不是 `project` 或 `global` 抛出 code `MEMORY_REQUEST_INVALID`。作用域按 kind 判别——`{ kind: 'global' }` 面向用户级记忆，`{ kind: 'project'; id: string }` 面向一个项目分区。项目 id 由消费方推导、提供方从不自行推断：`dsh-tool-memory` 在执行时从进程工作目录（包含 `.git` 的最近祖先目录，否则为工作目录本身）推导 id。

### Supermemory 提供方

Config：`apiKeyEnv`（角色 `credential-ref`，默认 `SUPERMEMORY_API_KEY`）、`baseURL`（默认 `https://api.supermemory.ai`）与 `containerTagPrefix`（默认 `dsh`）。API 密钥在每次操作时解析、从不缓存：挂载了 credentials 服务时先 `ctx.credentials.resolve(apiKeyEnv)`，否则读取启动环境，最后只读地读取 `~/.codex/supermemory/credentials.json`——现有 Codex 的 `supermemory-login` 流程继续可用，dsh 从不写入该文件。整条链耗尽时抛出 `MemoryError` code `MEMORY_PROVIDER_UNAVAILABLE`，并指名全部已查询来源。作用域映射到容器标签：global → `<prefix>-global`，project → `<prefix>-project-<id 的 slug>`（slug 为小写 ASCII 字母数字并以单个连字符连接）。客户端调用本地 Codex 脚本使用的同一批端点（文档添加、搜索、删除、profile）；响应解析留在提供方的线上边界处。

### Consumer 工具与召回

三个渲染意图为 `generic` 的工具：`memory_save(content, scope)`、`memory_search(query, scope, limit?)`（`limit` 限定 1–25）与 `memory_forget(id)`。save 与 search 必须显式传入 `scope`，任何内容都不会静默跨越作用域；`forget` 通过 save 或 search 返回的 id 寻址，其作用域随之固定。配置开关 `save`、`searchAndForget` 与 `recall`（均默认 `true`）选择工具族与召回节；提供方不可用时已启用的工具仍然可见，并在执行时以结构化错误失败。召回运行在 `system-prompt/assemble` waterfall 中：监听器先 `await next()`，再获取 `ctx.memory.profile()`，并在全部有序节之后追加节 `memory-profile`，因此它在拼接后的提示词中最后渲染；空 profile 不产生节，任何召回失败都降级为记录警告并省略该节——记忆服务不可达绝不能使会话失败。装配出的节属于装配结果的一部分，因此注入文本满足"模型可见 ⟺ 已记录"规则，可从会话日志重建。

### Bundle 组合

可安装 bundle `supermemory` 携带三行仅做插入的 patch 行——`memory`、`memory-provider`、`tool-memory`。基础 `cordis.patch.yml` 保持不变，因此在用户启用该 bundle 之前，默认 profile、提示组装与全部已录制快照保持逐字节一致。

## 已考虑的替代方案

**单个合并包**：工具 consumer 直接调用 supermemory。当下包与门禁更少，但日后更换后端意味着在 consumer 内部重写，测试也需要真实网络或临时 mock 而非 stub 提供方。三角色拆分与所有既有能力缝一致。

**组合进基础 bundle。** 零配置即可在每个会话中使用记忆工具，但工具模式会加入提示组装，同一 PR 内全部既有快照期望输出都会改变，而多数用户并未要求记忆功能。可选安装 bundle 把这一成本隔离开来。

**本地优先存储（SQLite）而非托管服务。** 无网络依赖也无厂商，但用户记忆已在 supermemory.ai 中且必须继续与 Codex 插件共享；本地存储会分叉这份数据，并引入我们不想承担的同步代码。

## 后果

可选 bundle 的代价是一次显式启用步骤，换来的是默认 profile 的零足迹记忆：全部既有快照保持逐字节一致。无密钥装配转写快照（`examples/headless-agent`，由 `pnpm run test:snapshot -t memory` 重放）在 localhost 线上服务器上运行，固定了真实工具 schema 与召回输出；针对 supermemory.ai 的真实 API e2e 在没有 `SUPERMEMORY_API_KEY` 时自动跳过，并充当未固定的外部线上协议的漂移警报。按设计，服务中断只会把召回降级为警告，而记忆工具调用以普通工具失败结果返回。

按操作解析密钥的代价是每次记忆调用多一次解析，换来的是会话启动时既不触碰网络也不触碰密钥库；缺失密钥在所尝试的操作处浮现，而不是破坏加载。读取 `~/.codex/supermemory/credentials.json` 使我们依赖另一工具的文件布局；它是从不写入的只读回退输入，格式错误的内容会降级到下一个来源而不是使会话失败。作用域身份完全由容器标签承载，因此移动仓库会开启新的项目作用域，不同路径也可能因 slug 冲突；容器标签可以低成本手动重指。缝只持有一个活跃提供方——后注册者直接替换前者、不做仲裁——且不发射事件流，召回内容只能通过装配后的提示词观察。召回按构造最后渲染（追加在全部有序节之后），这保持了位置稳定，代价是携带装配时获取的 profile，会话中途没有增量更新。
