# @deepseek-ai/dsh-memory

[English](README.md) | 中文

持久记忆能力 seam 的 Service Definition：以 `MemoryRuntime` 服务持有 `ctx.memory` 键，并把按 scope 划分的操作委托给唯一活跃的 `MemoryProvider`。本包不持有存储；提供方向其注册（例如 [`@deepseek-ai/dsh-memory-supermemory`](../memory-supermemory/README.zh.md)），消费方负责渲染结果（例如 [`@deepseek-ai/dsh-tool-memory`](../tool-memory/README.zh.md)）。

## 注册与委托

`registerMemoryProvider(provider)` 使新提供方立即生效：后续注册会替换当前提供方，返回的清理函数只移除该次注册，并恢复被它顶替的提供方。活跃提供方始终是最近注册且尚未清理的那一个。没有任何注册提供方时，操作抛出 `MemoryError`，code 为 `MEMORY_NO_PROVIDER`。

| 操作 | 请求 | 返回 |
|---|---|---|
| `add` | scope 与内容 | 存储后的 `MemoryHit`，携带提供方分配的 id |
| `search` | scope、查询、可选 limit | 匹配的命中，数量不超过 `limit`；一次结果从不混合 scope |
| `remove` | 之前返回的某个 `MemoryHit.id` | 无返回；删除该存储记忆 |
| `profile` | 无 | 用户级画像文本，无任何存储时为 `''` |

Scope 按 kind 判别：`{ kind: 'global' }` 寻址用户级记忆，`{ kind: 'project'; id: string }` 寻址单个项目分区。项目 id 由消费方派生——[`dsh-tool-memory`](../tool-memory/README.zh.md) 从进程工作目录派生——绝不由提供方派生；提供方只接收 id 并在其后划分存储。后端无法服务时抛出 `MemoryError`，code 为 `MEMORY_PROVIDER_UNAVAILABLE`。

## 模型体验

### 由消费方呈现的提供方数据

#### 模型看到的内容

活跃提供方产出的 `MemoryHit.content` 文本与 `profile()` 摘要，仅经由 [`dsh-tool-memory`](../tool-memory/README.zh.md) 的 `memory_save`、`memory_search`、`memory_forget` 工具输出及其 `memory-profile` 召回节呈现；本包不注册任何系统提示词节、工具或其他模型可见内容。

#### Token 影响

无直接影响；该 seam 携带的每个 token 都经由消费方的工具输出或召回节进入请求，规模由提供方数据决定并受该消费方约束。

#### KV Cache 影响

无；委托不改变任何请求前缀。召回节的位置与提供方数据的变化归消费方和活跃提供方所有。

## 已知限制与暂缓事项

- **刻意只保留单个活跃提供方**：后续注册不经仲裁直接替换先前的注册；多提供方扇出或优先级规则等待真实需求出现。
- **没有事件流**：seam 不发出事件，因此召回内容只能通过组装后的提示词观察，无法通过可记录的事件流观察。
