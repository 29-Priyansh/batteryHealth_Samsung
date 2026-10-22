package com.priyansh.batterylab

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LiveEstimatorTest {
    private val min = 60_000L

    @Test fun firstLevelIsPartialAndNoRateUntilOneStep() {
        val e = LiveEstimator()
        e.observe(0, 80, -1)
        e.observe(5 * min, 79, -1) // anchor
        assertEquals(0, e.steps)
        assertNull(e.ratePerHour())
    }

    @Test fun spanRateOverCompleteSteps() {
        // Worked example §8.4 segment A: 79 → 73 in 52 min = 6.92 %/h.
        val e = LiveEstimator()
        e.observe(0, 80, -1)
        e.observe(6 * min, 79, -1)
        for ((i, level) in (78 downTo 74).withIndex()) e.observe((6 + 9 * (i + 1)) * min, level, -1)
        e.observe(58 * min, 73, -1)
        assertEquals(6, e.steps)
        assertEquals(6.923, e.ratePerHour()!!, 0.01)
        assertEquals((73 - 20) / 6.923, e.hoursTo(73, 20)!!, 0.05)
    }

    @Test fun repeatedObservationsOfSameLevelAreIgnored() {
        val e = LiveEstimator()
        listOf(0L to 50, 1 * min to 50, 2 * min to 51, 3 * min to 51, 4 * min to 52).forEach { (t, l) -> e.observe(t, l, 1) }
        assertEquals(1, e.steps)
        assertEquals(30.0, e.ratePerHour()!!, 1e-9) // 51 first seen at 2 min, 52 at 4 min
    }

    @Test fun directionChangeResetsTheRun() {
        val e = LiveEstimator()
        e.observe(0, 50, 1); e.observe(min, 51, 1); e.observe(2 * min, 52, 1)
        e.observe(3 * min, 52, -1)
        assertEquals(0, e.steps)
        assertEquals(-1, e.direction)
    }

    @Test fun jumpRestartsTheRunAtTheJump() {
        val e = LiveEstimator()
        e.observe(0, 60, -1); e.observe(min, 59, -1); e.observe(2 * min, 58, -1)
        e.observe(3 * min, 55, -1) // implausible jump
        assertEquals(0, e.steps)
        e.observe(13 * min, 54, -1)
        assertEquals(1, e.steps)
        assertEquals(6.0, e.ratePerHour()!!, 1e-9)
    }

    @Test fun hoursToLimitBehindUsIsNull() {
        val e = LiveEstimator()
        e.observe(0, 50, 1); e.observe(min, 51, 1); e.observe(2 * min, 52, 1)
        assertNull(e.hoursTo(52, 40))
        assertEquals(28 / 60.0, e.hoursTo(52, 80)!!, 1e-9)
    }

    @Test fun instantEstimateFromCurrentDraw() {
        // Probe values: 2 250 400 µAh at 57%, -182 mA → ~3948 mAh capacity; 37 points to 20% ≈ 1461 mAh ≈ 8.0 h.
        val (ma, hours) = LiveEstimator.instantHours(2_250_400, -182, 57, 20, -1)!!
        assertEquals(182, ma)
        assertEquals(8.03, hours, 0.05)
        assertNull(LiveEstimator.instantHours(null, -182, 57, 20, -1))
        assertNull(LiveEstimator.instantHours(2_250_400, -2, 57, 20, -1))
        assertEquals(182, LiveEstimator.instantHours(2_250_400, -182_000, 57, 20, -1)!!.first)
    }
}
