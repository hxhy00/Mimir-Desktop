/**
 * 实验管理的类型定义与纯工具函数。
 *
 * 数据模型对齐 Mimir 的 `ExperimentRecord`（去掉 projectId，Mimir-Desktop
 * 无项目概念，采用扁平列表）；指标对比图工具函数移植自 Mimir 的
 * `view-common.ts`（`numericMetricKeys` / `metricChartRows` /
 * `barWidthPercents` / `chartNameLines` / `formatMetricValue`），保持行为一致。
 */

export type ExperimentStatus = 'running' | 'success' | 'failed'

/** 一条实验记录。 */
export interface ExperimentRecord {
  readonly id: string
  readonly name: string
  readonly status: ExperimentStatus
  /** 标量指标，按名称索引（accuracy、loss、wall-clock minutes…）。 */
  readonly metrics: Record<string, number | string>
  /** 关联的服务器 id（来自 Servers 模块），未关联时缺省。 */
  readonly serverId?: string | undefined
  /** ISO-8601 时间戳，最近一次写入时间。 */
  readonly updatedAt: string
}

/** 新建/编辑实验的输入。 */
export interface ExperimentInput {
  readonly id?: string | undefined
  readonly name: string
  readonly status: ExperimentStatus
  readonly metrics: Record<string, number | string>
  readonly serverId?: string | undefined
}

/** 指标对比图中一行：一次运行携带的该指标数值。 */
export interface MetricChartRow {
  readonly id: string
  readonly name: string
  readonly status: ExperimentStatus
  readonly value: number
}

/** 表单中一行指标草稿（key/value 均为字符串输入）。 */
export interface MetricRow {
  key: string
  value: string
}

/** 状态展示配置（标签 + 圆点颜色 + 文字颜色）。 */
export const STATUS_STYLE: Record<ExperimentStatus, { label: string; color: string; textColor: string }> = {
  running: { label: '训练中', color: 'bg-blue-500', textColor: 'text-blue-600 dark:text-blue-400' },
  success: { label: '已完成', color: 'bg-success', textColor: 'text-success' },
  failed: { label: '失败', color: 'bg-destructive', textColor: 'text-destructive' }
}

/** 状态选项，按生命周期顺序。 */
export const STATUSES: readonly ExperimentStatus[] = ['running', 'success', 'failed']

/** 从记录指标构造表单行；值统一转成字符串输入。 */
export function metricRowsFromMetrics(metrics: Record<string, number | string>): MetricRow[] {
  return Object.entries(metrics).map(([key, value]) => ({ key, value: String(value) }))
}

/**
 * 从表单行构造指标对象：key 去空，value 能完整解析为数字的存为数字，
 * 否则保留字符串。
 */
export function metricsFromRows(rows: readonly MetricRow[]): Record<string, number | string> {
  const metrics: Record<string, number | string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    const value = row.value.trim()
    if (value === '') continue
    metrics[key] = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) ? Number(value) : value
  }
  return metrics
}

/** 被至少两个实验共享的数值型指标键，按字母序。 */
export function numericMetricKeys(experiments: readonly ExperimentRecord[]): string[] {
  const counts = new Map<string, number>()
  for (const record of experiments) {
    for (const [key, value] of Object.entries(record.metrics)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([key]) => key)
    .sort()
}

/** 一个指标对比图的行：每个携带有限数值的运行一行，按 updatedAt 升序（最旧在上）。 */
export function metricChartRows(experiments: readonly ExperimentRecord[], key: string): MetricChartRow[] {
  const rows: Array<{ readonly record: ExperimentRecord; readonly value: number }> = []
  for (const record of experiments) {
    const value = record.metrics[key]
    if (typeof value === 'number' && Number.isFinite(value)) rows.push({ record, value })
  }
  rows.sort((left, right) => left.record.updatedAt.localeCompare(right.record.updatedAt))
  return rows.map(({ record, value }) => ({
    id: record.id,
    name: record.name,
    status: record.status,
    value
  }))
}

/** 条形宽度（0–100），归一化到最大值；全非正（如全 0）时塌缩为 0 宽。 */
export function barWidthPercents(values: readonly number[]): number[] {
  const max = Math.max(...values, 0)
  if (max <= 0) return values.map(() => 0)
  return values.map((value) => Math.max(0, Math.min(100, (value / max) * 100)))
}

/** 图表标签单行视觉宽度预算（半角单位，CJK/全角按 2 计）。 */
const CHART_LABEL_LINE_UNITS = 22

/** 一个码点的半角宽度：CJK/全角字形计 2。 */
function charUnits(char: string): number {
  return /[⺀-鿿豈-﫿＀-￯]/.test(char) ? 2 : 1
}

/**
 * 运行名折行到至多两行，避免条形图标签被过早省略。第一行贪心填充并在
 * 预算内的最后一个冒号或空格处断行；仍过长的名字第二行省略号（完整名
 * 挂在 SVG `<title>` 上）。
 */
export function chartNameLines(name: string): readonly [string] | readonly [string, string] {
  const chars = [...name]
  const unitsOf = (list: readonly string[]): number => list.reduce((sum, char) => sum + charUnits(char), 0)
  if (unitsOf(chars) <= CHART_LABEL_LINE_UNITS) return [name]
  let units = 0
  let cut = 0
  let boundary = -1
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? ''
    const next = units + charUnits(char)
    if (next > CHART_LABEL_LINE_UNITS) break
    units = next
    cut = index + 1
    if (char === '：' || char === ':' || char === ' ') boundary = index + 1
  }
  const first = (boundary > 0 ? chars.slice(0, boundary) : chars.slice(0, cut)).join('').trimEnd()
  const restText = chars.slice(boundary > 0 ? boundary : cut).join('').trimEnd()
  let tail = [...restText]
  while (tail.length > 0 && unitsOf(tail) + 1 > CHART_LABEL_LINE_UNITS) tail = tail.slice(0, -1)
  const trimmed = tail.join('').trimEnd()
  return [first, trimmed === restText ? restText : `${trimmed}…`]
}

/** 指标值的紧凑展示：字符串原样，整数直出，浮点保留 4 位有效数字。 */
export function formatMetricValue(value: number | string): string {
  if (typeof value === 'string') return value
  if (!Number.isFinite(value) || Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(4)))
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期。 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
