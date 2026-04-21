# 更新日志

[English](./CHANGELOG.md) | 中文

## [Unreleased]

- fix(ci): release finalize PR 创建前先格式化归档后的 changelog 文件。

## 0.2.1 (2026-04-21)

- fix(runtime): 将 ngx-lowcode core-types peer 范围对齐到 0.2 runtime 包版本线。

## 0.2.0 (2026-04-21)

- chore(ci): 补齐 PR changelog、格式化、单测、构建门禁，以及 main release draft 与发版后 changelog 归档。
- feat(runtime): Socket.IO runtime page topic 重连后自动重订阅，并支持携带 replay cursor。
- feat(runtime): 新增用于 BFF runtime page 订阅的 Socket.IO WebSocket manager。
