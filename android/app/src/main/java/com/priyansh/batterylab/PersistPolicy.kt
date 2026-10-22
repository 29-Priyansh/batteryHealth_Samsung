package com.priyansh.batterylab

/** Public fields of one ACTION_BATTERY_CHANGED delivery. Pure data, no Android types. */
data class BatteryReading(
    val level: Int,
    val scale: Int,
    val status: Int,
    val plugged: Int,
    val health: Int,
    val tempDc: Int,
    val voltageMv: Int,
)

/** Moment on the three clocks every row carries (see docs/PLAN.md §3.3). */
data class Clock(val wall: Long, val elapsed: Long, val boot: Int)

/**
 * Decides whether a battery broadcast is worth a database row (docs/PLAN.md §3.2).
 * Broadcasts arrive far more often than anything meaningful changes, so most are dropped.
 */
class PersistPolicy(private val heartbeatMs: Long = 10 * 60_000L) {

    /** Reason to persist [cur], or null to drop it. [last] is the last *persisted* reading. */
    fun reason(last: BatteryReading?, lastPersistElapsed: Long, cur: BatteryReading, nowElapsed: Long): String? = when {
        last == null -> "first"
        cur.level != last.level -> "level"
        cur.status != last.status -> "status"
        cur.plugged != last.plugged -> "plugged"
        Math.floorDiv(cur.tempDc, 10) != Math.floorDiv(last.tempDc, 10) -> "temperature"
        nowElapsed - lastPersistElapsed >= heartbeatMs -> "heartbeat"
        else -> null
    }
}

data class Gap(val from: Clock, val to: Clock, val reboot: Boolean) {
    /** Best duration estimate: elapsed time within one boot, wall time across a reboot. */
    val durationMs: Long get() = if (reboot) to.wall - from.wall else to.elapsed - from.elapsed
}

/** A gap exists when observation stopped for longer than [thresholdMs] or the device rebooted. */
fun detectGap(last: Clock, now: Clock, thresholdMs: Long): Gap? = when {
    now.boot != last.boot -> Gap(last, now, reboot = true)
    now.elapsed - last.elapsed > thresholdMs -> Gap(last, now, reboot = false)
    else -> null
}

/** Validity bits stored in sample.flags. */
object SampleFlags {
    const val INVALID_TEMPERATURE = 1
    const val INVALID_VOLTAGE = 2
    const val INVALID_CHARGE_COUNTER = 4
    const val INVALID_CURRENT = 8

    fun of(r: BatteryReading, chargeCounter: Int?, current: Int?): Int {
        var f = 0
        if (r.tempDc !in -200..700) f = f or INVALID_TEMPERATURE
        if (r.voltageMv !in 2500..5000) f = f or INVALID_VOLTAGE
        if (chargeCounter == null) f = f or INVALID_CHARGE_COUNTER
        if (current == null) f = f or INVALID_CURRENT
        return f
    }
}

/** BatteryManager returns Int.MIN_VALUE (or sometimes 0) when a property is unsupported. */
fun validCounter(raw: Int): Int? = raw.takeIf { it != Int.MIN_VALUE && it > 0 }
fun validCurrent(raw: Int): Int? = raw.takeIf { it != Int.MIN_VALUE }
