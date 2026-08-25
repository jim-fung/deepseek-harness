# Agent Note: 修订探测的建议性 cwd 提示

Status: implemented

[English](2026-08-25-revision-probe-cwd-hint.md) | 中文

## 问题

每次修订新鲜度探测（`PersistenceBackend.readStoredRevision`）都通过扫描根目录下的全部项目目录来解析会话 id —— 对根目录做一次 `readdir`，再对每个项目执行约八次文件系统探测 —— 尽管发起探测的调用方（校验缓存 preparation 的 coordinator）已经持有存储 header 的 `cwd`，而且 preparation 的身份校验已将该 cwd 绑定到工件路径。JSONL 布局在给定 (root, cwd, id) 时是确定性的，扫描等于重新推导调用方已知的事实。

这些探测位于热路径上：缓存 `inspect()` 背后的新鲜度复查（每次 session-query 工具命中、每个子代理列表项都会触发）、apiproxy 冷采纳、冷加载 `commitPrepared`，以及每次新会话启动两次。共享根目录下项目越多，每次命中付出的全量扫描越贵。

## 决策

`PersistenceBackend.readStoredRevision` 新增可选的尾随参数 `hint?: StoredRevisionHint`，携带 `{ cwd }`。尾随位置（在 `signal` 之后）保证所有既有实现保持源码兼容：忽略提示的实现无需改动。

JSONL 后端先对 `logPath(root, cwd, id)` 做 stat，命中即返回该 stat 派生的修订；提示未命中（ENOENT —— cwd 错误或已移动）时回退到未改变的全量 `findLog` 扫描，因此依赖跨 cwd 发现语义的调用方行为不变。SQLite 后端接受但忽略该提示：单一数据库仅按 id 索引会话，行查找本来就是直接定位。

coordinator 从唯一汇聚点 `isPreparedSourceCurrent` 传递提示，覆盖两类探测调用方（`inspect()` 的新鲜度复查与冷加载 `commitPrepared`）。`createCore` 中的创建冲突探测、`loadStored` 本身以及 `seedMatchesPersisted` 刻意保留全量扫描：在任意存储范围发现工件都必须阻止创建或驱动采纳，而 preparation 在读出工件之前并不知道 cwd。

未加入路径记忆化：coordinator 传递提示之后，仅剩测试会进行无提示的修订读取，正向的 id 到路径缓存只会为不存在的调用方增加失效负担。

提示在契约上是建议性的：后端在没有提示时必须以相同方式解析 id，未命中回退到完整发现，任何正确性都不得依赖提示正确。

## 备选方案

**从成功的 `findLog`/`listArtifacts` 解析记忆化 id 到路径。** 仅缓存正向结果、使用时以 stat 校验的缓存仍需每次探测付出一次 stat，并跨后端引入共享可变状态与失效推理；提示直接给出权威 cwd，缓存在热路径上一无所获。

**为 `loadStored` 增加同样的提示。** `loadStored` 的调用方要么尚不知道 cwd（发现工件的冷读取），要么绝不能只信任单一范围（创建冲突探测与种子匹配，任何范围下的工件都会改变结果）。没有哪个 `loadStored` 调用方持有权威 cwd，该参数会是死代码。

**传入裸 `cwd: string | undefined` 而不是 `StoredRevisionHint` 接口。** 命名接口让建议性契约在 seam 处拥有唯一的 JSDoc 归宿，未来的建议性字段也无需重塑每个签名。

## 后果

cwd 正确时（常见情形，因为存储 header 拥有工件位置），一次新鲜度探测只需一次 `stat` 而非根目录扫描，session-query 命中、子代理列表、apiproxy 采纳与会话启动不再随共享根目录下的项目数量伸缩。cwd 错误或已移动时，在不变的扫描之前多付出一次 ENOENT stat。

提示命中会跳过扫描执行的重复 id 与反向编码检查。编码仍由每后端一次的 `ensureRootEncoding` 检查守护，跨项目目录的重复 id 仍会在每次全量扫描（`load`、`list`、创建冲突）时拒绝；因此在重复 id 状态下，被提示的探测会返回提示工件的修订而不是立即抛错，响亮的拒绝推迟到下一次完整读取显现。除此外，有无提示的新鲜度结论完全一致，持久化行为不变。

## 测试

JSONL 测试固定了提示命中（第二个项目目录存放另一个会话时全量扫描从未被调用）与提示未命中（回退扫描仍在工件实际所在的项目目录下解析出它）；既有的跨 cwd 创建冲突测试继续守护全量扫描的创建探测。coordinator 测试在受控后端上记录收到的提示，断言每次 preparation 新鲜度探测都携带存储 header 的 cwd。
