import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import { diagDevServer } from './server/diagDevServer'
import { jamDevServer } from './server/jamDevServer'

// YouTube Music (InnerTube) no responde a otras páginas (CORS): al probar con `npm run dev`, `dev:red` o
// `preview`, este mismo servidor hace de intermediario. Solo datos (búsqueda y listas), nunca audio.
const youtubeMusicProxy: Record<string, ProxyOptions> = {
  '/ytm-api': {
    target: 'https://music.youtube.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/ytm-api/, '/youtubei/v1'),
    headers: { origin: 'https://music.youtube.com', referer: 'https://music.youtube.com/' },
  },
}

// Versión que se ve en Ajustes y en version.json: la de package.json (la misma del APK, ver android/app/build.gradle),
// el commit si compila GitHub Actions (GITHUB_SHA) y la hora de compilación, para saber con qué versión se hizo cada
// prueba en el teléfono.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
const BUILT_AT = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
const APP_VERSION = [version, process.env.GITHUB_SHA?.slice(0, 7), BUILT_AT].filter(Boolean).join(' · ')

/**
 * Completa public/sw.js al compilar: le pasa la lista de archivos generados (con su hash)
 * y una versión nueva, para que la interfaz funcione sin conexión y se actualice sola.
 * Escribe también version.json: la app lo consulta para saber si hay una versión más nueva publicada.
 */
function serviceWorkerPrecache(): Plugin {
  let outDir = 'dist'
  let files: string[] = []
  return {
    name: 'soundblue-sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    generateBundle(_options, bundle) {
      files = Object.keys(bundle).filter((name) => !name.endsWith('.map') && name !== 'index.html')
    },
    closeBundle() {
      const swPath = resolve(outDir, 'sw.js')
      const version = createHash('sha256').update(files.sort().join('|')).digest('hex').slice(0, 10)
      const source = readFileSync(swPath, 'utf8')
        .replace('self.__ARCHIVOS__', JSON.stringify(files.map((name) => `./${name}`)))
        .replace('__VERSION__', version)
      writeFileSync(swPath, source)
      writeFileSync(resolve(outDir, 'version.json'), JSON.stringify({ version: APP_VERSION }) + '\n')
    },
  }
}

export default defineConfig({
  // Se publica en https://mikem4n.github.io/soundblue/ (en desarrollo: http://localhost:5173/soundblue/).
  // Debe coincidir con el nombre del repositorio en GitHub; si no, los archivos dan 404.
  base: './',
  // jamDevServer: las Jams (escuchar en grupo) mientras se prueba; ver server/jamDevServer.ts.
  // diagDevServer: recibe el registro de segundo plano del teléfono en la red local; ver server/diagDevServer.ts.
  plugins: [react(), tailwindcss(), serviceWorkerPrecache(), jamDevServer(), diagDevServer()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  server: { proxy: youtubeMusicProxy },
  preview: { proxy: youtubeMusicProxy },
})
