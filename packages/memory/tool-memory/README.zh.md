# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

[记忆能力 seam](../memory/README.zh.md) 的面向模型消费方：注册 `memory_save`、`memory_search`、`memory_forget` 三个工具、一段指导性系统提示词节，以及把用户记忆画像注入每次组装提示词的召回节。执行经由 `ctx.memory`；本包持有 schema、校验、指导文案与召回，从不触及提供方选择或网络访问。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `memory_save` | `content`（非空文本）、`scope`（`project` 或 `global`） | 存储一条记忆；输出给出 id 与 scope。 |
| `memory_search` | `query`、`scope`、可选 `limit`（1–25 的整数） | `limit` 受 `MEMORY_SEARCH_MAX_LIMIT = 25` 约束；输出列出 `[id] 内容` 命中或空结果提示。 |
| `memory_forget` | `id`（非空） | 按 id 删除一条存储的记忆。 |

配置开关 `save`、`searchAndForget` 与 `recall`（均默认 `true`）选择工具族与召回节；指导节 `tool:memory`（order 120）在任一工具族启用时注册。项目 scope id 在执行时从进程工作目录派生（包含 `.git` 的最近祖先目录，否则为工作目录本身）；scope 取值不是 `project` 或 `global` 时抛出 `MemoryError`，code 为 `MEMORY_REQUEST_INVALID`。提供方不可用时，已启用的工具仍然可见，并在执行时以结构化错误失败。

## 自动召回

`system-prompt/assemble` 瀑布监听器先等待 `next()`，再获取 `ctx.memory.profile()`，并在全部有序节之后追加节 `memory-profile`（`MEMORY_PROFILE_SECTION_NAME`），因此在拼接后的提示词中渲染在最后。空画像不产生节；召回的任何失败降级为一条警告日志并省略该节——不可达的记忆服务不得拖垮会话。组装节是组装结果的一部分，因此注入文本始终可以从会话日志重建。

## 模型体验

### 指导系统提示词

#### 模型看到的内容

任一工具族启用时，每次组装的提示词都携带节 `tool:memory`（order 120）；确切文本如下。

##### 指导节文本

```markdown
Persistent memory spans sessions. When the user asks you to remember something, or states a durable preference or decision, store it with memory_save — use scope "project" for repository-specific knowledge and "global" for user-level preferences. Before acting on assumptions about the user or this project, consider memory_search. memory_forget removes one memory by id.
```

#### Token 影响

启用期间每次组装固定；`save` 与 `searchAndForget` 均关闭时为零。

#### KV Cache 影响

同一会话内跨请求的稳定重复前缀；关闭任一工具族或修改此文本会使下一次组装起的复用失效。

### 记忆工具定义

#### 模型看到的内容

三个已注册工具的名称、描述与参数，即上表所概括：`memory_save(content, scope)`、`memory_search(query, scope, limit?)`（`limit` 限定 1–25）与 `memory_forget(id)`。

#### Token 影响

有条件：配置开关开启时三个工具定义随每个请求携带；每个被关闭的族会移除其定义。

#### KV Cache 影响

配置开关变化通过增删工具定义替换请求 token；执行结果只进入工具结果轮次。

### 召回节

#### 模型看到的内容

节 `memory-profile` 追加在全部有序节之后，因此渲染在最后：固定引导行 `Durable memories about the user and past sessions:` 加上提供方的画像摘要。

#### Token 影响

有条件：画像为空或 `recall` 关闭时为零；否则每次组装计入画像长度的文本。

#### KV Cache 影响

该节属于请求前缀，因此组装之间变化的画像会使下一次请求起的复用失效；画像不变时它是稳定的重复前缀。

## 已知限制与暂缓事项

- **每次组装只追加一个静态召回节**：该节反映组装时获取的画像；会话中途没有增量更新。
- **项目 scope 在执行时从进程 cwd 派生**：会话在两次调用之间改变工作目录时会寻址不同的项目分区。
