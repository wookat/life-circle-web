// 工程自证页的静态已核验数据：数字与 docs/COMPARISON_TEST.md、README、CI 实测保持一致。
// 变更门槛：改这里必须先改对应证据源（实测报告/门禁脚本），不写无凭据的数。

export const REPO = 'https://github.com/wookat/life-circle-web';
export const blob = (path: string) => `${REPO}/blob/main/${path}`;

/** 真实 AK 跑批记录（服务端通道 · 企业配额 AK），口径同 docs/COMPARISON_TEST.md §3.1 */
export const BATCH_ROWS: {
  batch: string; site: string; persona: string; grade: string;
  opportunity: string; mae: string; note: string;
}[] = [
  { batch: '2026-10-11', site: '样例 A · 师大数字产业学院（新校区）', persona: '成人', grade: '26 / E', opportunity: '4 处 / 2 类', mae: '5.73 分钟（31.6%）', note: '住宅 POI 缺失，覆盖率如实判无法评估' },
  { batch: '2026-10-11', site: '样例 A · 师大数字产业学院（新校区）', persona: '老年人', grade: '26 / E', opportunity: '2 处 / 1 类', mae: '9.30 分钟（31.4%）', note: '可达圈显著收缩' },
  { batch: '2026-10-11', site: '样例 B · 信州区中心广场（老城）', persona: '成人', grade: '76 / B', opportunity: '43 处 / 8 类', mae: '3.89 分钟（23.7%）', note: 'WorldPop 回退口径实测 51% 人口覆盖' },
  { batch: '2026-10-11', site: '样例 B · 信州区中心广场（老城）', persona: '老年人', grade: '76 / B', opportunity: '15 处 / 7 类', mae: '8.56 分钟（21.8%）', note: '同点人群差异直接可见' },
];

/** 工程门禁：与本仓库 CI（.github/workflows/ci.yml）同一批命令 */
export const GATES: { name: string; result: string; reproduce: string }[] = [
  { name: 'TypeScript 类型检查', result: '零告警', reproduce: 'npx tsc -p tsconfig.web.json --noEmit' },
  { name: '单元测试 vitest', result: '175 用例全过', reproduce: 'npm test' },
  { name: '端到端 playwright', result: '31 用例全过', reproduce: 'npx playwright test' },
  { name: '生产构建 vite build', result: '通过', reproduce: 'npm run build' },
  { name: 'Docker 构建 + 起服', result: '实测 HTTP 200 · 演示模式自动在线', reproduce: 'docker compose up --build' },
];

/** 交付物清单（链接到仓库内可核文件） */
export const DELIVERABLES: { name: string; path: string }[] = [
  { name: '开源许可证 MIT', path: 'LICENSE' },
  { name: '一键部署 Dockerfile', path: 'Dockerfile' },
  { name: 'docker-compose 编排', path: 'docker-compose.yml' },
  { name: 'README（配置脱敏说明）', path: 'README.md' },
  { name: '技术设计文档', path: 'docs/TECH_DESIGN.md' },
  { name: '真实对比测试报告', path: 'docs/COMPARISON_TEST.md' },
  { name: '答辩演示脚本', path: 'docs/DEMO_SCRIPT.md' },
];

/** 评审细则 → 本项目实现 → 证据位置 */
export const MAPPING_ROWS: { rule: string; impl: string; evidence: { label: string; href: string } }[] = [
  {
    rule: '批量距离矩阵 / 并发策略',
    impl: 'routematrix v2 批量算路，48 向扇形采样 + 时间场自适应加密；整批一次接口调用，显著低于逐点请求',
    evidence: { label: 'shared/isochrone.ts · docs/TECH_DESIGN.md', href: blob('docs/TECH_DESIGN.md') },
  },
  {
    rule: '容错与降级机制',
    impl: '服务端代理 → 浏览器直连 → 确定性合成数据，三级通道独立熔断；POI 缺失/配额异常如实标注，不硬编结果',
    evidence: { label: 'src/api.ts · server/src/provider.ts', href: blob('server/src/provider.ts') },
  },
  {
    rule: '创新的空间插值',
    impl: '时间场插值推导近似连通区，并用抽样真实算路自证精度（报告页展示 MAE 与最差偏差）',
    evidence: { label: 'shared/timefield.ts', href: blob('shared/timefield.ts') },
  },
  {
    rule: '多源 POI 数据清洗',
    impl: '类别完整性标注（取完/截断/失败/未执行）+ 行政边界筛选 + 人工补录通道；缺失如实进评分，不作假',
    evidence: { label: 'shared/poiSearch.ts · src/boundary.ts', href: blob('shared/poiSearch.ts') },
  },
  {
    rule: '盲区识别算法',
    impl: '网格化灰区 + 居住权重（住宅 POI 口径）→ 人口口径不可用时回退 WorldPop 100m 栅格，两口径不混用',
    evidence: { label: 'shared/gap.ts · shared/worldpop.ts', href: blob('shared/worldpop.ts') },
  },
];
