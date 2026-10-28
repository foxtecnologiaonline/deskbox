package app.deskbox.phone

import android.content.Context
import android.hardware.display.DisplayManager
import android.util.DisplayMetrics
import android.view.Display
import android.view.Surface
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

object Screen {
    /** Tamanho real da tela em px (inclui barras de sistema), já considerando a rotação atual. */
    @Suppress("DEPRECATION")
    fun realSize(context: Context): Pair<Int, Int> {
        val display = defaultDisplay(context)
        val metrics = DisplayMetrics()
        display.getRealMetrics(metrics)
        return Pair(metrics.widthPixels, metrics.heightPixels)
    }

    fun rotationDegrees(context: Context): Int =
        when (defaultDisplay(context).rotation) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }

    /** Reduz (nunca amplia) para que o maior lado tenha no máximo [maxSide] px, mantendo a proporção e lados pares. */
    fun captureSize(width: Int, height: Int, maxSide: Int = 1280): Pair<Int, Int> {
        val longest = max(width, height)
        val scale = if (longest > maxSide) maxSide.toDouble() / longest else 1.0
        return Pair(even((width * scale).roundToInt()), even((height * scale).roundToInt()))
    }

    private fun even(value: Int): Int = max(2, value and 1.inv())

    private fun defaultDisplay(context: Context): Display {
        val manager = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        return manager.getDisplay(Display.DEFAULT_DISPLAY)
    }
}

/**
 * Relação entre o quadro de vídeo transmitido (formato fixo desde o início da captura) e a tela atual.
 * Se o celular girar, o quadro não é recriado (Android 14 proíbe um 2º VirtualDisplay no mesmo
 * MediaProjection): o conteúdo passa a ocupar um retângulo centralizado no quadro, com faixas pretas.
 */
object FrameGeometry {
    @Volatile
    var captureWidth: Int = 0

    @Volatile
    var captureHeight: Int = 0

    /**
     * Converte coordenadas normalizadas (0..1) do QUADRO transmitido em pixels reais da tela atual
     * ([displayWidth] × [displayHeight]): desconta o letterbox (scale = min(captureW/displayW,
     * captureH/displayH), conteúdo centralizado) e prende o resultado ao retângulo de conteúdo.
     * 1.0 cai no último pixel válido (size - 1).
     */
    fun toScreenPixels(fx: Double, fy: Double, displayWidth: Int, displayHeight: Int): Pair<Float, Float> {
        val captureW = captureWidth
        val captureH = captureHeight
        var nx = fx.coerceIn(0.0, 1.0)
        var ny = fy.coerceIn(0.0, 1.0)
        if (captureW > 0 && captureH > 0 && displayWidth > 0 && displayHeight > 0) {
            val scale = min(captureW.toDouble() / displayWidth, captureH.toDouble() / displayHeight)
            val contentW = displayWidth * scale
            val contentH = displayHeight * scale
            val offsetX = (captureW - contentW) / 2.0
            val offsetY = (captureH - contentH) / 2.0
            nx = ((nx * captureW - offsetX) / contentW).coerceIn(0.0, 1.0)
            ny = ((ny * captureH - offsetY) / contentH).coerceIn(0.0, 1.0)
        }
        return Pair(
            (nx * max(displayWidth - 1, 0)).toFloat(),
            (ny * max(displayHeight - 1, 0)).toFloat()
        )
    }
}
