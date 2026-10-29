import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('node_modules/@mediagrid/capacitor-native-audio/android/src/main/java/us/mediagrid/capacitorjs/plugins/nativeaudio')

async function edit(file, transform) {
  const path = resolve(root, file)
  const original = await readFile(path, 'utf8')
  const updated = transform(original)
  if (updated === original) return
  await writeFile(path, updated, 'utf8')
}

function insertAfter(source, marker, addition) {
  if (source.includes(addition.trim())) return source
  if (!source.includes(marker)) throw new Error(`No se encontró el punto de extensión esperado en el plugin de audio: ${marker}`)
  return source.replace(marker, `${marker}${addition}`)
}

await edit('AudioPlayerService.java', (source) => {
  source = insertAfter(source, 'import androidx.media3.common.C;\n', 'import androidx.media3.common.ForwardingPlayer;\n')
  source = insertAfter(source, '    public static final String PLAYBACK_CHANNEL_ID = "playback_channel";\n', '    public static final String ACTION_MEDIA_NEXT = "com.soundblue.mobile.MEDIA_NEXT";\n')
  source = insertAfter(source, '    public static final String ACTION_MEDIA_NEXT = "com.soundblue.mobile.MEDIA_NEXT";\n', '    public static final String ACTION_MEDIA_PREVIOUS = "com.soundblue.mobile.MEDIA_PREVIOUS";\n')
  const playerBuilder = '        mediaSession = new MediaSession.Builder(this, player)\n'
  if (source.includes(playerBuilder)) {
    source = source.replace(playerBuilder, `        Player sessionPlayer = new ForwardingPlayer(player) {
            @Override public Player.Commands getAvailableCommands() {
                return super.getAvailableCommands().buildUpon()
                    .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                    .add(Player.COMMAND_SEEK_TO_NEXT)
                    .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                    .add(Player.COMMAND_SEEK_TO_PREVIOUS)
                    .build();
            }
            @Override public void seekToNextMediaItem() {
                dispatchMediaNext();
            }
            @Override public void seekToNext() {
                dispatchMediaNext();
            }
            @Override public void seekToPreviousMediaItem() { dispatchMediaPrevious(); }
            @Override public void seekToPrevious() { dispatchMediaPrevious(); }
        };
        mediaSession = new MediaSession.Builder(this, sessionPlayer)
`)
  } else if (!source.includes('new ForwardingPlayer(player)')) {
    throw new Error('No se encontró el constructor esperado de MediaSession.')
  }
  source = insertAfter(source, '                    .add(Player.COMMAND_SEEK_TO_NEXT)\n', '                    .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)\n                    .add(Player.COMMAND_SEEK_TO_PREVIOUS)\n')
  source = insertAfter(source, '            @Override\n            public void seekToNext() {\n                dispatchMediaNext();\n            }\n', '            @Override\n            public void seekToPreviousMediaItem() {\n                dispatchMediaPrevious();\n            }\n\n            @Override\n            public void seekToPrevious() {\n                dispatchMediaPrevious();\n            }\n')
  const sessionBuilderEnd = '            .build();\n    }\n\n    @Override\n    public int onStartCommand'
  source = insertAfter(source, sessionBuilderEnd, '\n\n    void dispatchMediaNext() {\n        sendBroadcast(new Intent(ACTION_MEDIA_NEXT).setPackage(getPackageName()));\n    }\n')
  source = insertAfter(source, '    void dispatchMediaNext() {\n        sendBroadcast(new Intent(ACTION_MEDIA_NEXT).setPackage(getPackageName()));\n    }\n', '\n\n    void dispatchMediaPrevious() {\n        sendBroadcast(new Intent(ACTION_MEDIA_PREVIOUS).setPackage(getPackageName()));\n    }\n')
  return source
})

await edit('MediaSessionCallback.java', (source) => {
  source = insertAfter(source, 'import android.os.Bundle;\n', 'import android.content.Intent;\nimport android.view.KeyEvent;\n')
  source = insertAfter(source, '            .setAvailableSessionCommands(sessionCommands)\n', '            .setAvailablePlayerCommands(session.getPlayer().getAvailableCommands())\n')
  const onCustom = '    @Override\n    public ListenableFuture<SessionResult> onCustomCommand('
  const mediaHandler = `    @Override
    public boolean onMediaButtonEvent(MediaSession session, MediaSession.ControllerInfo controller, Intent intent) {
        if (Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction())) {
            KeyEvent event = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
            if (event != null && event.getKeyCode() == KeyEvent.KEYCODE_MEDIA_NEXT
                && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                audioService.dispatchMediaNext();
                return true;
            }
            if (event != null && event.getKeyCode() == KeyEvent.KEYCODE_MEDIA_PREVIOUS
                && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                audioService.dispatchMediaPrevious();
                return true;
            }
        }
        return MediaSession.Callback.super.onMediaButtonEvent(session, controller, intent);
    }

`
  if (source.includes('onMediaButtonEvent(')) return source
  return insertAfter(source, onCustom, mediaHandler)
})
