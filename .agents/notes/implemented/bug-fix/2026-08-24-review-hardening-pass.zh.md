# Agent Note：基于评审的线协议、框架与解码加固

Status: implemented

[English](2026-08-24-review-hardening-pass.md) | 中文

## 问题

一次全仓库评审发现四个恰好落在门禁盲区的缺陷，以及两个面向模型的信任缺口：

- `dsh-sdk-jsonrpc-server` 将请求参数双重断言为 TypeScript 类型，不匹配或恶意的客户端会得到晦涩的 `-32603` 失败，或以任意值为键创建会话。
- `dsh-mcp-client` 把外部服务器声明的 `inputSchema` 原样放进每个提供方请求，却只校验输出 schema；一个使用不受支持词汇的 schema 可能在远离肇因服务器的地方破坏或操纵请求。
- 两个子进程输出收集器（`subprocess-local`、`subprocess-e2b`）用裸 `toString('utf8')` 解码按字节裁剪的窗口，跨增量读取拆开的多字节字符渲染为 U+FFFD——非 ASCII 输出的模型可见损坏。
- `pluginInventory.list` 以 trusted-host 权限发布全部署范围的模块名与启用／失败状态，而同等侦察价值的 `agentPreset.read` 却被钉在 loopback。
- skill 正文在 `<skill_content>` 包装内原样嵌入，而项目目录是默认 skill 根，仓库自带的 skill 文件可以在提示词中伪造包装块或 `<system-reminder>` 块。
- 手工维护的映射与事实漂移：compiler face 文档称 `api/remotes` 是唯一拆分包，但 `api/gateway` 与 `client/connection` 也拆分；包组表遗漏 `mcp/` 与 `runtime-diagnostics/`（后者连组 README 都没有）。

## 决策

线校验落在拥有线形态的边界上。SDK 服务器在任何处理器状态改变之前校验 `initialize` 与 `session/prompt` 参数，并以类型化的 `InvalidParamsError` 拒绝；共享传输把抛出值携带的数值型 `code` 原样放到错误帧上，客户端看到的是 `-32602` 而非笼统的 `-32603`。content block 只在信封层面校验（对象数组且带字符串 `type`）——按类型的字段校验仍归消息工厂。

MCP 输入 schema 必须满足与输出相同的强制 JSON Schema 子集。不受支持的输入 schema 没有安全回退——注册降级后的参数会静默改变模型对该工具的调用方式——因此恰好跳过该工具并记录指明服务器与工具的错误日志；其余工具照常注册。

输出解码携带跨读取状态：每个收集器持有一个流式 `TextDecoder` 以及已消费到的字节偏移。恰在该偏移上的前向读取只以 `{ stream: true }` 喂入未消费字节，在被完成的那次读取中补齐被拆开的序列；向后重读与有损读取从请求偏移重新解码，切点落在序列内部时可能渲染出一个 U+FFFD。seam 契约对此作了文档化。

特权方法钉控仍以 `PRIVILEGED_METHODS` 为权威；`pluginInventory.list` 加入了它，因为发布部署的插件清单与读取 preset 组合同属侦察类。

skill 渲染对包装词汇标签（`skill_content`、`skill_instructions`、`skill_resources`、`system-reminder`）的开括号不区分大小写地转义为 `&lt;`，正文其余字节保持不变：被转义的序列无法复现字面包装，而 `<code>` 等普通标记原样通过。

文档已对照代码树修正：点名全部三个拆分包，aggregate 表列出其引用的 leaf，组表加入 `mcp/` 与 `runtime-diagnostics/`，并为 `runtime-diagnostics/` 补了组 README。`packages/README.md` 预算因两行必需条目由 994 上调至 1007。

## 已考虑的替代方案

**每个 SDK 方法配 zod schema（apiproxy 风格）。** 暂缓：该服务器只有三个方法且参数形状扁平，手写校验器避免引入新运行时依赖，并与 ACP 桥的先例一致。

**对不受支持的 MCP 输入回退为无约束 schema。** 否决：静默降级会把失败推离肇因服务器，并在没有任何信号的情况下改变模型行为。跳过一个工具既响亮又有界。

**在流结束时一次性解码输出。** 否决：消费方在长命令期间轮询增量读取；推迟到退出才给出正确文本，等于重新引入修复要消除的损坏窗口。

**转义 skill 正文中的所有 `<`。** 否决：skill 合法包含标记与代码示例；把转义收窄到包装词汇既能保真正文又封死伪造路径。

## 后果

SDK 客户端现在可以对 `-32602` 分支处理；依赖宽松参数（缺省字段默认值）的部署必须发送完整参数——没有随附客户端依赖过这一点。声明不可表示 schema 的 MCP 服务器会在上游修复前失去恰好那一个工具。非 ASCII 子进程输出跨读取字节保真；重读较早偏移的读取方得到全新解码，无法共享流式状态。仅限 loopback 的 `pluginInventory.list` 收窄了 LAN 客户端可枚举的范围。正文含字面包装 token 的 skill 在提示词中呈现为可见转义——这是限定在这些 token 内的模型可见变化。两条既有的 maxTokens 拒绝测试从处理器契约移到了线契约，消息随之改为 `-32602` 文案。
