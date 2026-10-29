// Íconos de la app de Android a partir del trazo del logo (como scripts/iconos.ts para la web).
// Uso: node scripts/mobile-icons.mjs   (escribe en android/app/src/main/res)
//
// Android 8+ usa el ícono adaptativo (mipmap-anydpi-v26): fondo azul del logo (values/ic_launcher_background.xml) y,
// al frente, la onda en vector (drawable/ic_launcher_foreground.xml), nítida en cualquier pantalla y dentro de la zona
// segura, así la máscara del teléfono (círculo, gota o cuadrado) nunca la recorta. Este script solo genera los PNG para
// Android 7 (ic_launcher y ic_launcher_round): el logo redondo dibujado desde el SVG al tamaño exacto de cada densidad.
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { LOGO_PATH } from '../src/components/brand/logo-path.ts'

const AZUL_REY = '#4169E1'
const root = resolve('android/app/src/main/res')
const launcher = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
]

// Ícono de 48 dp con el círculo de 44 dp (margen de las guías de Material): la caja de 32 del logo se amplía a 32·48/44.
const box = (32 * 48) / 44
const margin = (box - 32) / 2
const svg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-margin} ${-margin} ${box} ${box}">` +
    `<circle cx="16" cy="16" r="16" fill="${AZUL_REY}"/>` +
    `<path d="${LOGO_PATH}" fill="none" stroke="#fff" stroke-width="2.75" stroke-linecap="round"/></svg>`,
)

for (const [folder, size] of launcher) {
  const directory = resolve(root, folder)
  mkdirSync(directory, { recursive: true })
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
    await sharp(svg, { density: 72 * (size / box) * 4 }).resize(size, size).png().toFile(resolve(directory, name))
  }
  console.log(`✓ ${folder} (${size} px)`)
}
