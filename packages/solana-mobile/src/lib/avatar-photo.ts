import { launchImageLibraryAsync } from 'expo-image-picker'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'

/** Re-encode a centred 256px square, without the original image's metadata. */
export async function pickAvatarPhoto(): Promise<string | null> {
  const result = await launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 })
  if (result.canceled) return null
  const asset = result.assets[0]
  if (!asset || asset.width <= 0 || asset.height <= 0 || (asset.fileSize ?? 0) > 20_000_000)
    throw new Error('Choose a picture under 20 MB')
  const side = Math.min(asset.width, asset.height)
  const context = ImageManipulator.manipulate(asset.uri)
  context
    .crop({
      originX: Math.floor((asset.width - side) / 2),
      originY: Math.floor((asset.height - side) / 2),
      width: side,
      height: side,
    })
    .resize({ width: 256, height: 256 })
  try {
    const image = await context.renderAsync()
    try {
      for (const compress of [0.85, 0.6]) {
        const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64: true })
        if (saved.base64 && saved.base64.length * 0.75 <= 90_000) return `data:image/jpeg;base64,${saved.base64}`
      }
      throw new Error('This picture could not be made small enough')
    } finally {
      image.release()
    }
  } finally {
    context.release()
  }
}
