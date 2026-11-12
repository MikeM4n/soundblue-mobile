// Compila el APK de Android siempre con la interfaz empaquetada (nunca con el servidor de desarrollo):
// 1. npm run build (TypeScript + Vite → dist)  2. borra android/app/src/main/assets/public y hace cap sync (copia dist y
// los plugins a android/), así no queda nada de una compilación anterior  3. revisa que la copia tenga index.html y sus
// JS  4. Gradle assembleRelease: el APK de producción, firmado con la clave de android/keystore.properties (sin ese
// archivo no compila: ver android/app/build.gradle).
// Usa JAVA_HOME y ANDROID_HOME si están definidos; si no, el JDK 21 y el SDK de %LOCALAPPDATA%\SoundBlueAndroidBuild.
// Deja el resultado en SoundBlue.apk (Gradle ya lo nombra así: android/app/build.gradle).
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const local = join(process.env.LOCALAPPDATA ?? '', 'SoundBlueAndroidBuild')
const env = { ...process.env }
if (!env.JAVA_HOME && existsSync(join(local, 'jdk'))) {
  const jdk = readdirSync(join(local, 'jdk')).find((name) => name.startsWith('jdk-'))
  if (jdk) env.JAVA_HOME = join(local, 'jdk', jdk)
}
if (!env.ANDROID_HOME && existsSync(join(local, 'sdk'))) env.ANDROID_HOME = join(local, 'sdk')

const run = (command, cwd = '.') => execSync(command, { cwd, env, stdio: 'inherit' })
const PUBLIC = 'android/app/src/main/assets/public'

if (!existsSync('android/keystore.properties')) {
  console.error('\nFalta android/keystore.properties (la clave de firma y su contraseña): sin ella no se puede firmar el APK.')
  process.exit(1)
}
run('npm run build')
rmSync(PUBLIC, { recursive: true, force: true })
run('npx cap sync android')
checkPublic()
run(process.platform === 'win32' ? '.\\gradlew.bat assembleRelease' : './gradlew assembleRelease', 'android')
copyFileSync('android/app/build/outputs/apk/release/SoundBlue.apk', 'SoundBlue.apk')
rmSync('SoundBlue-debug.apk', { force: true }) // el nombre de antes de la 1.7.0: que no quede uno viejo a la mano
console.log('APK listo: SoundBlue.apk')

/** La interfaz que va dentro del APK: index.html y cada JS que pide, y ninguna dirección de servidor en la config. */
function checkPublic() {
  const fail = (message) => {
    console.error(`\n${message}`)
    process.exit(1)
  }
  const index = join(PUBLIC, 'index.html')
  if (!existsSync(index)) fail(`Falta ${index}: cap sync no copió la interfaz.`)
  const scripts = [...readFileSync(index, 'utf8').matchAll(/<script[^>]+src="\.?\/?([^"]+\.js)"/g)].map((match) => match[1])
  if (!scripts.length) fail(`${index} no carga ningún JS.`)
  const missing = scripts.filter((file) => !existsSync(join(PUBLIC, file)))
  if (missing.length) fail(`Faltan en ${PUBLIC}: ${missing.join(', ')}`)
  const config = JSON.parse(readFileSync('android/app/src/main/assets/capacitor.config.json', 'utf8'))
  if (config.server) fail('capacitor.config.json trae «server»: el APK cargaría un servidor en vez de la interfaz empaquetada.')
  const js = readdirSync(join(PUBLIC, 'assets')).filter((file) => file.endsWith('.js'))
  console.log(`Interfaz en ${PUBLIC}: index.html + ${js.length} JS (${scripts.join(', ')}), sin «server».`)
}
