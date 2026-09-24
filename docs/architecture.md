# architecture.md — 实际代码架构

> 只记录当前真实存在的代码（2026-09-24，M1 阶段）。spec 6.1 画了目标架构（Capacitor/SQLite/对话主界面），凡标注「未实现」的都还没写，勿当作现状。

## 1. 系统总览

纯前端单页应用，无后端、无数据库服务。营养数据以 JSON 形式打包进前端 bundle；运行时状态（设置、识别缓存、薄荷补库缓存）存 localStorage。外部依赖只有两类 HTTP 服务：LLM 供应商（智谱/百炼，OpenAI 兼容端点）和薄荷科学官方 API。

```
浏览器（localhost:5173, Vite dev）
├── ui/RecognizePage.tsx        唯一页面：设置 + 上传 + 识别 + 修正 + 补库编排
│   ├── ai/vlm.ts ──────────► /ai/zhipu|/ai/dashscope ──Vite代理──► 智谱/百炼 chat/completions
│   ├── ai/chat.ts ──────────► 同上（修正语义解析，复用同 Key）
│   ├── lib/nutrition_db.ts     本地查表计算（无网络）
│   └── lib/boohee_api.ts ───► /boohee ──Vite代理──► api.boohee.com（X-Api-Key）
└── localStorage                settings v2 / 识别缓存 24h / 薄荷缓存+负缓存+预算
```

## 2. 模块依赖关系

```
main.tsx → App.tsx → ui/RecognizePage.tsx
RecognizePage 依赖：ai/vlm, ai/providers(类型), ai/schema(类型), lib/{image,cache,settings,nutrition_db,correction,boohee_api}, ui/ResultCard
ai/vlm      → ai/providers(getChatUrl), ai/prompt, ai/schema
ai/chat     → ai/providers, lib/correction(OpSchema——协议定义反向放在 lib)
lib/correction → ai/schema(DISH_CATEGORIES/类型), lib/nutrition_db(lookupDish,upsertCalibration)
lib/nutrition_db → src/data/{ingredients,dishes,dishes-reference}.json（import 打包）
lib/boohee_api  → lib/settings(取薄荷 Key), lib/nutrition_db(仅类型 DishNutrition)
ui/ResultCard   → lib/nutrition_db(getIngredient 及类型)
```

无全局状态库、无路由、无 Context：全部状态是 `RecognizePage` 的 `useState`，跨模块共享数据靠模块级单例（nutrition_db 的 Map、settings 的 localStorage）。

## 3. 识别主流程（端到端）

1. **输入**：点击/拖拽/粘贴 → `lib/image.ts compressImage(file)`：Canvas 缩到长边 ≤1024、JPEG q0.8，`createImageBitmap({imageOrientation:'from-image'})` 按 EXIF 摆正，失败回退 `<img>`。
2. **缓存**：`lib/cache.ts`——key = `sha256(dataUrl) 前32位 + "${presetId}/${model}@${baseUrl}"`，命中 24h 内直接返回（UI 标「24h 缓存命中」）。只缓存识别结果，营养数值永不缓存。
3. **识别**（`ai/vlm.ts recognizeMeal`）：构造单条 user 消息（`RECOGNITION_INSTRUCTIONS + USER_PROMPT` 文本 + image_url；**指令不放 system role**，规避视觉模型支持差异）→ `temperature 0.2` POST `{baseUrl}/chat/completions` → 从回复截取首个 `{` 到末个 `}` → `MealRecognitionSchema.parse`（zod，全字段 `.catch()` 宽容默认）→ 失败则把原回复+校验错误追加进对话**重试 1 次**，再失败抛错（UI 提示稍后重试）。`presetId === 'mock'` 时返回固定 3 项结果，不联网。
4. **计算**（`lib/nutrition_db.ts computeMeal`）：对每个 item——`lookupDish(name)` 查库 → `portion_g ?? typical_portion_g` → 数值 = 每百克值 × 克数 ÷ 100，四舍五入。未命中且有 category：按类目均值兜底（`estimate` 标记 basisCount）；再不行数值为 null 进 `unmatchedNames`。totals 只对有数值的条目求和。
5. **展示**（`ui/ResultCard.tsx`）：表格每行带徽章——置信度（<0.6 标「需确认」）、匹配类型（精确/别名/模糊）、数值来源 origin（个人校准/我的配方/直录参考值含 source_url 链接/类目估算/待校准）、配方构成行（原料×克数）。底部汇总 + 类目估算说明 + 「—」条目说明（明示不会用模型估算）。
6. **按需补库**（RecognizePage useEffect，依赖 `result`）：对 `computeMeal` 结果中数值为 null 的菜逐个 `enrichLookup` → 命中则 `upsertApiDish` + `dbTick++` 触发重算；预算/网络错误只显示提示不打断。
7. **修正**：输入框回车 → `lib/correction.ts applyCorrectionText`（见 §6）→ `setResult` 重算；改名/补充的新菜名又会触发第 6 步补库。

## 4. nutrition_db.ts 内部（数值权威）

**四层查找**，`allDishes()` 的拼接顺序即优先级，`find` 先到先得：

```
userCalibrations（个人校准,Map）  ← correction.calibrate / upsertCalibration 写入
> apiCached（薄荷 API 永久缓存,Map）← 启动时从 localStorage fna.boohee.cache.v1 播种
> REFERENCE_DISHES（直录 108 道,dishes-reference.json,origin=reference,带 source_url）
> DEFAULT_DISHES（配方派生 43 道,dishes.json,运行时 derivePer100g 现算）
```

- `lookupDish` 匹配：normalize（去括号/空格/·、小写）后 精确名 > 别名 > 包含式模糊（`matchType: exact|alias|fuzzy`）；全落空返回 null。
- `derivePer100g`：Σ(原料每百克×克数) ÷ 配方总克数 × 100（水计入总重，正确稀释）；原料 id 未命中直接 throw。
- `CATEGORY_MEANS`：模块加载时对直录+派生全部菜按九类（家常菜/蔬菜/凉菜/汤/蛋白类/主食/外食/饮品/水果）求每百克均值；`categoryMean` 找不到该类时退回「家常菜」均值。
- 用户配方覆盖 `upsertRecipeOverride` 已有 API 但 UI/NL 解析尚未接入（M3）。

## 5. boohee_api.ts（唯一的外部 Tool）

`enrichLookup(name)` 流程：无效名/含「未知」直接 null → 查永久缓存（按名字或 `_query`）→ 查当日负缓存 `fna.boohee.miss.v1` → 预算检查（`fna.boohee.budget.v1`，软上限 45/官方 50/天，每日重置）→ `GET /boohee/open-apis/v1/food/search?keyword=&per_page=20&with_units=true`（header `X-Api-Key`）→ 计费 1 次 → `pickBestFood` 挑候选（过滤品牌货：名字含空格或长度超目标+3；精确 > 包含 > 名字长度最接近；卡路里 3–900 之外丢弃）→ 未挑中写负缓存；挑中写永久缓存并返回。
`toDishNutrition`：转成 `origin:'reference'` 条目，`id=booheeapi-{code}`，份量预设取 units 中 5–800g 的项，typical 取 ≤600g 的最大者否则 150，category 固定「家常菜」，source_url 固定 `https://ai.boohee.com`。401/403/429 各有明确报错文案，不自动重试。

## 6. correction.ts（一句话修正引擎）

按 `；; \n` 拆多句逐句执行。每句先走**规则层**（`applyOne` 正则，零模型调用）：删除（删掉/去掉/不要了）→ 热量校准（「X其实N卡」→ 按当前分量折算每百克写入 `upsertCalibration`，永久生效）→ 改名（不是A是B / A改成B / A其实是B；「改成 N克」自动转改分量）→ 克数 → 一半/两倍（优先查库内 portion_presets，如「半碗」）→ 补充（再加/添加，分量取库内典型值）。解析失败返回 `⚠ 没看懂…` 并附用法示例——**不猜**。
规则层没动条目且配置了 LLM 回调时，走**语义层**：`ai/chat.ts parseCorrection`（system prompt 给协议，temperature 0.1，20s 超时）→ 返回 `{ops:[{op:rename|portion|delete|add|calibrate,…}], reply}` → `OpsSchema` 校验 → 与规则层共用 `applyOps` 执行。原则：语义理解交给模型，数值与执行永远留在本地。

## 7. 数据资产与工具链（app/scripts/）

运行时打包三个（`src/data/`）：
- `ingredients.json`（78 项原料，每百克四项值；source: usda-sr-legacy / cfct-common / none；ref 溯源 fdc_id）
- `dishes-reference.json`（108 道直录，薄荷实拉值 + source_url；49 精确 + 23 人工核定 + 36 变体）
- `dishes.json`（43 道配方草案：原料×克数，油糖单列）
仅被 scripts 引用的中间产物（也在 `src/data/`，勿与运行时资产混淆）：`boohee-raw.json`（采集原始结果）、`ingredients.usda.json`（USDA 匹配中间层）。

脚本链：`fetch-usda.mjs`/`fetch-usda-api.mjs`（USDA SR Legacy 匹配，原始数据在 `app/.usda/sr-legacy.zip`）→ `build-ingredients.mjs`（装配原料库）；`fetch-boohee.mjs` → `refine-boohee.mjs`/`retry-boohee.mjs`/`gen-manual-map.mjs`/`gen-manual-checklist.mjs`（采集与人工核定）→ `build-dishes-reference.mjs`（装配直录库）；`verify-dishes.mjs`（派生 vs 直录交叉校验 → `notes/verify-report.txt`）。**`crawl-boohee-full.mjs` 已废弃**（枚举爬取触发 429 限流，且薄荷网页版已下线），保留仅作历史。

## 8. 前端到上游的调用关系（网络层）

| 相对地址（dev） | 代理目标 | 用途 | 鉴权 |
|---|---|---|---|
| `/ai/zhipu/api/paas/v4/chat/completions` | open.bigmodel.cn | 识别/修正（GLM 系列） | Bearer Key |
| `/ai/dashscope/compatible-mode/v1/chat/completions` | dashscope.aliyuncs.com | 同上（qwen-vl 系列） | Bearer Key |
| `/boohee/open-apis/v1/food/search` | api.boohee.com | 按需补库 | X-Api-Key |

代理只存在于 Vite dev server（`vite.config.ts`）；`vite build` 产物部署到静态托管时无代理可用，CORS 未适配——APK 阶段计划改 CapacitorHttp 原生请求（**未实现**）。供应商预设（`ai/providers.ts`）：mock / zhipu（默认 glm-4v-flash）/ dashscope（默认 qwen-vl-plus）/ custom，baseUrl/model/Key 均可用户改写，预设只填默认值。

## 9. 明确尚未实现（spec 有、代码无）

对话主界面与消息流、SQLite/Capacitor、meals 落库与每日汇总、档案（profile）与 system prompt 组装、档案自动抽取、低置信度对话式反问、TDEE、配料表解读、外卖比价、导出导入、APK 打包。M1 用户提供差异化的两个 Map（校准/配方覆盖）为**内存态，刷新即失**。
