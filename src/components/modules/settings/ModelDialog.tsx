/**
 * 「添加 / 编辑模型」弹窗。
 *
 * 这是一个**受控组件**：表单状态（`form`）、模型发现结果（`modelList`）、
 * 选择器交互状态（`modelPickerOpen` / `modelQuery` / `modelHighlight`）等
 * 全部仍由 `Settings.tsx` 持有——因为它们同时被主组件的自动发现副作用、
 * 引导流程（`guided`）等逻辑读写，下沉会引入双向耦合。
 *
 * 本组件只负责渲染这一块表单 JSX，把原先内联在 Settings.tsx 中的约 300 行
 * 视图代码独立出来，让主组件聚焦于布局与 Tab 路由。
 */
import { type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Check, ChevronDown, Eye, EyeOff, Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 模型表单字段（与 Settings 内部 ModelConfig 对齐）。 */
export interface ModelFormState {
  baseUrl: string
  apiKey: string
  modelId: string
  supportsImages: boolean
  supportsReasoning: boolean
}

/** 模型发现候选项（含「已在列表中」标记，用于下拉禁用）。 */
export interface ModelCandidate {
  id: string
  ownedBy?: string
  alreadyExists: boolean
}

export interface ModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 非 null 表示编辑已有模型，否则为新增。 */
  editingModelId: string | null
  form: ModelFormState
  setForm: (next: ModelFormState) => void
  showApiKeyInForm: boolean
  setShowApiKeyInForm: (v: boolean) => void
  testing: boolean
  testResult: { ok: boolean; message: string } | null
  /** 模型发现状态。 */
  listingModels: boolean
  modelList: { id: string; ownedBy?: string }[]
  modelListEndpoint: string
  modelListMsg: { type: 'ok' | 'error'; text: string } | null
  /** 下拉选择器交互状态。 */
  modelPickerOpen: boolean
  setModelPickerOpen: (v: boolean) => void
  modelQuery: string
  setModelQuery: (v: string) => void
  modelHighlight: number
  setModelHighlight: (updater: (h: number) => number) => void
  /** 经过「已存在」标记与查询过滤后的候选列表。 */
  filteredModelCandidates: ModelCandidate[]
  comboboxRef: RefObject<HTMLDivElement>
  /** 手动触发模型发现（`silent` 表示静默发现，不弹错误）。 */
  onFetchModels: (opts?: { silent?: boolean }) => void | Promise<void>
  /** 选中某个候选模型 ID。 */
  onPickModel: (id: string) => void
  onSave: () => void
  onCancel: () => void
}

export function ModelDialog({
  open,
  onOpenChange,
  editingModelId,
  form,
  setForm,
  showApiKeyInForm,
  setShowApiKeyInForm,
  testing,
  testResult,
  listingModels,
  modelList,
  modelListEndpoint,
  modelListMsg,
  modelPickerOpen,
  setModelPickerOpen,
  modelQuery,
  setModelQuery,
  modelHighlight,
  setModelHighlight,
  filteredModelCandidates,
  comboboxRef,
  onFetchModels,
  onPickModel,
  onSave,
  onCancel
}: ModelDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editingModelId !== null ? '编辑模型' : '添加模型'}</DialogTitle>
          <DialogDescription>
            填写 LLM 模型的连接信息和配置。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          {/* 填写动线：地址 → API密钥 → 模型（按从上到下顺序填充，填完地址+Key 自动发现模型） */}
          <div className="space-y-1">
            <Label className="text-[11px]">请求地址 *</Label>
            <Input
              placeholder="https://api.deepseek.com/v1"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              className="h-7 text-[12px] font-mono"
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <Label className="text-[11px]">API密钥 *</Label>
            <div className="relative">
              <Input
                type={showApiKeyInForm ? 'text' : 'password'}
                placeholder="sk-..."
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                className="h-7 text-[12px] font-mono pr-7"
              />
              <button
                type="button"
                onClick={() => setShowApiKeyInForm(!showApiKeyInForm)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showApiKeyInForm ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            </div>
          </div>

          {/* 模型：可搜索下拉（来自 /v1/models 发现结果）+ 可自由输入自定义 ID */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[11px]">模型 *</Label>
              {listingModels && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  正在发现模型…
                </span>
              )}
            </div>
            <div className="relative" ref={comboboxRef}>
              <Input
                role="combobox"
                aria-expanded={modelPickerOpen}
                aria-controls="model-combobox-list"
                placeholder={
                  listingModels
                    ? '正在发现可用模型…'
                    : modelList.length > 0
                      ? `已发现 ${modelList.length} 个模型，点击选择或直接输入`
                      : '直接输入模型 ID（填完地址与密钥后自动发现）'
                }
                value={form.modelId}
                onChange={(e) => {
                  setForm({ ...form, modelId: e.target.value })
                  // 打字即进入「搜索/自定义」态：展开下拉并用输入内容过滤候选。
                  setModelQuery(e.target.value)
                  setModelPickerOpen(true)
                  setModelHighlight(() => -1)
                }}
                onFocus={() => {
                  if (modelList.length > 0) {
                    setModelQuery('')
                    setModelPickerOpen(true)
                  }
                }}
                onKeyDown={(e) => {
                  const filtered = modelList.filter(
                    (m) => modelQuery.trim() === '' || m.id.toLowerCase().includes(modelQuery.trim().toLowerCase())
                  )
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    if (!modelPickerOpen && modelList.length > 0) {
                      setModelPickerOpen(true)
                      return
                    }
                    setModelHighlight((h) => Math.min(h + 1, filtered.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setModelHighlight((h) => Math.max(h - 1, -1))
                  } else if (e.key === 'Enter') {
                    if (modelPickerOpen && modelHighlight >= 0 && filtered[modelHighlight]) {
                      e.preventDefault()
                      onPickModel(filtered[modelHighlight].id)
                    }
                  } else if (e.key === 'Escape') {
                    setModelPickerOpen(false)
                  }
                }}
                className="h-7 pr-7 text-[12px] font-mono"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => {
                  if (modelPickerOpen) {
                    setModelPickerOpen(false)
                  } else {
                    setModelQuery('')
                    setModelPickerOpen(true)
                    if (modelList.length === 0 && form.baseUrl && form.apiKey) {
                      void onFetchModels({ silent: true })
                    }
                  }
                }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                title="展开可用模型列表"
              >
                <ChevronDown className={cn('h-3 w-3 transition-transform', modelPickerOpen && 'rotate-180')} />
              </button>

              {modelPickerOpen && (
                <div
                  id="model-combobox-list"
                  role="listbox"
                  className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-md"
                >
                  <div className="max-h-44 overflow-y-auto py-0.5">
                    {filteredModelCandidates.map((m, i) => (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={m.id === form.modelId}
                        onMouseEnter={() => setModelHighlight(() => i)}
                        onClick={() => {
                          if (!m.alreadyExists) onPickModel(m.id)
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors',
                          m.alreadyExists
                            ? 'cursor-not-allowed text-muted-foreground/60'
                            : i === modelHighlight
                              ? 'bg-accent'
                              : 'hover:bg-accent/60'
                        )}
                      >
                        <Check
                          className={cn(
                            'h-3 w-3 shrink-0',
                            m.id === form.modelId ? 'text-primary opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className="truncate font-mono">{m.id}</span>
                        {m.ownedBy !== undefined && (
                          <span className="shrink-0 text-[9px] text-muted-foreground">{m.ownedBy}</span>
                        )}
                        {m.alreadyExists && (
                          <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">已添加</span>
                        )}
                      </button>
                    ))}
                    {filteredModelCandidates.length === 0 && (
                      <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                        {listingModels
                          ? '正在发现模型…'
                          : modelList.length === 0
                            ? '尚未发现模型。填好请求地址与 API 密钥后会自动发现；也可直接输入模型 ID。'
                            : `没有匹配「${modelQuery}」的模型，回车可直接使用该 ID。`}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-border px-2.5 py-1.5">
                    <span className="truncate text-[9px] text-muted-foreground" title={modelListMsg?.text}>
                      {modelListMsg?.text ?? (modelListEndpoint ? `来源：${modelListEndpoint}` : '')}
                    </span>
                    <button
                      type="button"
                      onClick={() => void onFetchModels()}
                      disabled={listingModels || !form.baseUrl || !form.apiKey}
                      className="shrink-0 text-[9px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {listingModels ? '发现中…' : '重新发现'}
                    </button>
                  </div>
                </div>
              )}
            </div>
            {modelListMsg?.type === 'error' && (
              <p className="text-[10px] text-destructive" title={modelListMsg.text}>
                {modelListMsg.text}（可手动输入模型 ID）
              </p>
            )}
          </div>

          {/* Row: 支持图片 + 支持推理（并排，均为模型能力声明） */}
          <div className="grid grid-cols-4 gap-2">
            <div className="col-span-3 space-y-1">
              <Label className="text-[11px]">支持图片</Label>
              <div className="flex gap-3 h-7 items-center">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="supportsImages"
                    checked={form.supportsImages === true}
                    onChange={() => setForm({ ...form, supportsImages: true })}
                    className="h-3 w-3 accent-primary"
                  />
                  <span className="text-[11px]">是</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="supportsImages"
                    checked={form.supportsImages === false}
                    onChange={() => setForm({ ...form, supportsImages: false })}
                    className="h-3 w-3 accent-primary"
                  />
                  <span className="text-[11px]">否</span>
                </label>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">支持推理</Label>
              <label className="flex h-7 cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded accent-primary"
                  checked={form.supportsReasoning === true}
                  onChange={(e) => setForm({ ...form, supportsReasoning: e.target.checked })}
                />
                <span className="text-[11px]">开启</span>
              </label>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            思考模式需模型与端点支持：官方 DeepSeek / OpenAI 可用；第三方中转代理可能不透传该参数。
          </p>

        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={onCancel}
            type="button"
            data-testid="model-dialog-cancel"
          >
            取消
          </Button>
          <Button
            size="sm"
            className="h-7"
            onClick={onSave}
            disabled={!form.baseUrl || !form.modelId || !form.apiKey || testing}
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : editingModelId !== null ? (
              <Check className="h-3.5 w-3.5 mr-1" />
            ) : (
              <Plus className="h-3.5 w-3.5 mr-1" />
            )}
            {testing ? '测试中...' : editingModelId !== null ? '测试并保存' : '测试并添加'}
          </Button>
        </DialogFooter>
        {testResult !== null && (
          <div
            className={cn(
              'rounded-md border px-3 py-2 text-[11px] mt-1',
              testResult.ok
                ? 'border-green-500/30 bg-green-500/5 text-green-600'
                : 'border-destructive/30 bg-destructive/5 text-destructive'
            )}
          >
            {testResult.message}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
