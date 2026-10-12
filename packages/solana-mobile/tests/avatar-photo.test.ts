import { beforeEach, expect, mock, test } from 'bun:test'

let selection: unknown
let outputs: string[]
const crop = mock(() => context)
const resize = mock(() => context)
const releaseContext = mock(() => undefined)
const releaseImage = mock(() => undefined)
const save = mock(async () => ({ base64: outputs.shift() }))
const context = {
  crop,
  resize,
  renderAsync: async () => ({ saveAsync: save, release: releaseImage }),
  release: releaseContext,
}
const manipulate = mock(() => context)
mock.module('expo-image-picker', () => ({ launchImageLibraryAsync: async () => selection }))
mock.module('expo-image-manipulator', () => ({ ImageManipulator: { manipulate }, SaveFormat: { JPEG: 'jpeg' } }))
const { pickAvatarPhoto } = await import('../src/lib/avatar-photo')
beforeEach(() => {
  selection = { canceled: false, assets: [{ uri: 'photo', width: 800, height: 600, fileSize: 2000 }] }
  outputs = ['AAAA']
  for (const fn of [crop, resize, releaseContext, releaseImage, save, manipulate]) fn.mockClear()
})
test('cancelling photo selection leaves the profile untouched', async () => {
  selection = { canceled: true }
  expect(await pickAvatarPhoto()).toBeNull()
  expect(manipulate).not.toHaveBeenCalled()
})
test('a photo is centre-cropped and re-encoded as a small square', async () => {
  expect(await pickAvatarPhoto()).toBe('data:image/jpeg;base64,AAAA')
  expect(crop).toHaveBeenCalledWith({ originX: 100, originY: 0, width: 600, height: 600 })
  expect(resize).toHaveBeenCalledWith({ width: 256, height: 256 })
  expect(save).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.85, base64: true })
  expect(releaseContext).toHaveBeenCalledTimes(1)
  expect(releaseImage).toHaveBeenCalledTimes(1)
})
test('an oversized encoded photo retries compression before uploading', async () => {
  outputs = ['A'.repeat(120004), 'AAAA']
  expect(await pickAvatarPhoto()).toBe('data:image/jpeg;base64,AAAA')
  expect(save).toHaveBeenCalledTimes(2)
})
test('photos still too large after compression fail and release native resources', async () => {
  outputs = ['A'.repeat(120004), 'A'.repeat(120004)]
  await expect(pickAvatarPhoto()).rejects.toThrow('small enough')
  expect(releaseContext).toHaveBeenCalledTimes(1)
  expect(releaseImage).toHaveBeenCalledTimes(1)
})
