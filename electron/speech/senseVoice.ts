import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream, unlinkSync } from 'fs'
import { writeFile, unlink } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'

// 兼容 ESM（electron-vite 输出）与 CJS（esbuild 单独打包）两种环境：
// CJS 下 import.meta.url 为 undefined，需回退到 __filename
const require = createRequire(
  typeof __filename !== 'undefined' ? __filename : import.meta.url
)
const execFileAsync = promisify(execFile)

// ─── 模型信息 ───────────────────────────────────────────────────
export const SENSE_VOICE_MODEL = {
  id: 'sense-voice-int8',
  name: 'SenseVoice int8 语音识别模型',
  description: '中/英/日/韩/粤 多语言离线语音识别（约 228MB）',
  sizeBytes: 228 * 1024 * 1024,
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
  archiveName: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
  dirName: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
  modelFile: 'model.int8.onnx',
  tokensFile: 'tokens.txt'
}

function modelsDir(): string {
  const dir = join(app.getPath('userData'), 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function modelDir(): string {
  return join(modelsDir(), SENSE_VOICE_MODEL.dirName)
}

export interface ModelStatus {
  installed: boolean
  modelPath?: string
  tokensPath?: string
}

export function getModelStatus(): ModelStatus {
  const modelPath = join(modelDir(), SENSE_VOICE_MODEL.modelFile)
  const tokensPath = join(modelDir(), SENSE_VOICE_MODEL.tokensFile)
  if (existsSync(modelPath) && existsSync(tokensPath)) {
    return { installed: true, modelPath, tokensPath }
  }
  return { installed: false }
}

// ─── 模型下载 ───────────────────────────────────────────────────
function downloadFile(url: string, dest: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const https = require('https') as typeof import('https')
    const file = createWriteStream(dest)

    const handleResponse = (response: import('http').IncomingMessage): void => {
      const status = response.statusCode || 0
      // 处理重定向（GitHub Releases 会 302 到 objects.githubusercontent.com）
      if (status >= 300 && status < 400 && response.headers.location) {
        file.close()
        const redirectUrl = new URL(response.headers.location, url).toString()
        downloadFile(redirectUrl, dest, onProgress).then(resolve).catch(reject)
        return
      }
      if (status !== 200) {
        file.close()
        reject(new Error(`下载失败: HTTP ${status}`))
        return
      }
      const total = parseInt(response.headers['content-length'] || '0', 10)
      let received = 0
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total > 0 && onProgress) {
          onProgress(Math.min(99, Math.round((received / total) * 100)))
        }
      })
      response.pipe(file)
    }

    const request = https.get(url, handleResponse)
    request.on('error', (err) => {
      file.close()
      reject(err)
    })
    file.on('finish', () => {
      file.close()
      onProgress?.(100)
      resolve()
    })
    file.on('error', (err) => {
      request.destroy()
      reject(err)
    })
  })
}

async function extractTarBz2(archivePath: string, destDir: string): Promise<void> {
  // macOS / Linux / Windows 10+ 均自带 tar，支持 bz2 解压
  await execFileAsync('tar', ['-xjf', archivePath, '-C', destDir])
}

export async function downloadModel(onProgress?: (percent: number) => void): Promise<void> {
  const dir = modelsDir()
  const archivePath = join(dir, SENSE_VOICE_MODEL.archiveName)

  // 清理可能残留的旧压缩包
  if (existsSync(archivePath)) unlinkSync(archivePath)

  await downloadFile(SENSE_VOICE_MODEL.url, archivePath, onProgress)
  await extractTarBz2(archivePath, dir)

  // 清理压缩包
  try {
    unlinkSync(archivePath)
  } catch {
    // ignore
  }

  if (!getModelStatus().installed) {
    throw new Error('模型解压后校验失败，请重试')
  }
}

// ─── 音频转换 ───────────────────────────────────────────────────
async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  const ffmpegPath = require('ffmpeg-static') as string
  if (!ffmpegPath) throw new Error('ffmpeg 未找到')
  await execFileAsync(ffmpegPath, [
    '-y',
    '-i', inputPath,
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    outputPath
  ])
}

// ─── 本地识别 ───────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognizer: any = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRecognizer(): any {
  if (recognizer) return recognizer
  const sherpa = require('sherpa-onnx')
  const status = getModelStatus()
  if (!status.installed || !status.modelPath || !status.tokensPath) {
    throw new Error('SenseVoice 模型未下载，请先在设置中下载资源')
  }
  recognizer = sherpa.createOfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: status.modelPath,
        language: 'zh',
        useInverseTextNormalization: 1
      },
      tokens: status.tokensPath,
      numThreads: 1,
      provider: 'cpu',
      debug: 0
    }
  })
  return recognizer
}

async function transcribeWav(wavPath: string): Promise<string> {
  const sherpa = require('sherpa-onnx')
  const rec = getRecognizer()
  const wave = sherpa.readWave(wavPath)
  const stream = rec.createStream()
  try {
    stream.acceptWaveform(wave.sampleRate, wave.samples)
    rec.decode(stream)
    const result = rec.getResult(stream)
    return result.text || ''
  } finally {
    stream.free()
  }
}

export async function transcribeAudioBase64(
  audioBase64: string
): Promise<{ text?: string; error?: string }> {
  try {
    if (!getModelStatus().installed) {
      return { error: 'SenseVoice 模型未下载，请先在设置中下载资源' }
    }
    const buffer = Buffer.from(audioBase64, 'base64')
    if (buffer.length === 0) return { error: '音频数据为空' }

    const tmpDir = join(app.getPath('userData'), 'tmp')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
    const id = randomUUID()
    const webmPath = join(tmpDir, `${id}.webm`)
    const wavPath = join(tmpDir, `${id}.wav`)

    try {
      await writeFile(webmPath, buffer)
      await convertToWav(webmPath, wavPath)
      const text = await transcribeWav(wavPath)
      return { text }
    } finally {
      try {
        await unlink(webmPath)
      } catch {
        // ignore
      }
      try {
        await unlink(wavPath)
      } catch {
        // ignore
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : '本地语音识别失败' }
  }
}