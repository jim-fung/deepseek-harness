# Agent Note：性能评审带来的热路径成本削减

Status: implemented

[English](2026-08-25-hot-path-cost-reductions.md) | 中文

## 问题

覆盖 turn 路径、持久化平面、启动与执行轮询的五路性能评审发现四个随产品既有工作量增长的成本：

- 每条持久 shell 命令在每次就绪轮询都做全进程表检查：`inspectForeground` 扫描它并不使用的后代树（macOS 上按 50ms 节奏每次轮询约 2 个 `/bin/ps` 子进程；Linux 每次轮询 3 次 `/proc` 扫描），一条构建命令累计数千次。
- 终端 scrollback 追加是二次复杂度：每个 PTY 数据事件对全部保留文本重跑 `split('\n')`，到达 4MB 上限后还要遍历数百万元素的码点数组找 UTF-8 尾部——O(输出²/上限) 的 CPU 以反复事件循环停顿的形式呈现。
- token meter 热订阅 `session/event` 并经由会话快照 getter 折叠，而每次 append 都会使该 getter 失效——首次 measure 之后，每个流式 assistant chunk 都会重新物化整份日志的冻结副本：每轮 O(chunk 数 × 日志长度) 分配。
- persistence write-behind 在入队时深拷贝每个事件，尽管 Session.append 已做过快照并递归冻结——每 chunk 对同一不可变数据的第二份完整拷贝。
- 每次启动任何 profile 都会运行 `healProfilesModuleFallback`：同步 BFS 解析约 200–260 份 workspace manifest（冷缓存或 Windows AV 下估计 100ms–2s），且发生在 profile 校验之前。

## 决策

轮询只在 send 结算时做进程表工作。`SubprocessTerminalHandle` 新增 `noteSendSettled()`；本地提供方把（保留围栏语义的）后代收编移到那里而非 `inspectForeground`，teardown 保留自身扫描。E2B 以附理由的 no-op 实现。Linux `inputWaiting` 有意保持即时读取：readiness 在每次轮询有状态地消费它，且不存在等价的更廉价探测——修复后 macOS 每次轮询 1 次 exec，Linux 1 次扫描。scrollback 保留改为分块缓冲加累计字节／换行计数器和头部消费游标；逐出顺序（先行后字节）、标记粘性与返回字节由朴素参照实现 oracle 测试钉死；`read()` 按增量维护的行索引切片。

计量改为惰性折叠：移除热订阅，读取经游标推进已消费事件，补读摊还为 O(距上次读取的新事件数)；所有消费方都在读取总量前同步调用 `measure()`，因此无人能观察到过期计数。write-behind 在 `Object.isFrozen(event)` 成立时按引用保留入队事件（Session 追加时冻结即所有权边界），仅对未冻结输入克隆。

profile 修补引入 fail-open 戳记：遍历既有链接的对账循环仍每次启动运行，但当 `$DSH_HOME/profiles/node_modules/.dsh-heal.json` 记录的 anchor-manifest 与根 lockfile 的 mtime／size 未变且附带上次链接映射时跳过发现 BFS（传递依赖无法只从 anchor 解析）。任何读取／形状／stat 错误、失效链接目标或 anchor／lockfile 变更都会回落到今天的完整修补；戳记写失败按具名原因吞掉，绝不导致启动失败。

## 已考虑的替代方案

**仅 teardown 时发现后代。** 被测试否决：被 disown 的子进程在 shell 存活期间即改换父进程，在 PID 复用围栏下退出后扫描不可见——结算时收编是保住无泄漏保证的最晚时机。

**惰性 Linux `inputWaiting`。** 否决：`pollReadiness` 与写入前等待每次轮询都消费它，惰性只是挪动扫描；组成员资格没有更廉价的等价探测。

**为 meter 提供 Session 索引访问器。** 折叠转为惰性后不再需要——游标使补读对新事件呈线性，且无消费方需要逐 append 更新。

**无条件修补但加速 manifest 解析。** 否决：解析速度解决不了约 2000 次冷同步 fs 操作；戳记删掉整个遍历，同时保证 pnpm 触发的图变更可触及的信号都能回到完整修补。

## 后果

长持久 shell 命令在命令期间零次进程表扫描、每次结算 send 一次扫描；scrollback 成本随输出线性。流式 turn 在 meter 与持久化队列中都不再为每个 chunk 分配日志大小的数组。打上戳记后每次启动跳过约 443 次 manifest 解析（实测热缓存 41.5ms → 6.1ms；冷缓存收益更大）。残留缺口就地记录：戳记信任 anchor+lockfile 指纹（手改中间层 manifest 会延迟但响亮地在 Loader 解析时报错），分块缓冲的字节计数假设追加边界不切开代理对——由上游流式解码器保证。同一评审的相关修复见 [持久 shell fallback 窗口](2026-08-25-persistent-shell-fallback-window.zh.md) 与 [revision-probe cwd 提示](2026-08-25-revision-probe-cwd-hint.zh.md)。
