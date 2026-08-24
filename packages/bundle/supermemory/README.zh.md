# @deepseek-ai/dsh-supermemory

[English](README.md) | 中文

可选的托管记忆 profile 组合包：持久记忆存储在 [supermemory.ai](https://supermemory.ai)，启用该组合包的每个会话都可访问。[`cordis.patch.yml`](cordis.patch.yml) 是本包的实质内容，由 `dsh.bundle.patch` manifest 字段声明；该补丁在基础组合之上插入三行，不修改任何既有行，因此未启用本组合包的 profile 不受影响。

| 行 | 包 | 贡献 |
|---|---|---|
| `memory` | `@deepseek-ai/dsh-memory` | `ctx.memory` seam（[README](../../memory/memory/README.zh.md)）。 |
| `memory-provider` | `@deepseek-ai/dsh-memory-supermemory` | supermemory.ai 提供方，配置 `containerTagPrefix: dsh`（[README](../../memory/memory-supermemory/README.zh.md)）。 |
| `tool-memory` | `@deepseek-ai/dsh-tool-memory` | 记忆工具、指导节与召回（[README](../../memory/tool-memory/README.zh.md)）。 |

通过 profile 的组合包列表启用；补丁在其跟随的基础组合包之后应用：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@deepseek-ai/dsh-supermemory"]
    }
  }
}
```

提供方行在每次操作时解析 API 密钥（credentials 服务、启动环境变量或只读的 Codex 凭据文件）。缺少密钥或 `api.supermemory.ai` 不可达时，召回降级为警告日志并省略该节，而 `memory_*` 工具调用以结构化的 `MemoryError` 结果失败。

## 模型体验

### 组合出的记忆上下文

#### 模型看到的内容

恰为被插入行的包所注册的内容：[`dsh-tool-memory`](../../memory/tool-memory/README.zh.md) 的 `tool:memory` 指导节、其 `memory_save`、`memory_search`、`memory_forget` 工具及其 `memory-profile` 召回节；本组合包自身不添加任何模型可见内容。

#### Token 影响

无直接影响；全部 token 归被组合的行所有，见各自 README。

#### KV Cache 影响

在 profile 中增删本组合包会从下一个会话起改变组合后的请求前缀；组合包自身不修改前缀。

## 已知限制与暂缓事项

- **需要 supermemory 账号且 `api.supermemory.ai` 可达**：缺少密钥时所有记忆操作失败；故障期间召回降级为警告日志并省略该节。
