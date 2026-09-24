import { z } from 'zod'

// 两段式架构第一段（spec 5.2）：VLM 只输出识别信息，营养数值一律由本地营养库查表计算，
// 模型输出中不含也不应含任何热量/营养素字段。
// category 用于未命中营养库时的类目兜底估算（D8），必须与营养库类别体系一致。
export const DISH_CATEGORIES = ['家常菜', '蔬菜', '凉菜', '汤', '蛋白类', '主食', '外食', '饮品', '水果'] as const

export const RecognitionItemSchema = z.object({
  name: z.string().min(1),
  category: z.enum(DISH_CATEGORIES).catch('家常菜'),
  portion_desc: z.string().catch(''),
  portion_g: z.coerce.number().nonnegative().nullable().catch(null),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
  /** 用户经一句话修正确认过的条目（本地修正引擎写入，VLM 不输出） */
  confirmed: z.boolean().optional(),
})

export const MealRecognitionSchema = z.object({
  meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).catch('snack'),
  items: z.array(RecognitionItemSchema).min(1),
  notes: z.array(z.string()).catch([]),
})

export type RecognitionItem = z.infer<typeof RecognitionItemSchema>
export type MealRecognition = z.infer<typeof MealRecognitionSchema>
