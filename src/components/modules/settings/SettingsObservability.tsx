import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Activity, Save, Check, ExternalLink, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 可观测性配置（设置 → Agent → 可观测性）。
 *
 * 埋点协议是 OpenTelemetry，Mimir 只认「OTLP 端点」这一个出参：本地 Langfuse
 * （默认，数据不出本机）、公司内网 Tempo、将来换其它后端都只是换个地址 + 换个 key。
 *
 * 字段（存 `settings.otel`，全部交给主进程 `electron/agent/otelTrace.ts` 消费）：
 * - `enabled`：总开关。**关闭时不初始化 SDK**，零开销、零网络请求（默认关闭）。
 * - `endpoint`：OTLP/HTTP traces 端点，如 `http://localhost:3000/api/public/otel`。
 * - `publicKey` / `secretKey`：Langfuse 的 API Key，主进程据此自动生成 Basic 认证头
 *   （不让用户手写 base64：易错且难排查）。
 * - `serviceName`：服务名，用于区分不同来源的数据。
 * - `environment`：环境标识，用于区分同一服务在不同环境的数据。
 * - `headers`：附加请求头（多行 `key: value`），仅供其它需要鉴权的自建后端使用。
 *
 * 端点留空时即使开关打开也不会启用 —— 避免在用户不知情的情况下把数据发去默认地址。
 */
export function SettingsObservabilityCard() {
  const [enabled, setEnabled] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [serviceName, setServiceName] = useState('mimir-desktop')
  const [environment, setEnvironment] = useState('development')
  const [headers, setHeaders] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI
      ?.getSettings?.()
      .then((settings) => {
        if (!alive) return
        const raw = (settings as Record<string, unknown>).otel
        if (typeof raw !== 'object' || raw === null) return
        const cfg = raw as Record<string, unknown>
        setEnabled(cfg.enabled === true)
        setEndpoint(typeof cfg.endpoint === 'string' ? cfg.endpoint : '')
        setPublicKey(typeof cfg.publicKey === 'string' ? cfg.publicKey : '')
        setSecretKey(typeof cfg.secretKey === 'string' ? cfg.secretKey : '')
        setServiceName(typeof cfg.serviceName === 'string' ? cfg.serviceName : 'mimir-desktop')
        setEnvironment(typeof cfg.environment === 'string' ? cfg.environment : 'development')
        setHeaders(typeof cfg.headers === 'string' ? cfg.headers : '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const settings = ((await window.electronAPI?.getSettings?.()) ?? {}) as Record<string, unknown>
      await window.electronAPI?.setSettings?.({
        ...settings,
        otel: {
          enabled,
          endpoint: endpoint.trim(),
          publicKey: publicKey.trim(),
          secretKey: secretKey.trim(),
          serviceName: serviceName.trim() || 'mimir-desktop',
          environment: environment.trim() || 'development',
          headers: headers.trim()
        }
      })
      setMsg({
        type: 'ok',
        text: enabled
          ? '已保存。重新初始化 Agent 后生效；随后打开 Langfuse（localhost:3000）查看链路。'
          : '已保存。可观测性已关闭，Mimir 不再上报任何链路数据。'
      })
    } catch (error) {
      setMsg({ type: 'error', text: `保存失败：${error instanceof Error ? error.message : '未知错误'}` })
    } finally {
      setSaving(false)
    }
  }

  const toggleRow = (on: boolean, onChange: (v: boolean) => void, label: string, hint: string) => (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-foreground/90">{label}</div>
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          on ? 'bg-primary' : 'bg-muted'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
            on ? 'left-[18px]' : 'left-0.5'
          )}
        />
      </button>
    </div>
  )

  return (
    <section id="settings-observability" className="scroll-mt-10 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">可观测性</h2>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Mimir 的 Agent 链路用 OpenTelemetry 标准协议上报：每次对话是一棵树，含每个模型的完整输入输出、
        每次工具调用的入参与返回、token 用量与耗时。上报目标由你指定 —— 填本机 Langfuse 地址则
        <span className="font-medium text-foreground">数据不出本机</span>；留空则不启用，Mimir 不产生任何外部请求。
      </p>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        {toggleRow(
          enabled,
          setEnabled,
          '启用链路上报（OpenTelemetry）',
          '关闭时不初始化 SDK：零开销、零网络请求。开启后需填下方端点才会真正上报。'
        )}
        <div className="border-t border-border/60" />

        <div className="space-y-1.5">
          <div className="text-[12px] font-medium text-foreground/90">OTLP 端点</div>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="http://localhost:3000/api/public/otel"
            className="h-8 text-[11px] font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            Langfuse 的端点<strong className="font-medium text-foreground/90">不带</strong>{' '}
            <code className="rounded bg-muted px-1 font-mono text-[10px]">/v1/traces</code> 后缀，也没有 gRPC 入口。
            本地 Langfuse 用仓库内 <code className="rounded bg-muted px-1 font-mono text-[10px]">docker/langfuse-compose.yml</code> 按需启动，
            界面与入口都在 <code className="rounded bg-muted px-1 font-mono text-[10px]">3000</code>。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <div className="text-[12px] font-medium text-foreground/90">Public Key</div>
            <Input
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder="pk-lf-mimir-local"
              className="h-8 text-[11px] font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <div className="text-[12px] font-medium text-foreground/90">Secret Key</div>
            <div className="relative">
              <Input
                type={showSecret ? 'text' : 'password'}
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="sk-lf-mimir-local"
                className="h-8 pr-8 text-[11px] font-mono"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                aria-label={showSecret ? '隐藏密钥' : '显示密钥'}
              >
                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>

        <p className="text-[10px] text-muted-foreground">
          由 Mimir 自动拼成 HTTP Basic 认证头，你不需要手写 base64。用仓库内 compose 启动的本地
          Langfuse，默认 key 即上方占位符（可在{' '}
          <code className="rounded bg-muted px-1 font-mono text-[10px]">docker/.env</code> 里改）。
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <div className="text-[12px] font-medium text-foreground/90">服务名</div>
            <Input
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              placeholder="mimir-desktop"
              className="h-8 text-[11px]"
            />
          </div>
          <div className="space-y-1.5">
            <div className="text-[12px] font-medium text-foreground/90">环境标识</div>
            <Input
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              placeholder="development"
              className="h-8 text-[11px]"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[12px] font-medium text-foreground/90">附加请求头（可选）</div>
          <Input
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            placeholder="Authorization: Bearer xxx"
            className="h-8 text-[11px] font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            多行 <code className="rounded bg-muted px-1 font-mono text-[10px]">key: value</code> 格式，
            用 Langfuse 时<strong className="font-medium text-foreground/90">不必填</strong>（认证由上方两个 key 自动生成）；
            接其它需要鉴权的自建后端时才用。
          </p>
        </div>

        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
          <p className="text-[10px] text-amber-700 dark:text-amber-500">
            当前口径为<span className="font-medium">完整上报</span>：链路里包含模型收到的完整原文（含论文与实验数据）。
            请确保填写的是你可控的端点；指向第三方云服务等同于把这些数据发给该服务方。
          </p>
        </div>

        <div className="flex items-center justify-between pt-1">
          <a
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-foreground"
            href="http://localhost:3000"
            onClick={(e) => {
              e.preventDefault()
              window.open('http://localhost:3000', '_blank')
            }}
          >
            <ExternalLink className="h-3 w-3" />
            打开本地 Langfuse 查看界面
          </a>
          <Button size="sm" className="h-7 text-[11px]" onClick={() => void handleSave()} disabled={saving}>
            {saving ? null : msg?.type === 'ok' ? <Check className="h-3.5 w-3.5 mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            {saving ? '保存中…' : '保存设置'}
          </Button>
        </div>
        {msg !== null && (
          <p
            className={cn(
              'rounded-md border px-2.5 py-1.5 text-[10px]',
              msg.type === 'error'
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : 'border-green-500/30 bg-green-500/5 text-green-600'
            )}
          >
            {msg.text}
          </p>
        )}
      </div>
    </section>
  )
}
