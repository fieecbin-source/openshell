## 变更描述 (Description)

请清晰地描述本次 Pull Request 所做的修改内容、动机以及解决的问题。

- 关联 Issue (Fixes / Closes): #

## 变更类型 (Type of Change)

- [ ] 🐛 Bug 修复 (Bug fix)
- [ ] ✨ 新特性 (New feature)
- [ ] 🎨 代码格式 / UI 调整 (Code style / UI revamp)
- [ ] ⚡ 性能优化 (Performance improvement)
- [ ] ♻️ 代码重构 (Refactoring without changing external behavior)
- [ ] 📝 文档更新 (Documentation update)
- [ ] 🧪 补充测试 (Tests)
- [ ] 📦 构建/CI 流水线变更 (Build / CI)

## 验证与自测清单 (Checklist)

在提交前，请勾选确认已在本地完成以下验证：

- [ ] 本地执行 `cargo check --workspace` 无错误
- [ ] 本地执行 `cargo test --workspace` 测试全部通过
- [ ] 本地执行 `npm test --prefix frontend` 前端单元测试全部通过
- [ ] 本地执行 `npm run --prefix frontend build` 前端构建无 TypeScript 错误
- [ ] 严格遵循零知识加密原则（未引入明文凭据打印、明文传输或第三方埋点）
- [ ] Git Commit 消息遵循约定式提交规范 (Conventional Commits)

