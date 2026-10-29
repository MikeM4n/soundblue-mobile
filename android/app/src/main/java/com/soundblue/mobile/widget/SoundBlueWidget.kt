package com.soundblue.mobile.widget

import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import androidx.annotation.OptIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.soundblue.mobile.MainActivity
import com.soundblue.mobile.PlaybackService
import com.soundblue.mobile.R
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

private val BACKGROUND = Color(0xFF181818)
private val ACCENT = Color(0xFF4169E1) // azul rey del logo
private val TEXT = Color.White
private val TEXT_SECONDARY = Color(0xFFB3B3B3)

/**
 * Widget de SoundBlue (Jetpack Glance): carátula, título, artista y anterior / reproducir-pausar / siguiente. Los botones
 * le mandan la orden a PlaybackService con un MediaController (WidgetControls), sin abrir la app; tocar el resto la abre.
 * Sin nada cargado, invita a abrir la app para elegir música.
 */
class SoundBlueWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val snapshot by SoundBlueWidgetState.snapshot.collectAsState()
            WidgetContent(snapshot)
        }
    }
}

class SoundBlueWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = SoundBlueWidget()
}

@Composable
private fun WidgetContent(snapshot: WidgetSnapshot) {
    val openApp = actionStartActivity<MainActivity>()
    val loaded = snapshot.title != null
    Row(
        modifier = GlanceModifier.fillMaxSize().background(BACKGROUND).cornerRadius(20.dp).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(modifier = GlanceModifier.defaultWeight().clickable(openApp), verticalAlignment = Alignment.CenterVertically) {
            Artwork(snapshot.artwork)
            Spacer(GlanceModifier.width(12.dp))
            Column(modifier = GlanceModifier.defaultWeight()) {
                Text(
                    text = snapshot.title ?: "SoundBlue",
                    style = TextStyle(color = ColorProvider(TEXT), fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    maxLines = 1,
                )
                Text(
                    text = if (loaded) snapshot.artist.orEmpty() else "Toca para elegir música",
                    style = TextStyle(color = ColorProvider(TEXT_SECONDARY), fontSize = 13.sp),
                    maxLines = 1,
                )
            }
        }
        if (loaded) {
            ControlButton(R.drawable.ic_widget_previous, "Anterior", actionRunCallback<PreviousAction>())
            PlayButton(snapshot.playing, actionRunCallback<PlayPauseAction>())
            ControlButton(R.drawable.ic_widget_next, "Siguiente", actionRunCallback<NextAction>())
        } else {
            PlayButton(playing = false, onClick = openApp)
        }
    }
}

@Composable
private fun Artwork(artwork: Bitmap?) {
    val modifier = GlanceModifier.size(48.dp).cornerRadius(8.dp)
    if (artwork != null) {
        Image(ImageProvider(artwork), contentDescription = null, modifier = modifier, contentScale = ContentScale.Crop)
        return
    }
    // Sin carátula (o mientras llega): el logo de SoundBlue.
    Box(modifier = modifier.background(ACCENT), contentAlignment = Alignment.Center) {
        Image(ImageProvider(R.drawable.ic_launcher_foreground), contentDescription = null, modifier = GlanceModifier.size(48.dp))
    }
}

@Composable
private fun ControlButton(icon: Int, label: String, onClick: Action) {
    Box(modifier = GlanceModifier.size(44.dp).cornerRadius(22.dp).clickable(onClick), contentAlignment = Alignment.Center) {
        Image(ImageProvider(icon), contentDescription = label, modifier = GlanceModifier.size(28.dp))
    }
}

@Composable
private fun PlayButton(playing: Boolean, onClick: Action) {
    Box(
        modifier = GlanceModifier.size(44.dp).background(ACCENT).cornerRadius(22.dp).clickable(onClick),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            ImageProvider(if (playing) R.drawable.ic_widget_pause else R.drawable.ic_widget_play),
            contentDescription = if (playing) "Pausar" else "Reproducir",
            modifier = GlanceModifier.size(26.dp),
        )
    }
}

class PlayPauseAction : ActionCallback {
    @OptIn(UnstableApi::class)
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WidgetControls.send(context) { Util.handlePlayPauseButtonAction(it) }
    }
}

class PreviousAction : ActionCallback {
    // «Anterior» con la regla de los 3 s, medida por el reproductor (como los audífonos y el reloj).
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WidgetControls.send(context, Player::seekToPrevious)
    }
}

class NextAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WidgetControls.send(context, Player::seekToNext)
    }
}

/** Un control remoto de un solo uso: se conecta a PlaybackService, manda la orden y suelta la conexión. */
private object WidgetControls {
    private const val RELEASE_DELAY_MS = 1_000L // que la orden llegue al servicio antes de soltar la conexión

    suspend fun send(context: Context, command: (MediaController) -> Unit) = withContext(Dispatchers.Main) {
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val controller = MediaController.Builder(context, token).buildAsync().await()
        try {
            command(controller)
            delay(RELEASE_DELAY_MS)
        } finally {
            controller.release()
        }
    }

    private suspend fun <T> ListenableFuture<T>.await(): T = suspendCancellableCoroutine { continuation ->
        addListener({
            try {
                continuation.resume(get())
            } catch (error: Exception) {
                continuation.resumeWithException(error.cause ?: error)
            }
        }, MoreExecutors.directExecutor())
        continuation.invokeOnCancellation { cancel(false) }
    }
}
