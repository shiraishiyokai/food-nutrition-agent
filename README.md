# 食聊 Food Nutrition Agent 🍱

**对话即主入口**的 AI 饮食营养助手：发一张餐照，模型调用工具识别菜品 → 本地营养库算出数值 → 可编辑卡片确认入库；「今天吃了多少」「晚饭吃点啥」这类问题全部在对话里完成。

> 在线版：`https://shiraishiyokai.github.io/food-nutrition-agent/`（GitHub Pages，BYOK 自带 Key）
> 上位规格：[Food-Nutrition-Agent-Spec.md](Food-Nutrition-Agent-Spec.md)（产品+AI 规格、决策记录 D1–D18）

## 功能一览

- **📸 拍照识别**：APP 拍照/相册，web 文件选择 / 拖拽 / Ctrl+V 粘贴；识别结果为可编辑卡片（点改克数、对话一句话修正如「米饭只有一半」，数值实时重算）
- **💬 对话查询**：6 个 function calling 工具（今日/本周查询、查菜、识别、档案更新、餐食推荐），模型自主决定调用，执行全在本地
- **🎲 餐食推荐**：问「晚饭吃点啥」→ 按剩余热量额度组合一套荤素搭配（默认有菜有汤，支持不吃荤/不吃碳水/两个素菜等约束）；卡片可「再次随机」，点「记录这餐」才入库
- **📇 饮食档案**：身高/体重/性别/年龄 → BMI（中国标准）；增肌/减脂/维持模板按 Mifflin-St Jeor 公式自动填推荐热量；支持对话改档案（「今天体重 63kg」）
- **📒 记录页**：按日分组、每日营养合计；**备份与迁移**：一键导出/导入全部数据（Key 默认脱敏）
- **📱 双形态**：web（GitHub Pages 静态托管）+ Android APK（Capacitor，拍照/相册、SQLite 存储）

## 架构：两段式 —— 模型只识别，算数归代码

```
餐照 ──► 云端 VLM（智谱 GLM-4V-Flash / 阿里 qwen-vl，BYOK）──► 菜名+分量+置信度（不含任何营养数值）
                                                              │
「米饭只有一半」──► 本地修正引擎（规则层正则 → LLM 语义层）──► │
                                                              ▼
                                          本地营养库查表 × 克数 ──► computeMeal 现算数值
```

为什么这样设计：独立评测显示 VLM 直接估营养误差最好也有 ~24%、多数 >40%，是结构性误差。把「这是什么菜」（模型强项）与「到底多少卡」（数据质量）拆开后，数值可审计、可溯源、跨会话一致。营养数值**永不**由模型输出，也**永不**缓存（库会随校准更新）。

对话链路采用 OpenAI 兼容 function calling：模型只决定「调什么工具、传什么参数」，所有数据计算（聚合、查库、预算配平）在本地执行——模型没有机会编造数字。

## 数值可信度：来源分级，条条可溯源

营养库共 **1047 道**（精选核定 108 + 全量质检 939 + 配方派生 43 + 原料 78），查找按可信度排序：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 个人校准 | 「这菜其实 350 卡」→ 永久生效 |
| 2 | 薄荷 API 按需补库 | 本地未命中 → 官方接口查一次 → 永久缓存 |
| 3 | 精选直录 108 道 | 薄荷食物库实拉值，人工核定，带 source_url |
| 4 | 全量直录 939 道 | 批量枚举采集 + 自动质检（能量自洽等规则），UI 标「批量参考值」 |
| 5 | 配方派生 43 道 | 原料×克数 现算（USDA SR Legacy 公有领域数据） |
| 6 | 类目均值兜底 | 未命中时按九类均值估算，UI 显著标注 |

全部数值仅作饮食参考，不构成医疗建议。数据来源与采集授权说明见 [app/README.md](app/README.md#数据来源与授权说明)。

## 快速开始（BYOK：自带 API Key）

```bash
cd app && npm install && npm run dev   # → http://localhost:5173
```

1. ⚙ 设置页选供应商并填 Key（默认**模拟模式**不联网，可先体验全流程）
   - **智谱**（首选）：[open.bigmodel.cn](https://open.bigmodel.cn) → 控制台 → API Key（GLM-4V-Flash 免费档）
   - **阿里云百炼**（备选）：[bailian.console.aliyun.com](https://bailian.console.aliyun.com)
   - 薄荷科学（可选，补库用）：[ai.boohee.com](https://ai.boohee.com) 免费档
2. 发一张餐照走识别；或在对话里问「今天吃了多少」「推荐个晚餐」

Key 与全部数据只存本机（浏览器 localStorage / APP SQLite），无服务器、无上传。APK 构建见 [app/README.md](app/README.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [Food-Nutrition-Agent-Spec.md](Food-Nutrition-Agent-Spec.md) | 产品与 AI 规格、决策记录 D1–D18、里程碑 |
| [AGENTS.md](AGENTS.md) | AI Agent 接手入口：模块职责、开发规则、验证方式 |
| [docs/architecture.md](docs/architecture.md) | 实际代码架构 |
| [docs/decisions.md](docs/decisions.md) | 实现级技术决策与理由 |
| [docs/known-issues.md](docs/known-issues.md) | 已知问题与历史 Bug |
