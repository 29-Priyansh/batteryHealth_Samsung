package com.priyansh.batterylab

import kotlin.math.abs

/**
 * Live indicator for the notification and the Test screen only. Uses the same "complete steps"
 * idea as the engine (docs/PLAN.md §6) over the current uninterrupted run, but stored results and
 * comparisons always come from the TypeScript engine, never from this class.
 */
class LiveEstimator {
    /** +1 charging, -1 discharging, 0 neither (held, full, unknown). */
    var direction = 0
        private set
    private var lastLevel: Int? = null
    private val transitions = ArrayList<Pair<Long, Int>>() // elapsed of first observation, level

    /** Start a new run: called on config changes, pause/resume, and restores after a gap. */
    fun reset() {
        transitions.clear()
        lastLevel = null
    }

    fun observe(elapsed: Long, level: Int, dir: Int) {
        if (dir != direction) {
            reset()
            direction = dir
        }
        if (dir == 0) return
        val prev = lastLevel
        lastLevel = level
        // The level seen at the start of a run is partial: its entry time is unknown.
        if (prev == null || level == prev) return
        val delta = level - prev
        if (abs(delta) != 1 || Integer.signum(delta) != dir) {
            // Jump or reversal: discard the run and anchor a new one here.
            transitions.clear()
        }
        transitions.add(elapsed to level)
    }

    val steps: Int get() = (transitions.size - 1).coerceAtLeast(0)

    /** Percentage points per hour over complete steps (always positive), or null below one step. */
    fun ratePerHour(): Double? {
        if (steps < 1) return null
        val hours = (transitions.last().first - transitions.first().first) / 3_600_000.0
        return if (hours > 0) steps / hours else null
    }

    /** Hours until [limit] at the current rate; null when there is no rate or the limit is behind us. */
    fun hoursTo(level: Int, limit: Int): Double? {
        val rate = ratePerHour() ?: return null
        val points = (limit - level) * direction
        return if (points > 0) points / rate else null
    }

    companion object {
        const val MIN_STEPS_MEASURED = 3

        /**
         * Instant estimate from current draw and charge counter. Samsung reports current in mA (R2.5);
         * magnitudes above 20 000 are treated as µA. Display only.
         */
        fun instantHours(chargeCounterUah: Int?, currentRaw: Int?, level: Int, limit: Int, dir: Int): Pair<Int, Double>? {
            if (chargeCounterUah == null || currentRaw == null || level <= 0 || dir == 0) return null
            val ma = abs(if (abs(currentRaw) > 20_000) currentRaw / 1000 else currentRaw)
            if (ma < 5) return null
            val capacityMah = chargeCounterUah / 1000.0 * 100 / level
            val points = (limit - level) * dir
            if (points <= 0) return null
            return ma to capacityMah * points / 100 / ma
        }
    }
}
