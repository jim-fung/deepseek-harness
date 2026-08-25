# Agent Note: 持久 shell 工具中有界的 fallback 窗口

Status: implemented

[English](2026-08-25-persistent-shell-fallback-window.md) | 中文

## 问题

`tool-bash-persistent` 与 `tool-pwsh-persistent` 在命令的每次轮询迭代中无上限地累积一个 `fallback` 字符串：命令存活期间每个非空的增量 delta 都会被追加。一条流出 200MB 的命令至少占住 200MB 宿主堆内存，尽管 fallback 只服务一个目的——在起始标记滚出终端有界 scrollback 之后，让 `partialOutput` 恢复从命令起始处的输出——而渲染只保留该标记之后前 `maxOutputChars`（默认 16000）个字符。占住的这些兆字节对模型可见内容毫无贡献。

## 决策

累积只保留起始标记及其后 `FALLBACK_WINDOW_BYTES`（65536）字节，两个孪生包以完全相同的方式落地。一旦累积字符串增长超过该窗口，就切到 `[markerStart, markerStart + marker.start.length + FALLBACK_WINDOW_BYTES]`，置位 `fallbackTruncated` 使 `partialOutput` 将结果标记为不完整，并由独立的 `fallbackWindowed` 标志停止为该命令追加后续 delta。视口替换（空的增量 delta）会从视口重新开始累积并清除两个标志，与 `fallback` 本身今天的重置位置一致。

`fallbackWindowed` 与 `fallbackTruncated` 分离，是因为既有标志还会锁存后端上报的输出丢弃（`incremental.truncated || result.truncated`）；若在该成因上也停止追加，会改变窗口内命令的保留字节。`partialOutput` 本身未改动：窗口之内，结束标记搜索仍命中此前命中的所有位置，判定不变；窗口之外，搜索现在可能错过结束标记，已置位的 `fallbackTruncated` 将判定降级为不完整——降级只落在那些额外字节本就不会被渲染的输出上。

窗口是放在 `SCROLLBACK_PAGE_LINES` 与 `POLL_INTERVAL_MS` 旁边的具名模块常量，而非配置字段：没有任何模型或线上可见之物依赖它，且这些文件里的同类内部界限都是常量（`maxOutputChars` 恰因模型可见而才是配置）。

## 备选方案

**复用 `fallbackTruncated` 单个标志承担停止追加。** 放弃：该标志还会锁存后端截断，在该成因上冻结 fallback 会丢弃窗口内命令的保留字节——这是本修复无权做出的模型可见变更。

**改在 `partialOutput` 内截断而非在累积处。** 放弃：被占住的是累积字符串本身；读取时截断无法消除堆增长。

**把窗口做成配置字段。** 放弃：部署只能通过内存占用观察到它，一个带校验和文档的新旋钮比它替换掉的固定界限成本更高。

**将窗口下限钳制为配置的 `maxOutputChars`。** 放弃：界限将随部署变化，修复的内存保证会依赖配置。将 `maxOutputChars` 大幅调高于默认值的部署，转而接受标记滚出场景下恢复被截断在窗口处这一已文档化行为（两个工具的已知限制均已记录）。

## 后果

流出型命令在 fallback 路径上的宿主内存被限定在标记 + 64KB；视口替换自身受视口大小约束。标记后输出落在窗口内的命令，渲染结果与之前逐字节一致。超出窗口时，标记滚出的部分结果被读作不完整（前缀丢失加截断提示）而非已结算；默认配置下渲染的输出字节不变，只有判定诊断不同。两个孪生的镜像轮询测试以逐文件 100% 覆盖固定了：窗口内输出与无上限模拟的参照一致、超窗结果标记不完整且输出仍从命令起始恢复、以及视口替换清除标志。镜像契约本身由 [pwsh-persistent-pty](../architecture/2026-08-11-pwsh-persistent-pty.zh.md) 拥有。
