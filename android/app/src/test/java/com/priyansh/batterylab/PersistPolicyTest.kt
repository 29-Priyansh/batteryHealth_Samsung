package com.priyansh.batterylab

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PersistPolicyTest {
    private val policy = PersistPolicy(heartbeatMs = 600_000)
    private val base = BatteryReading(level = 57, scale = 100, status = 3, plugged = 0, health = 2, tempDc = 339, voltageMv = 3858)

    @Test fun firstReadingIsPersisted() = assertEquals("first", policy.reason(null, 0, base, 0))

    @Test fun voltageOnlyChangeIsDropped() =
        assertNull(policy.reason(base, 0, base.copy(voltageMv = 3851), 60_000))

    @Test fun levelChangeIsPersisted() =
        assertEquals("level", policy.reason(base, 0, base.copy(level = 56), 1_000))

    @Test fun statusAndPluggedChangesArePersisted() {
        assertEquals("status", policy.reason(base, 0, base.copy(status = 2), 1_000))
        assertEquals("plugged", policy.reason(base, 0, base.copy(plugged = 1), 1_000))
    }

    @Test fun temperatureUsesOneDegreeBuckets() {
        assertNull(policy.reason(base, 0, base.copy(tempDc = 331), 1_000))
        assertEquals("temperature", policy.reason(base, 0, base.copy(tempDc = 340), 1_000))
        assertEquals("temperature", policy.reason(base.copy(tempDc = 0), 0, base.copy(tempDc = -1), 1_000))
    }

    @Test fun heartbeatAfterTenMinutes() {
        assertNull(policy.reason(base, 0, base, 599_999))
        assertEquals("heartbeat", policy.reason(base, 0, base, 600_000))
    }

    @Test fun gapWithinBootUsesElapsed() {
        val gap = detectGap(Clock(1_000, 10_000, 39), Clock(5_000_000, 2_000_000, 39), 900_000)!!
        assertEquals(false, gap.reboot)
        assertEquals(1_990_000, gap.durationMs)
        assertNull(detectGap(Clock(0, 10_000, 39), Clock(0, 900_000, 39), 900_000))
    }

    @Test fun rebootIsAlwaysAGapMeasuredByWallClock() {
        val gap = detectGap(Clock(1_000_000, 50_000_000, 39), Clock(1_120_000, 30_000, 40), 900_000)!!
        assertTrue(gap.reboot)
        assertEquals(120_000, gap.durationMs)
    }

    @Test fun flagsMarkInvalidValues() {
        assertEquals(0, SampleFlags.of(base, 2_250_400, -81))
        val f = SampleFlags.of(base.copy(tempDc = 900, voltageMv = 0), null, null)
        assertEquals(15, f)
    }

    @Test fun unsupportedPropertiesBecomeNull() {
        assertNull(validCounter(Int.MIN_VALUE))
        assertNull(validCounter(0))
        assertNull(validCurrent(Int.MIN_VALUE))
        assertEquals(-81, validCurrent(-81))
    }
}
