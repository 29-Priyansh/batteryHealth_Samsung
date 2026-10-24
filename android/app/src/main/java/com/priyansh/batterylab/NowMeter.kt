package com.priyansh.batterylab

import kotlin.math.abs
import kotlin.math.exp

/**
 * "Now" meter, like a car's instant fuel economy: battery current smoothed over about [tauMs],
 * turned into time to a limit. It reacts to what the phone is doing (screen, apps, radio, heat-limited
 * charging) because the battery current is the net of all of it. Display only; never stored.
 */
class NowMeter(private val tauMs: Long = 30_000L) {
    private var emaMa: Double? = null
    private var lastElapsed = 0L

    /** Smoothed current magnitude in mA, or null before the first reading. */
    val currentMa: Double? get() = emaMa

    fun reset() {
        emaMa = null
    }

    fun update(elapsed: Long, rawCurrent: Int) {
        val ma = abs(toMa(rawCurrent))
        val prev = emaMa
        emaMa = if (prev == null) {
            ma
        } else {
            // Exponential moving average with a time constant, so irregular reading intervals are handled.
            val alpha = 1 - exp(-(elapsed - lastElapsed).coerceAtLeast(0) / tauMs.toDouble())
            prev + alpha * (ma - prev)
        }
        lastElapsed = elapsed
    }

    companion object {
        /** Samsung reports mA (R2.5); magnitudes above 20 000 are treated as µA. */
        fun toMa(raw: Int): Double = if (abs(raw) > 20_000) raw / 1000.0 else raw.toDouble()

        /** Charging slows down above this level (constant-voltage phase), so "now" can't be extrapolated past it. */
        const val TAPER_LEVEL = 80

        /**
         * Hours from [level] to [limit] at [currentMa], given the charge counter.
         * Charging past [TAPER_LEVEL]: the part above it uses [taperRatePerHour] (measured history) when known,
         * otherwise half the current, a conservative stand-in for the taper.
         */
        fun hours(
            chargeCounterUah: Int?, currentMa: Double?, level: Int, limit: Int, dir: Int, taperRatePerHour: Double? = null,
        ): Double? {
            if (chargeCounterUah == null || currentMa == null || level <= 0 || dir == 0 || currentMa < 5) return null
            val capacityMah = chargeCounterUah / 1000.0 * 100 / level
            val points = (limit - level) * dir
            if (points <= 0) return null
            if (dir < 0 || limit <= TAPER_LEVEL) return capacityMah * points / 100 / currentMa
            val before = (TAPER_LEVEL - level).coerceAtLeast(0)
            val after = limit - maxOf(level, TAPER_LEVEL)
            val hBefore = capacityMah * before / 100 / currentMa
            val hAfter = if (taperRatePerHour != null && taperRatePerHour > 0) after / taperRatePerHour
                else capacityMah * after / 100 / (currentMa / 2)
            return hBefore + hAfter
        }

        /** Average drain in %/h between two charge-counter readings (e.g. while the screen was off). */
        fun ratePerHour(counterStartUah: Int, counterEndUah: Int, elapsedMs: Long, level: Int): Double? {
            if (elapsedMs < 5 * 60_000 || level <= 0) return null // too short to mean anything
            val usedMah = (counterStartUah - counterEndUah) / 1000.0
            if (usedMah <= 0) return null // charged in between
            val capacityMah = counterEndUah / 1000.0 * 100 / level
            return usedMah / capacityMah * 100 / (elapsedMs / 3_600_000.0)
        }
    }
}
