# Agent Note: Supermemory 托管记忆插件

Status: proposed

[English](2026-08-24-supermemory-plugin.md) | 中文

## 问题

dsh 会话在两次运行之间不保留任何状态。会话日志只持久化一次对话；用户的偏好、长期有效的决定和项目知识都不会进入下一次会话。用户已经通过 Codex 插件把这些知识保存在 supermemory.ai 中（`~/.codex/supermemory/credentials.json`，按容器标签划分作用域），数据存在且持续更新——只是 harness 目前无法访问它。现在直接做集成还意味着把单一厂商硬编码进工具代码，因为 harness 没有记忆能力缝（capability seam）供提供方注册。

## 提案

按照 `web` 缝模板（Service Definition / Provider / Consumer）新增 `memory` 能力缝，作为新的包组 `packages/memory/`，并通过一个新的可选安装 bundle 组合使用。

### 包拓扑

| 包 | 角色 | 内容 |
| --- | --- | --- |
| `@deepseek-ai/dsh-memory` | Service Definition | 上下文键 `memory` 下的 `MemoryRuntime extends Service`；`MemoryProvider` 接口与作用域类型；返回 disposer 的 `registerMemoryProvider()` |
| `@deepseek-ai/dsh-memory-supermemory` | Service Provider | 注入 `['memory']` 的函数式插件；对接 supermemory.ai REST API 的 `SupermemoryClient` |
| `@deepseek-ai/dsh-tool-memory` | Consumer | 注入 `['tools', 'memory']`；注册 `memory_*` 工具与回忆系统提示段 |

### 服务契约

```ts
type MemoryScope = { kind: 'global' } | { kind: 'project'; id: string };

interface MemoryProvider {
  add(input: { scope: MemoryScope; content: string }): Promise<{ id: string }>;
  search(input: { scope: MemoryScope; query: string; limit?: number }): Promise<MemoryHit[]>;
  remove(id: string): Promise<void>;
  profile(): Promise<string>;
}
```

`registerMemoryProvider()` 保存一个活跃提供方；再次注册会替换前者，disposer 负责恢复。在未注册任何提供方时调用 `ctx.memory` 的操作，会在首次使用时以 `MISCONFIGURATION` 显式失败——注册本身就是一行插件配置，缺失无法在加载期检出。运行时不变量按 `packages/AGENTS.md` 断言注册表自身拥有的关系。

项目作用域 id 由 consumer 在发起任何提供方调用之前，从 git 仓库根目录显式推导；提供方从不自行推断。

### Supermemory 提供方

Config 模式：`baseURL`（默认 `https://api.supermemory.ai`）、标记 `.role('credential-ref')` 且默认 `SUPERMEMORY_API_KEY` 的 `apiKeyEnv`、以及 `containerTagPrefix`（默认 `dsh`）。密钥解析顺序：`ctx.credentials.resolve(apiKeyEnv)`，其次是启动环境，最后读取 `~/.codex/supermemory/credentials.json`——只读，因此现有 Codex 的 `supermemory-login` 流程继续可用，dsh 从不写入该文件。作用域映射到容器标签：global → `<prefix>-global`，project → `<prefix>-project-<id 的 slug>`。客户端使用本地 Codex 脚本调用的同一批端点（文档添加、搜索、删除、profile）；响应解析留在提供方内部的线上边界处。

### Consumer 工具与回忆

三个渲染意图为 `generic` 的工具：`memory_save(content, scope)`、`memory_search(query, scope, limit?)`、`memory_forget(id)`。save 与 search 必须显式传入 `scope`，任何内容都不会静默跨越作用域；`forget` 通过 save 或 search 返回的 id 寻址，其作用域随之固定。装配时 consumer 调用一次 `profile()`，并通过 `ctx.systemPrompt.section(...)` 贡献结果段落，因此注入文本会被记录，满足现有"模型可见 ⟺ 已记录"规则的可重建要求。

### Bundle 组合

新的可安装 bundle `supermemory` 位于 `packages/bundle/`，携带三行插件配置。基础 `cordis.patch.yml` 保持不变，因此在用户启用该 bundle 之前，默认 profile、提示组装与全部已录制快照保持逐字节一致。

### 失败模式

- 未注册提供方 → 首次使用 `ctx.memory` 时抛出 `MISCONFIGURATION`。
- 工具执行时缺少凭据 → 以 `MISSING_CREDENTIAL` 工具失败的形式呈现给模型。
- 回忆阶段服务不可达或过慢 → 记录警告、省略段落、会话继续。
- 工具调用期间服务不可达 → 普通的工具失败结果。

## 已考虑的替代方案

**单个合并包**：工具 consumer 直接调用 supermemory。当下包与门禁更少，但日后更换后端意味着在 consumer 内部重写，测试也需要真实网络或临时 mock 而非 stub 提供方。三角色拆分与所有既有能力缝一致。

**组合进基础 bundle。** 零配置即可在每个会话中使用记忆工具，但工具模式会加入提示组装，同一 PR 内全部既有快照期望输出都会改变，而多数用户并未要求记忆功能。可选安装 bundle 把这一成本隔离开来。

**本地优先存储（SQLite）而非托管服务。** 无网络依赖也无厂商，但用户记忆已在 supermemory.ai 中且必须继续与 Codex 插件共享；本地存储会分叉这份数据，并引入我们不想承担的同步代码。

## 验收标准

- 三个包均通过聚焦测试、`typecheck`、`lint`、`hygiene` 与 `doc-sync`，README 带有受门禁约束的 Model Experience 与 Known Limitations 章节。
- 启用 bundle 后，agent 可在两种作用域下保存、搜索与删除记忆；只要 `profile()` 返回内容，回忆段落即出现。
- 一个无密钥快照示例将 `tool-memory` 与确定性 stub 提供方插件组合，并在无网络条件下重放。
- 一个真实 API e2e 用例覆盖 `dsh-memory-supermemory`，无凭据时自动跳过。
- 默认 profile 的快照输出不因本变更而改变。

## 风险

- supermemory.ai API 是外部接口，可能发生漂移；提供方在线上边界处负责解析，真实 API e2e 充当漂移警报，但按设计，服务中断只会把回忆降级为警告。
- 读取 `~/.codex/supermemory/credentials.json` 使我们依赖另一工具的文件布局；它仅是回退输入，从不写入。
- 从仓库根目录推导项目作用域意味着移动仓库会开启新作用域；可以接受，因为容器标签可以低成本手动重指。
