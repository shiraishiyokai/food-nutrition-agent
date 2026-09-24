export interface CompressedImage {
  dataUrl: string
  width: number
  height: number
  bytes: number
  originalBytes: number
}

export async function compressImage(file: File, maxEdge = 1024, quality = 0.8): Promise<CompressedImage> {
  const source = await loadBitmap(file)
  const srcW = 'width' in source ? source.width : 0
  const srcH = 'height' in source ? source.height : 0
  if (!srcW || !srcH) throw new Error('无法读取图片尺寸')
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH))
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D 不可用')
  ctx.drawImage(source, 0, 0, width, height)
  const dataUrl = canvas.toDataURL('image/jpeg', quality)
  const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
  return { dataUrl, width, height, bytes, originalBytes: file.size }
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // imageOrientation: 'from-image' 按 EXIF 摆正手机拍摄的照片；不支持时退回 <img>（浏览器默认已摆正）
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return await loadViaImg(file)
  }
}

function loadViaImg(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解码失败（可能是不支持的格式）'))
    }
    img.src = url
  })
}
