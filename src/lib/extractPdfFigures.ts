/**
 * PDF 语义切图（B 路线）：在渲染进程用 PDF.js 解析 PDF，逐页读取 OperatorList，
 * 把「内嵌光栅图像 XObject」（figure 的位图实体）逐张导出为 PNG dataURL。
 * 矢量图形/整页排版裁剪不做（该语义级智能不在本路线范围）。
 */
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let workerReady = false

function ensureWorker(): void {
  if (workerReady) return
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  workerReady = true
}

export interface ExtractedPdfFigure {
  name: string
  dataUrl: string
}

interface PdfJsImage {
  width?: number
  height?: number
  data?: Uint8ClampedArray | Uint8Array
  bitmap?: ImageBitmap
}

function canvasToDataUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
      canvas.convertToBlob({ type: 'image/png' }).then(
        (blob) => {
          const reader = new FileReader()
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(blob)
        },
        () => resolve(null),
      )
      return
    }
    const htmlCanvas = canvas as HTMLCanvasElement
    htmlCanvas.toBlob((blob) => {
      if (blob === null) {
        resolve(null)
        return
      }
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    }, 'image/png')
  })
}

/** 把一个 PDF.js 图像对象画成 PNG dataURL；无法识别时返回 null。 */
async function imageToPngDataUrl(raw: unknown): Promise<string | null> {
  const image = raw as PdfJsImage | undefined
  if (image === undefined) return null
  try {
    const width = typeof image.width === 'number' ? image.width : 0
    const height = typeof image.height === 'number' ? image.height : 0
    if (width <= 0 || height <= 0) return null

    const make = (): HTMLCanvasElement | OffscreenCanvas => {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      return canvas
    }
    const canvas = make()
    const context = canvas.getContext('2d')
    if (context === null) return null

    if (image.bitmap !== undefined) {
      context.drawImage(image.bitmap, 0, 0)
    } else if (image.data !== undefined && image.data.length >= width * height * 4) {
      const clamped =
        image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data.buffer)
      const imageData = new ImageData(new Uint8ClampedArray(clamped), width, height)
      context.putImageData(imageData, 0, 0)
    } else {
      return null
    }
    return await canvasToDataUrl(canvas)
  } catch {
    return null
  }
}

/**
 * 从 PDF 字节中提取内嵌光栅图。
 * @param bytes PDF 二进制（Uint8Array）
 * @param paperKey 命名前缀（如 arxiv id）
 * @returns 抽取到的图（PNG dataURL）；失败/无图返回空数组（绝不抛出打断 UI）
 */
export async function extractPdfFigures(bytes: Uint8Array, paperKey: string): Promise<ExtractedPdfFigure[]> {
  ensureWorker()
  const out: ExtractedPdfFigure[] = []
  try {
    const task = getDocument({ data: bytes })
    const pdf = await task.promise
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo)
      const operatorList = await page.getOperatorList()
      const seen = new Set<string>()
      let seq = 0
      const paint = OPS.paintImageXObject
      const inline = OPS.paintInlineImageXObject
      const fnArray = operatorList.fnArray as number[]
      const argsArray = operatorList.argsArray as Array<Array<unknown>>
      for (let i = 0; i < fnArray.length; i += 1) {
        const fn = fnArray[i]
        if (fn !== paint && fn !== inline) continue
        const args = argsArray[i]
        if (args === undefined || args.length === 0) continue
        const imageKey = String(args[0] ?? '')
        if (seen.has(imageKey)) continue
        seen.add(imageKey)
        // pdf.js 通过 page.objs 暴露已解析的 XObject
        const objs = (page as unknown as { objs?: { get: (name: string) => Promise<unknown> } }).objs
        if (objs === undefined) continue
        const image = await objs.get(imageKey)
        const dataUrl = await imageToPngDataUrl(image)
        if (dataUrl === null) continue
        seq += 1
        out.push({ name: `${paperKey}-p${String(pageNo)}-fig${String(seq)}.png`, dataUrl })
      }
    }
  } catch {
    // 解析失败返回空
  }
  return out
}
