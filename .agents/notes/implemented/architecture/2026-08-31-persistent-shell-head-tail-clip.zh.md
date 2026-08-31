# Agent Note: 持久 shell 工具的头尾两半裁剪

Status: implemented

[English](2026-08-31-persistent-shell-head-tail-clip.md) | 中文

## 问题

两个持久 shell 工具都把命令输出裁剪为 `maxOutputChars` 字符的前缀，并附上一段让模型"用 `grep -n` 在文件内搜索"（pwsh 双胞胎中为 Select-String）的通知。对于任意命令输出——构建、测试运行——并不存在可搜索的文件，通知的建议是虚假的；更糟的是，裁剪销毁了输出的结尾，而错误摘要与退出判定恰恰在那里。harness 中其他所有有界输出表面都保留尾部或头尾（一次性 `tool-bash`、`terminal_read`、spill 策略的 `headTail` 预览）；部署中的上限（`dsh-base` 里 `maxInlineBytes` 50000 高于 `maxOutputChars` 16000）意味着 spill 策略从不对 bash 输出二次限界，因此前缀裁剪就是最终的模型可见文本，尾部在任何地方都无法找回。工具自己的源码里就带着承认通知有误的 `TODO`。

## 决策

`maybeTruncate` 现在把预算等分为头尾两半（`maxOutputChars` 的 `ceil`/`floor`），并把通知放在缺口处，写明确切省略的字符数与诚实的恢复动作：把命令输出重定向到文件后重新运行并搜索该文件。两个双胞胎除搜索工具名外完全一致落地。`maybeTruncate` 移除了 `incomplete` 参数：起始标记被 scrollback 丢弃是 `LOST_PREFIX_MESSAGE` 的事实，一个事实只有一条通知——旧代码会在"不完整但未超预算"的输出后再追加裁剪通知，重复了丢失前缀的解释。

预算仍按字符计数，因为 `maxOutputChars` 是加载时校验的字符契约；共享的 `TextRetainer` 以字节为导向，采用它会静默改变配置的含义。切分比例固定为对半，不做成旋钮：没有任何随部署变化的因素取决于中点落在哪里。

## 备选方案

**保留前缀裁剪，只修正通知措辞。** 否决：尾部丢失才是缺陷；`npm test` 输出结尾的错误文本正是模型需要做出反应的内容。

**改走 spill 策略而非本地裁剪。** 作为本缺陷的修复被否决：部署的 `maxInlineBytes` 高于 `maxOutputChars`，策略 spill 从不为这些结果触发，而且把会话自有 spill 接入持久双胞胎是另一个特性。

**通过 `TextRetainer` 采用字节预算。** 因单位不匹配否决：它会按 UTF-8 字节限界，而配置、其校验与所有测试都以字符为准。

## 后果

长命令现在渲染其开头与结尾各 `maxOutputChars/2` 字符，中间是诚实的省略计数，其后是任意的 `[exit code: N]` 标记；预算内的结果不变，不完整的结果只携带丢失前缀通知。`<response clipped>` 标记保留，锚定它的下游消费者继续工作。两个双胞胎的测试在综合场景、窗口内流参照与越窗冻结三处固定了头部片段、确切省略计数与尾部片段；没有任何 keyless 快照固定旧通知文本（工具 schema 快照中的该短语属于 `edit` 工具的描述）。64KB 回退窗口契约不受影响：它约束累积期间的宿主内存，而本变更只治理渲染路径。
