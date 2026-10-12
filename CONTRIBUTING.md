# 贡献指南

感谢关注「圈点——15 分钟生活圈智能体检与规划助手」！欢迎任何形式的贡献：Bug 报告、功能建议、文档改进与代码贡献。

## 快速开始

```bash
git clone https://github.com/nghqqa/life-circle-15min.git
cd life-circle-15min
npm install
npm run dev          # 无 AK 演示模式开箱即跑
npm test             # 30 项单元/场景测试
npm run typecheck    # 严格类型检查
```

无百度 AK 也可完整开发与调试（演示模式使用确定性合成数据）。

## 分支与提交

- `main` 为稳定分支，功能开发请从 main 拉出特性分支（`feat/xxx`、`fix/xxx`）；
- 提交信息使用约定式前缀：`feat:` / `fix:` / `docs:` / `refactor:` / `test:`；
- 每次推送会触发 CI（类型检查 + 测试 + 构建），请确保本地先行通过。

## 代码约定

- **同构引擎**：分析算法一律放在 `shared/`，通过 `AnalysisProvider` 接口注入数据获取，
  禁止在引擎内直接调用平台 API；
- **数据口径**：任何统计必须标注口径（周边检索 / 圈内可达 / 直线盲区），三者在
  `AnalysisReport.warnings` 与报告 UI 中如实区分；
- **数据缺失 ≠ 真实为 0**：上游检索失败时不得把结果当真实结论（参考 `computeScore`
  的 `failedCategories` 处理与「不缓存空结果」约定）；
- **上游韧性**：对百度 Web API 的调用必须经令牌桶限流、瞬态错误重试与缓存
  （参考 `server/src/provider.ts`）；
- 新算法行为请同步补充 `tests/` 下的单元或场景 eval 测试。

## 报告 Bug

请附：复现步骤、中心点坐标、运行日志页签内容、`X-Proxy-Cache` 与数据通道状态。

## 许可证

贡献代码将以 [MIT](LICENSE) 许可证发布。
