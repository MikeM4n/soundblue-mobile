import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve('android/app/src/main/res')
const source = resolve('public/icons/icon-512.png')
const launcher = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
]

for (const [folder, size] of launcher) {
  const directory = resolve(root, folder)
  mkdirSync(directory, { recursive: true })
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
    await sharp(source).resize(size, size).png().toFile(resolve(directory, name))
  }
  await sharp(source).resize(size, size).png().toFile(resolve(directory, 'ic_launcher_foreground.png'))
}

const notification = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M6 16 Q8.5 9.5 11 16 T16 16 T21 16 T26 16" fill="none" stroke="#fff" stroke-width="2.75" stroke-linecap="round"/></svg>',
)
const drawable = resolve(root, 'drawable')
mkdirSync(drawable, { recursive: true })
await sharp(notification).png().toFile(resolve(drawable, 'ic_stat_soundblue.png'))
