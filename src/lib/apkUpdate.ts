// Actualizaciones del APK (no está en Play Store): al abrir la app se lee version.json del repositorio en GitHub y, si
// trae un versionCode mayor que el instalado, sale el aviso (components/layout/ApkUpdatePrompt.tsx). Si aceptas, el
// plugin nativo AppUpdater (UpdatePlugin.java) descarga el APK con DownloadManager y abre el instalador de Android.
// Fuera de Android no hace nada (en la web, las versiones nuevas llegan solas: lib/updates.ts).
import { App } from '@capacitor/app'
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

// GitHub guarda este archivo hasta 5 min en su caché: un version.json recién subido puede tardar eso en verse.
const VERSION_URL = 'https://raw.githubusercontent.com/MikeM4n/soundblue-mobile/main/version.json'

export interface ApkUpdate {
  versionCode: number
  versionName: string
  apkUrl: string
  changelog: string
}

interface AppUpdaterPlugin {
  downloadAndInstall(options: { url: string }): Promise<void>
  addListener(event: 'progress', listener: (data: { percent: number }) => void): Promise<PluginListenerHandle>
}

const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater')

/** La versión publicada, si es más nueva que la instalada (null: no hay, sin conexión o no es Android). */
export async function findApkUpdate(): Promise<ApkUpdate | null> {
  if (Capacitor.getPlatform() !== 'android') return null
  try {
    const [response, installed] = await Promise.all([fetch(VERSION_URL, { cache: 'no-store' }), App.getInfo()])
    if (!response.ok) return null
    const data = (await response.json()) as Partial<ApkUpdate> | null
    if (typeof data?.versionCode !== 'number' || typeof data.apkUrl !== 'string' || !data.apkUrl.startsWith('https://')) return null
    if (data.versionCode <= Number(installed.build)) return null // build = versionCode del APK instalado
    return { versionCode: data.versionCode, versionName: String(data.versionName ?? ''), apkUrl: data.apkUrl, changelog: String(data.changelog ?? '') }
  } catch {
    return null
  }
}

/** Descarga el APK (avisando el porcentaje) y abre el instalador de Android. */
export async function installApkUpdate(update: ApkUpdate, onProgress: (percent: number) => void): Promise<void> {
  const listener = await AppUpdater.addListener('progress', ({ percent }) => onProgress(percent))
  try {
    await AppUpdater.downloadAndInstall({ url: update.apkUrl })
  } finally {
    void listener.remove()
  }
}
