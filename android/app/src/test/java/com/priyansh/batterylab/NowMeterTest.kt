package com.priyansh.batterylab

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NowMeterTest {
    @Test fun firstReadingIsTakenAsIs() {
        val m = NowMeter()
        m.update(0, -800)
        assertEquals(800.0, m.currentMa!!, 1e-9)
    }

    @Test fun smoothingFollowsATimeConstant() {
        val m = NowMeter(tauMs = 30_000)
        m.update(0, -100)
        m.update(30_000, -1100) // one time constant later: ~63% of the way
        assertEquals(100 + 1000 * (1 - Math.exp(-1.0)), m.currentMa!!, 1e-6)
        repeat(60) { m.update(30_000L + (it + 1) * 5_000, -1100) } // 5 more minutes = 10 time constants
        assertEquals(1100.0, m.currentMa!!, 1.0)
    }

    @Test fun microampsAreConverted() {
        assertEquals(-182.0, NowMeter.toMa(-182_000), 1e-9)
        assertEquals(-182.0, NowMeter.toMa(-182), 1e-9)
    }

    @Test fun drainingHoursFromChargeAndCurrent() {
        // 2 250 400 µAh at 57% → ~3948 mAh full; 37 points to 20% ≈ 1461 mAh; at 182 mA ≈ 8.03 h.
        assertEquals(8.03, NowMeter.hours(2_250_400, 182.0, 57, 20, -1)!!, 0.01)
        assertNull(NowMeter.hours(2_250_400, 2.0, 57, 20, -1))
        assertNull(NowMeter.hours(null, 182.0, 57, 20, -1))
        assertNull(NowMeter.hours(2_250_400, 182.0, 57, 60, -1))
    }

    @Test fun chargingPastEightyUsesTheTaper() {
        // 50% of 4000 mAh; 2000 mA charging. 50→80: 1200 mAh / 2000 = 0.6 h.
        val counter = 2_000_000
        assertEquals(0.6, NowMeter.hours(counter, 2000.0, 50, 80, 1)!!, 1e-9)
        // 80→100 with measured 40 %/h = 0.5 h extra.
        assertEquals(1.1, NowMeter.hours(counter, 2000.0, 50, 100, 1, taperRatePerHour = 40.0)!!, 1e-9)
        // Without history: half the current for the last 20 points: 800 mAh / 1000 = 0.8 h extra.
        assertEquals(1.4, NowMeter.hours(counter, 2000.0, 50, 100, 1)!!, 1e-9)
    }

    @Test fun idleRateBetweenTwoCounterReadings() {
        // 39.48 mAh used in 1 h with ~3948 mAh full → 1 %/h.
        assertEquals(1.0, NowMeter.ratePerHour(2_289_880, 2_250_400, 3_600_000, 57)!!, 0.01)
        assertNull(NowMeter.ratePerHour(2_250_400, 2_260_000, 3_600_000, 57)) // charged in between
        assertNull(NowMeter.ratePerHour(2_289_880, 2_250_400, 60_000, 57)) // too short
    }
}
