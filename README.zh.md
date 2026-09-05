# dsh-session-snapshot

**为每个 DeepSeek Harness 会话滚动保留校验过的备份——任何损坏最多只损失当前这一回合。**

[English](README.md)

会话完整性三件套之一：

| 阶段 | 插件 | 职责 |
|---|---|---|
| 预防 | [dsh-session-guard](https://github.com/po-et/dsh-session-guard) | 阻止两个 dsh 进程写坏同一会话 |
| **快照** | **dsh-session-snapshot**（本项目） | **在每个回合边界留一份校验过的好副本** |
| 修复 | [dsh-session-rescue](https://github.com/po-et/dsh-session-rescue) | 修复或抢救已经损坏的日志 |

## 为什么需要它

`dsh-session-guard` 能挡住常见的并发写损坏，但有两类损坏是任何插件都拦不住的：**写入过程中崩溃**，以及 dsh 自身在任何 agent step 之前运行的**冷加载修复路径**。本插件从另一侧堵住这个残留缺口：每个回合结束后，校验当前日志是否仍可加载，是则提升为一份快照；若回合结束时日志已损坏，则**绝不覆盖上一份好快照**，并提示如何恢复——最多只损失进行中的那一回合。

## 安装

```sh
dsh plugin --profile web add dsh-session-snapshot
```

装完即自动在回合边界打快照。在用 AI agent？直接说：**"装上 dsh-session-snapshot 插件。"**

## 恢复损坏的会话

CLI 在 dsh 自身启动不了时照样能用：

```sh
npx dsh-session-snapshot                 # 列出所有会话的快照与实时健康状态
npx dsh-session-snapshot list 37374e34   # 查看单个会话的快照（id 片段）
npx dsh-session-snapshot restore 37374e34   # 恢复最新的、校验通过的快照
npx dsh-session-snapshot snapshot 37374e34  # 立即打一份快照
```

`restore` 总是先把当前文件保留为 `<文件>.pre-restore-<时间>`，并拒绝任何自身校验不通过的快照。用 `--at <epoch>`（在 `list` 中显示）可恢复指定快照而非最新的。

## 配置

```yaml
- id: session-snapshot
  name: dsh-session-snapshot
  config:
    keep: 5            # 每个会话保留的快照数，超出时淘汰最旧的
    minIntervalMs: 0   # 同一会话两次快照的最小间隔毫秒（0 = 每个有变化的回合都打）
    # home: /custom    # 默认 $DSH_HOME（~/.dsh）
```

快照存放在 `$DSH_HOME/session-snapshots/<会话id>/`，且只在日志**增长且仍校验通过**时才打——未变化或已损坏的会话既不浪费 I/O 也不会覆盖好副本。

## 成本与诚实边界

- 每次快照 = 一次文件复制 + 一次日志校验扫描。回合间隔是秒到分钟级，实际很轻量；超大会话可调高 `minIntervalMs` 进一步限流。
- 快照是**仅会话日志**的时间点副本，不包含工作区文件。要对话+文件一起回退是另一类工具。
- 支持会话格式 **version 0**（当前 dsh developer preview），`.jsonl` 与 `.jsonl.zstd`，JSONL 后端。压缩按内容嗅探，重命名/备份副本也能正确校验。dsh 处于 pre-1.0、无格式兼容承诺；遇到未知版本明确拒绝而非乱猜。

零运行时依赖（zstd 用 Node 内置 zlib）。MIT。
