// Compila el APK de Android siempre con la interfaz empaquetada (nunca con el servidor de desarrollo):
// 1. npm run build (TypeScript + Vite → dist)  2. cap sync (copia dist y los plugins a android/)  3. Gradle assembleDebug.
// Usa JAVA_HOME y ANDROID_HOME si están definidos; si no, el JDK 21 y el SDK de %LOCALAPPDATA%\SoundBlueAndroidBuild.
// Deja el resultado en SoundBlue-debug.apk.
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const local = join(process.env.LOCALAPPDATA ?? '', 'SoundBlueAndroidBuild')
const env = { ...process.env }
if (!env.JAVA_HOME && existsSync(join(local, 'jdk'))) {
  const jdk = readdirSync(join(local, 'jdk')).find((name) => name.startsWith('jdk-'))
  if (jdk) env.JAVA_HOME = join(local, 'jdk', jdk)
}
if (!env.ANDROID_HOME && existsSync(join(local, 'sdk'))) env.ANDROID_HOME = join(local, 'sdk')

const run = (command, cwd = '.') => execSync(command, { cwd, env, stdio: 'inherit' })

run('npm run build')
run('npx cap sync android')
run(process.platform === 'win32' ? '.\\gradlew.bat assembleDebug' : './gradlew assembleDebug', 'android')
copyFileSync('android/app/build/outputs/apk/debug/app-debug.apk', 'SoundBlue-debug.apk')
console.log('APK listo: SoundBlue-debug.apk')
