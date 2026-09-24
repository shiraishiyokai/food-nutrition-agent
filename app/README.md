# 食聊（Food Nutrition Agent）— M1 识别试验台

对应规格文档：[../Food-Nutrition-Agent-Spec.md](../Food-Nutrition-Agent-Spec.md)（M1「能识别」阶段）

## 运行

```bash
npm install
npm run dev
# → http://localhost:5173
```

## 使用

1. 「设置」面板选择供应商并填 API Key（默认**模拟模式**无需 Key，可先联调界面流程）
2. 上传 / 拖拽 / Ctrl+V 粘贴一张餐食照片
3. 点击「开始识别」→ 查看识别 + 配方派生结果卡（配方构成显示在菜名下方）

获取 Key（二选一）：

- **智谱**（首选）：[open.bigmodel.cn](https://open.bigmodel.cn) 注册 → 控制台 → API Key；GLM-4V-Flash 免费档（政策以官网为准）
- **阿里云百炼**（备选）：[bailian.console.aliyun.com](https://bailian.console.aliyun.com) 开通模型服务 → API-KEY

## 架构：两段式 + 配方派生（2026-09-22，spec 5.2 / D5 / D7）

```
第一段 识别（云端 VLM）：菜名 + 分量 + 置信度（不含任何营养数值）
第二段 数值（本地计算）：菜品配方（原料×克数）× 原料库每百克值 → 代码计算
```

数据资产与溯源：

- `src/data/ingredients.json` — 原料级营养库 **78 项**：62 项自动实拉自 USDA SR Legacy（公有领域，`ref: fdc_id:xxx` 可溯源）、14 项《中国食物成分表》公开值（note 带「待核对」标记）、2 项零值（水/盐）
- `src/data/dishes.json` — 43 道常见菜**配方表**（草案）：菜品不存营养值，只存「原料 × 克数」；油糖单列（家常菜热量方差主要来自油糖）
- `src/data/dishes-reference.json` — **精选直录库 108 道**：薄荷食物库逐菜实拉参考值（品牌预包装已过滤），每条带 `source_url` 溯源；49 道精确匹配 + 23 道人工核定映射 + 36 道变体匹配
- `src/lib/boohee_api.ts` — **薄荷科学官方 API 按需补库（D9）**：本地未命中 → `food/search`（1 次调用含每百克值+份量）→ 永久缓存 localStorage，此后零调用；带每日预算（40/50）与当日未命中负缓存。设置页填 Key（[ai.boohee.com](https://ai.boohee.com) 免费档）。开发期经 Vite 代理 `/boohee` 绕 CORS，APK 后 CapacitorHttp 直连
- 溯源工具链：`fetch-usda.mjs`（USDA 匹配）→ `build-ingredients.mjs`（原料装配）；`fetch-boohee.mjs`/`refine-boohee.mjs`/`retry-boohee.mjs`（直录采集，`crawl-boohee-full.mjs` 枚举方案已因 429 限流+官方 API 开通而废弃）→ `build-dishes-reference.mjs`（装配）；`verify-dishes.mjs`（派生 vs 直录交叉校验，报告在 `../notes/verify-report.txt`）
- 查找优先级：个人校准 > **API 按需缓存** > 精选直录 > 配方派生 > **类目均值兜底**（未命中时按 VLM 输出的类别取均值估算并显著标注「类目估算」）
- 与直录值偏差 >25% 的派生菜 5 道已标记待复核（见 verify 报告）

用户差异化（双通道）：

1. **配方覆盖**（"放了两克油、两个蛋"）→ `upsertRecipeOverride` → 数值自动重算（NL 解析 M3 随对话落地，引擎已就绪）
2. **热量直接校准**（"这菜其实350大卡"）→ `upsertCalibration` → 优先于默认库值

## M1 验收：20 张餐照实测（双指标，spec 里程碑表）

1. 准备 20 张日常餐照（含混合菜品、不同光照/角度）
2. 逐张识别，按两个独立指标记录：
   - **菜名识别准确率**（目标 ≥ 80%）
   - **分量猜测合理性**（±30% 内为可接受）
3. 顺带记录：营养库命中率、模糊匹配误报率
4. 结果记回 spec 的「决策记录」章节

> 首轮 4 餐实测（2026-09-22）：命名 16/16、置信度校准正确、瓶颈为覆盖率 → 已通过 v2 数据模型补齐缺失的 9 道菜，待新一轮实测验证命中率提升。

## 实现说明

- dev 模式经 Vite 代理转发 API 请求（`vite.config.ts`，绕浏览器 CORS）；APK 阶段改走 CapacitorHttp 原生请求
- 图片在客户端压缩至长边 1024px / JPEG 质量 0.8 后上传（控制 Token）
- 相同图片 + 相同模型 24h 内命中**识别**缓存；**营养数值每次现算**（原料/配方可校准更新，不缓存）
- `?autotest=1` 参数触发内置自检（Mock 模式跑通「压缩→识别→配方派生→卡片」全流程）
- API Key 仅存本机 localStorage
- 目录：`src/ai`（识别层，UI 无关可单测）、`src/lib/nutrition_db.ts`（配方派生引擎）、`src/data`（原料库 + 配方表）、`scripts`（数据溯源工具链）、`src/ui`（界面）

## 已知边界（M1）

- 桌面浏览器为测试环境；手机拍照入库（Capacitor 相机 + SQLite）在 M2
- 低置信度条目目前仅高亮提示，对话式反问修正流在 M3
- 配方克数为家庭常规做法的草案估计，待按真实用餐校准；USDA 数值与中餐实际（如豆腐老嫩、米的水量）存在已知差异，卡片中已标注建议校准项
- USDA 鸡胸为熟重基准、鸡腿为带皮生重，配方中已按各自基准使用并加 note
