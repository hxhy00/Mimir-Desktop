/**
 * GPU 服务器探测（原内联在 ipc/index.ts，抽离供 IPC 与 Agent 工具共用）。
 * 探测 = TCP 可达性 + （配置了用户名时）SSH nvidia-smi 只读查询。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connect } from 'net'

const execFileAsync = promisify(execFile)

const TCP_PROBE_TIMEOUT_MS = 4000
const GPU_PROBE_TIMEOUT_MS = 8000
const GPU_PROBE_SSH_TIMEOUT_S = 5
const NVIDIA_SMI_QUERY =
  'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits'

export interface GpuInfo {
  name: string
  utilizationPct: number
  memoryUsedMb: number
  memoryTotalMb: number
}

export interface ProbeConfig {
  host: string
  port: number
  user: string
  gpuCount: number
  keyPath?: string
}

export interface ProbeResult {
  status: 'online' | 'offline'
  message: string | null
  stage: 'tcp' | 'ssh' | 'gpu'
  tcpLatencyMs: number | null
  gpus: GpuInfo[]
}

function probeTcp(host: string, port: number): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let done = false
    const socket = connect({ host, port })
    const finish = (outcome: { ok: boolean; latencyMs?: number; message?: string }) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(outcome)
    }
    socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - startedAt }))
    socket.once('error', (error) => finish({ ok: false, message: error.message }))
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS, () => {
      finish({ ok: false, message: `TCP 连接超时 (${String(TCP_PROBE_TIMEOUT_MS)}ms)` })
    })
  })
}

async function probeGpus(
  host: string,
  port: number,
  username: string,
  keyPath?: string,
): Promise<{ ok: boolean; gpus?: GpuInfo[]; stage?: string; message?: string }> {
  try {
    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${String(GPU_PROBE_SSH_TIMEOUT_S)}`,
      '-p', String(port),
    ]
    if (keyPath) sshArgs.push('-i', keyPath)
    sshArgs.push(`${username}@${host}`, NVIDIA_SMI_QUERY)
    const { stdout } = await execFileAsync('ssh', sshArgs, { timeout: GPU_PROBE_TIMEOUT_MS })
    const gpus: GpuInfo[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const [name, utilizationPct, memoryUsedMb, memoryTotalMb] = trimmed.split(',').map((f) => f.trim())
      gpus.push({
        name: name ?? '',
        utilizationPct: Number(utilizationPct),
        memoryUsedMb: Number(memoryUsedMb),
        memoryTotalMb: Number(memoryTotalMb),
      })
    }
    return { ok: true, gpus }
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : ''
    const message = stderr || (error instanceof Error ? error.message : 'ssh 探测失败')
    const code = (error as { code?: unknown }).code
    return { ok: false, stage: code === 255 ? 'ssh' : 'gpu', message }
  }
}

/** 探测一台服务器：TCP 可达性 + 可选 SSH nvidia-smi。 */
export async function probeServer(config: ProbeConfig): Promise<ProbeResult> {
  const tcp = await probeTcp(config.host, config.port)
  if (!tcp.ok) {
    return { status: 'offline', message: tcp.message ?? '无法连接', stage: 'tcp', tcpLatencyMs: null, gpus: [] }
  }
  // GPU 探测尽力而为——仅在配置了用户名时尝试 SSH
  if (config.user === '') {
    return { status: 'online', message: null, stage: 'tcp', tcpLatencyMs: tcp.latencyMs ?? null, gpus: [] }
  }
  const gpuResult = await probeGpus(config.host, config.port, config.user, config.keyPath)
  return {
    status: 'online',
    message: gpuResult.ok ? null : (gpuResult.message ?? 'GPU 探测失败'),
    stage: gpuResult.ok ? 'gpu' : (gpuResult.stage === undefined ? 'ssh' : (gpuResult.stage as ProbeResult['stage'])),
    tcpLatencyMs: tcp.latencyMs ?? null,
    gpus: gpuResult.ok ? gpuResult.gpus ?? [] : [],
  }
}
