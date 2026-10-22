package com.priyansh.batterylab

import android.app.ActivityManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.sqlite.SQLiteDatabase
import android.net.TrafficStats
import android.os.BatteryManager
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.telephony.TelephonyManager
import android.util.Log
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors

/**
 * Records raw facts for the active session (docs/PLAN.md §3). All state is confined to one
 * executor thread; receivers and the plugin hand work over with [post]. No results are computed here.
 */
object Recorder {
    private const val TAG = "Recorder"
    private const val HEARTBEAT_MS = 10 * 60_000L
    private const val GAP_MS = 15 * 60_000L
    private const val MANUAL_WINDOW_MAX_MS = 30 * 60_000L
    /** Plugged in but not charging this long during a charging test = held by battery protection. */
    private const val HELD_LIMIT_MS = 15 * 60_000L
    private const val RESULTS_CHANNEL = "results"
    const val SETTING_ALWAYS_ON = "alwaysOn.enabled"
    const val SETTING_RESERVE = "alwaysOn.reserve"
    const val SETTING_CHARGE_TARGET = "alwaysOn.chargeTarget"
    const val SETTING_PRIORS = "priors"

    private val exec = Executors.newSingleThreadExecutor()
    private lateinit var app: Context
    private val db get() = LabDatabase.get(app)
    private val policy = PersistPolicy(HEARTBEAT_MS)

    private data class Active(
        val id: String,
        val type: String,
        var target: Int?,
        var threshold: Int?,
        val startWall: Long,
        val tracked: List<String>,
        var status: String,
        /** "test" (started by the user) or "passive" (always-on everyday recording). */
        val mode: String = "test",
    ) {
        val passive get() = mode == "passive"
    }

    private data class Value(val value: String?, val src: String)

    // ---- executor-confined state
    private var active: Active? = null
    private var values: Map<String, Value> = emptyMap()
    private var stateId = 0L
    private var lastPersisted: BatteryReading? = null
    private var lastPersistClock: Clock? = null
    private var screenOn: Boolean? = null
    private var radio: String? = null
    private val radioHistory = ArrayDeque<Pair<Long, String>>()
    private var statBroadcasts = 0L
    private var statRows = 0L
    private var statCpuNs = 0L
    private val live = LiveEstimator()
    private var heldSinceElapsed: Long? = null
    private var priorsCache: JSONObject? = null

    /** Elapsed time the UI last went to the background; bounds manual-change windows. */
    @Volatile var uiPausedElapsed: Long = 0L

    @Volatile var service: MonitorService? = null
    val listeners = CopyOnWriteArraySet<(JSObject) -> Unit>()

    private val bootCount by lazy {
        runCatching { Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT) }.getOrDefault(-1)
    }

    fun init(ctx: Context) {
        if (!::app.isInitialized) app = ctx.applicationContext
    }

    fun post(block: () -> Unit) = exec.execute {
        try {
            block()
        } catch (e: Throwable) {
            Log.e(TAG, "recorder task failed", e)
        }
    }

    private fun now() = Clock(System.currentTimeMillis(), SystemClock.elapsedRealtime(), bootCount)

    // ------------------------------------------------------------------ session lifecycle

    fun hasActiveSession(): Boolean = active != null || restore()

    fun startSession(
        type: String, target: Int?, threshold: Int?, manual: Map<String, String?>,
        tracked: List<String>, conditions: String?, notes: String?,
    ): JSObject {
        if (hasActiveSession()) {
            check(active?.passive == true) { "A test is already running" }
            stop("superseded") // a deliberate test replaces everyday recording until it ends
        }
        val t = now()
        val battery = readBattery() ?: error("Battery status unavailable")
        // The limit must lie ahead of the current level, otherwise the session would end on its first sample.
        when (type) {
            "charging" -> require(target != null && target in (battery.level + 1)..100) {
                "Charging target must be between ${battery.level + 1}% and 100%"
            }
            "draining" -> require(threshold != null && threshold in 1 until battery.level) {
                "Discharge level must be between 1% and ${battery.level - 1}%"
            }
        }
        return open(type, "test", target, threshold, manual, tracked, conditions, notes, t, battery)
    }

    /** Starts everyday recording if it is enabled and nothing else is running. */
    fun startPassiveIfEnabled(): Boolean {
        if (active != null || restore() || !alwaysOnEnabled()) return active != null
        val battery = readBattery() ?: return false
        open("draining", "passive", null, null, emptyMap(), AutoParams.KEYS, null, null, now(), battery)
        return true
    }

    fun setAlwaysOn(enabled: Boolean): JSObject {
        db.setSetting(SETTING_ALWAYS_ON, enabled.toString())
        if (enabled) {
            if (startPassiveIfEnabled()) service ?: MonitorService.start(app)
        } else if (active?.passive == true) {
            stop("stopped")
        }
        return JSObject().put("enabled", enabled)
    }

    fun alwaysOnEnabled(): Boolean = db.getSetting(SETTING_ALWAYS_ON) == "true"

    /** Called after the UI stores new history rates for the live estimate. */
    fun invalidatePriors() = post { priorsCache = null }

    private fun open(
        type: String, mode: String, target: Int?, threshold: Int?, manual: Map<String, String?>,
        tracked: List<String>, conditions: String?, notes: String?, t: Clock, battery: BatteryReading,
    ): JSObject {
        val id = UUID.randomUUID().toString()
        val initial = AutoParams.read(app).mapValues { (_, v) -> Value(v, if (v == null) "unknown" else "verified") } +
            manual.mapValues { (_, v) -> Value(v, if (v == null) "unknown" else "user_confirmed") }
        db.tx { d ->
            val buildId = ensureBuildSnapshot(d, t)
            d.insertOrThrow("session", null, ContentValues().apply {
                put("id", id); put("type", type); put("status", "active")
                put("start_wall", t.wall); put("start_elapsed", t.elapsed); put("start_boot", t.boot)
                put("start_level", battery.level); put("target_level", target); put("lower_threshold", threshold)
                put("tracked_params", JSONArray(tracked).toString()); put("conditions", conditions); put("notes", notes)
                put("build_snapshot_id", buildId); put("app_version", appVersion()); put("mode", mode)
            })
            stateId = insertState(d, id, t, initial)
            insertEvent(d, id, t, "start", null)
        }
        active = Active(id, type, target, threshold, t.wall, tracked, "active", mode)
        live.reset()
        values = initial
        screenOn = app.getSystemService(PowerManager::class.java).isInteractive
        lastPersisted = null
        persist(battery, "start", t)
        return sessionJson(id)
    }

    /** Changes where the active session stops (charging target or draining lower level). */
    fun setLimit(value: Int): JSObject {
        val s = active ?: error("No active session")
        val level = readBattery()?.level ?: lastPersisted?.level ?: error("Battery status unavailable")
        val column: String
        val previous: Int?
        if (s.type == "charging") {
            require(value in (level + 1)..100) { "Charging target must be between ${level + 1}% and 100%" }
            column = "target_level"; previous = s.target; s.target = value
        } else {
            require(value in 1 until level) { "Discharge level must be between 1% and ${level - 1}%" }
            column = "lower_threshold"; previous = s.threshold; s.threshold = value
        }
        val t = now()
        db.tx { d ->
            d.update("session", ContentValues().apply { put(column, value) }, "id = ?", arrayOf(s.id))
            insertEvent(d, s.id, t, "limit_changed", JSONObject().put("from", previous).put("to", value))
        }
        readBattery()?.let { notify(s, it) }
        return sessionJson(s.id)
    }

    fun pause(): JSObject = setPaused(true)
    fun resume(): JSObject = setPaused(false)

    private fun setPaused(paused: Boolean): JSObject {
        val s = active ?: error("No active session")
        val next = if (paused) "paused" else "active"
        if (s.status != next) {
            val t = now()
            db.tx { d ->
                d.update("session", ContentValues().apply { put("status", next) }, "id = ?", arrayOf(s.id))
                insertEvent(d, s.id, t, if (paused) "pause" else "resume", null)
            }
            s.status = next
            live.reset()
            readBattery()?.let { persist(it, if (paused) "pause" else "resume", t) }
        }
        return sessionJson(s.id)
    }

    fun stop(finalStatus: String = "stopped", payload: JSONObject? = null): JSObject {
        val s = active ?: error("No active session")
        val t = now()
        val battery = readBattery()
        battery?.let { persist(it, "stop", t) }
        db.tx { d ->
            insertEvent(d, s.id, t, "stop", payload)
            d.update("session", ContentValues().apply {
                put("status", finalStatus); put("end_wall", t.wall); put("end_elapsed", t.elapsed); put("end_boot", t.boot)
                put("end_level", battery?.level ?: lastPersisted?.level)
            }, "id = ?", arrayOf(s.id))
        }
        flushStats()
        active = null
        values = emptyMap()
        lastPersisted = null
        lastPersistClock = null
        heldSinceElapsed = null
        val row = sessionJson(s.id)
        // Tests that end on their own get a short result notification; a manual stop happens in the app.
        if (!s.passive && finalStatus != "stopped" && finalStatus != "superseded") notifyFinished(row)
        // Everyday recording continues after a test ends and across days; otherwise monitoring stops.
        val resumeEveryday = finalStatus != "superseded" && !(s.passive && finalStatus == "stopped")
        if (!(resumeEveryday && startPassiveIfEnabled())) {
            if (finalStatus != "superseded") service?.stopMonitoring()
        }
        return row
    }

    /** Manual parameter change (or confirmation that a value is unknown). */
    fun logChange(key: String, value: String?, windowStartWall: Long?): JSObject {
        val s = active ?: error("No active session")
        val t = now()
        val windowStart = when {
            windowStartWall != null -> t.elapsed - (t.wall - windowStartWall).coerceIn(0, MANUAL_WINDOW_MAX_MS)
            t.elapsed - uiPausedElapsed in 1..MANUAL_WINDOW_MAX_MS -> uiPausedElapsed
            else -> t.elapsed
        }
        val evidence = JSONObject().put("radio_transitions",
            JSONArray(radioHistory.filter { it.first >= windowStart - 60_000 }.map { JSONObject().put("elapsed", it.first).put("radio", it.second) }))
        applyChanges(s, t, mapOf(key to Value(value, if (value == null) "unknown" else "user_confirmed")),
            source = "user_tap", windowStart = windowStart, evidence = evidence)
        return sessionJson(s.id)
    }

    // ------------------------------------------------------------------ inputs from MonitorService

    fun onBattery(intent: Intent) = measured {
        statBroadcasts++
        val s = active ?: return@measured
        val r = intent.toReading() ?: return@measured
        val t = now()
        val reason = policy.reason(lastPersisted, lastPersistClock?.elapsed ?: 0, r, t.elapsed)
        if (reason == null) {
            checkLimits(s, r, t)
            return@measured
        }
        val before = lastPersistClock
        reconcileAuto("sample_poll", exact = false)
        // A detected change already wrote a row with this same reading; don't write it twice.
        if (lastPersistClock === before || lastPersisted != r) persist(r, reason, t)
        if (reason == "heartbeat") flushStats()
        checkLimits(s, r, t)
    }

    fun onScreen(on: Boolean) = measured {
        screenOn = on
        val s = active ?: return@measured
        val t = now()
        db.tx { d -> insertEvent(d, s.id, t, if (on) "screen_on" else "screen_off", null) }
        readBattery()?.let { persist(it, if (on) "screen_on" else "screen_off", t) }
    }

    fun onRadio(label: String) = measured {
        if (label == radio) return@measured
        radio = label
        radioHistory.addLast(SystemClock.elapsedRealtime() to label)
        while (radioHistory.size > 50) radioHistory.removeFirst()
    }

    fun onAutoParamSignal(source: String) = measured { reconcileAuto(source, exact = true) }

    fun onSystemEvent(type: String, payload: JSONObject? = null) = measured {
        val s = active ?: return@measured
        val t = now()
        db.tx { d -> insertEvent(d, s.id, t, type, payload) }
        if (type == "shutdown") readBattery()?.let { persist(it, "shutdown", t) }
    }

    /** Called when the service (re)starts: restores state after process death and records the gap. */
    fun onServiceStarted() {
        if (active != null) return
        if (!restore() && !startPassiveIfEnabled()) service?.stopMonitoring()
    }

    // ------------------------------------------------------------------ core

    private fun restore(): Boolean {
        if (active != null) return true
        val row = db.queryOne("SELECT * FROM session WHERE status IN ('active','paused') ORDER BY start_wall DESC LIMIT 1")
            ?: return false
        val id = row.getString("id")!!
        active = Active(
            id, row.getString("type")!!,
            row.optIntOrNull("target_level"), row.optIntOrNull("lower_threshold"), row.getLong("start_wall"),
            JSONArray(row.getString("tracked_params") ?: "[]").let { a -> List(a.length()) { a.getString(it) } },
            row.getString("status")!!,
            row.optString("mode", "test"),
        )
        val state = db.queryOne("SELECT id FROM config_state WHERE session_id = ? ORDER BY id DESC LIMIT 1", id)
        stateId = state?.getLong("id") ?: 0L
        values = buildMap {
            val rows = db.queryJson("SELECT param_key, value, src FROM param_value WHERE config_state_id = ?", stateId.toString())
            for (i in 0 until rows.length()) {
                val r = rows.getJSONObject(i)
                put(r.getString("param_key"), Value(r.optString("value").takeIf { !r.isNull("value") }, r.getString("src")))
            }
        }
        val last = db.queryOne(
            "SELECT * FROM sample WHERE session_id = ? ORDER BY id DESC LIMIT 1", id,
        )
        val t = now()
        val payload = JSONObject().put("exit", lastExitReason())
        if (last != null) {
            lastPersisted = BatteryReading(
                last.getInt("level"), last.getInt("scale"), last.getInt("status"), last.getInt("plugged"),
                last.optInt("health"), last.optInt("temp_dc"), last.optInt("voltage_mv"),
            )
            val lastClock = Clock(last.getLong("wall_ms"), last.getLong("elapsed_ms"), last.getInt("boot_count"))
            lastPersistClock = lastClock
            detectGap(lastClock, t, GAP_MS)?.let { gap ->
                payload.put("gap_from_wall", gap.from.wall).put("gap_from_elapsed", gap.from.elapsed)
                    .put("gap_from_boot", gap.from.boot).put("gap_ms", gap.durationMs).put("reboot", gap.reboot)
            }
        }
        screenOn = app.getSystemService(PowerManager::class.java).isInteractive
        rebuildLive(id, t, gap = payload.has("gap_ms"))
        db.tx { d ->
            ensureBuildSnapshot(d, t, sessionId = id)
            insertEvent(d, id, t, if (payload.has("gap_ms")) "gap_detected" else "process_start", payload)
        }
        readBattery()?.let { persist(it, "recovery", t) }
        reconcileAuto("recovery", exact = false)
        return true
    }

    /** Re-reads automatic parameters; any difference closes the current configuration state. */
    private fun reconcileAuto(source: String, exact: Boolean) {
        val s = active ?: return
        val t = now()
        val changed = AutoParams.read(app)
            .filter { (k, v) -> values[k]?.value != v }
            .mapValues { (_, v) -> Value(v, if (v == null) "unknown" else "verified") }
        if (changed.isEmpty()) return
        val windowStart = if (exact) t.elapsed else lastPersistClock?.takeIf { it.boot == t.boot }?.elapsed ?: t.elapsed
        applyChanges(s, t, changed, source, windowStart, evidence = null)
    }

    private fun applyChanges(s: Active, t: Clock, changed: Map<String, Value>, source: String, windowStart: Long, evidence: JSONObject?) {
        val prevId = stateId
        val prev = values
        val next = prev + changed
        db.tx { d ->
            stateId = insertState(d, s.id, t, next)
            for ((key, v) in changed) {
                d.insertOrThrow("config_change", null, ContentValues().apply {
                    put("session_id", s.id); put("prev_state_id", prevId.takeIf { it > 0 }); put("new_state_id", stateId)
                    put("param_key", key); put("prev_value", prev[key]?.value); put("new_value", v.value)
                    put("event_wall", t.wall); put("event_elapsed", t.elapsed); put("boot_count", t.boot)
                    put("window_start_elapsed", windowStart); put("window_end_elapsed", t.elapsed)
                    put("detection_source", source); put("verification", v.src); put("evidence", evidence?.toString())
                })
            }
        }
        values = next
        live.reset()
        readBattery()?.let { persist(it, "config", t) }
    }

    private fun persist(r: BatteryReading, reason: String, t: Clock) {
        val s = active ?: return
        val bm = app.getSystemService(BatteryManager::class.java)
        val counter = validCounter(bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER))
        val current = validCurrent(bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW))
        val currentAvg = validCurrent(bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE))
        db.writableDatabase.insertOrThrow("sample", null, ContentValues().apply {
            put("session_id", s.id); put("wall_ms", t.wall); put("elapsed_ms", t.elapsed); put("boot_count", t.boot)
            put("level", r.level); put("scale", r.scale); put("status", r.status); put("plugged", r.plugged)
            put("health", r.health); put("temp_dc", r.tempDc); put("voltage_mv", r.voltageMv)
            put("charge_counter_uah", counter); put("current_now_raw", current); put("current_avg_raw", currentAvg)
            put("screen_on", screenOn?.let { if (it) 1 else 0 })
            put("brightness", runCatching { Settings.System.getInt(app.contentResolver, Settings.System.SCREEN_BRIGHTNESS) }.getOrNull())
            put("radio", radio)
            put("signal_level", runCatching { app.getSystemService(TelephonyManager::class.java).signalStrength?.level }.getOrNull())
            put("rx_bytes", TrafficStats.getTotalRxBytes()); put("tx_bytes", TrafficStats.getTotalTxBytes())
            if (r.plugged != 0) put("charge_eta_ms", runCatching { bm.computeChargeTimeRemaining() }.getOrNull())
            put("vendor_extras", lastVendorExtras)
            put("config_state_id", stateId.takeIf { it > 0 }); put("reason", reason)
            put("flags", SampleFlags.of(r, counter, current))
        })
        statRows++
        lastPersisted = r
        lastPersistClock = t
        if (s.status == "active") live.observe(t.elapsed, r.level, directionOf(r))
        notify(s, r)
        if (listeners.isNotEmpty()) {
            val msg = JSObject().put("sessionId", s.id).put("wall", t.wall).put("level", r.level)
                .put("status", r.status).put("plugged", r.plugged).put("reason", reason)
            listeners.forEach { it(msg) }
        }
    }

    /**
     * Charging sessions end at their target; draining sessions at their lower threshold. A charging
     * session that stays plugged in but not charging (e.g. Samsung battery protection at 80–95%)
     * ends as "held_at_limit" instead of running forever below an unreachable target.
     */
    private fun checkLimits(s: Active, r: BatteryReading, t: Clock) {
        if (active !== s || s.status != "active") return
        if (s.passive) {
            // One everyday session per calendar day: each day is one independent sample (§R2.9).
            val zone = java.time.ZoneId.systemDefault()
            val day = { ms: Long -> java.time.Instant.ofEpochMilli(ms).atZone(zone).toLocalDate() }
            if (day(t.wall) != day(s.startWall)) stop("rolled")
            return
        }
        val target = s.target
        val threshold = s.threshold
        val held = s.type == "charging" && r.plugged != 0 &&
            (r.status == BatteryManager.BATTERY_STATUS_NOT_CHARGING || r.status == BatteryManager.BATTERY_STATUS_FULL)
        if (!held) heldSinceElapsed = null else if (heldSinceElapsed == null) heldSinceElapsed = t.elapsed
        val heldFor = heldSinceElapsed?.let { t.elapsed - it } ?: 0L
        when {
            s.type == "charging" && heldFor >= HELD_LIMIT_MS && (target == null || r.level < target) ->
                stop("held_at_limit", JSONObject().put("level", r.level).put("held_ms", heldFor))
            s.type == "charging" && target != null && r.level >= target ->
                stop("target_reached", JSONObject().put("level", r.level))
            s.type == "draining" && threshold != null && r.level <= threshold ->
                stop("threshold_reached", JSONObject().put("level", r.level))
        }
    }

    // ------------------------------------------------------------------ helpers

    private var lastVendorExtras: String? = null
    private val VENDOR_KEYS = listOf(
        "hv_charger", "protection", "charge_type", "charger_type", "max_charging_current",
        "max_charging_voltage", "misc_event", "current_event", "online", "android.os.extra.CHARGING_STATUS",
    )

    private fun Intent.toReading(): BatteryReading? {
        val level = getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        if (level < 0) return null
        // Undocumented Samsung extras: kept verbatim as evidence only (R2.5), never as verified values.
        extras?.let { b ->
            val o = JSONObject()
            @Suppress("DEPRECATION")
            for (k in VENDOR_KEYS) if (b.containsKey(k)) o.put(k, b.get(k)?.toString())
            lastVendorExtras = o.toString()
        }
        return BatteryReading(
            level = level,
            scale = getIntExtra(BatteryManager.EXTRA_SCALE, 100),
            status = getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN),
            plugged = getIntExtra(BatteryManager.EXTRA_PLUGGED, 0),
            health = getIntExtra(BatteryManager.EXTRA_HEALTH, BatteryManager.BATTERY_HEALTH_UNKNOWN),
            tempDc = getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE),
            voltageMv = getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1),
        )
    }

    fun readBattery(): BatteryReading? =
        app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.toReading()

    private fun insertState(d: SQLiteDatabase, sessionId: String, t: Clock, v: Map<String, Value>): Long {
        val id = d.insertOrThrow("config_state", null, ContentValues().apply {
            put("session_id", sessionId); put("wall_ms", t.wall); put("elapsed_ms", t.elapsed); put("boot_count", t.boot)
        })
        for ((key, value) in v) {
            d.insertOrThrow("param_value", null, ContentValues().apply {
                put("config_state_id", id); put("param_key", key); put("value", value.value); put("src", value.src)
            })
        }
        return id
    }

    private fun insertEvent(d: SQLiteDatabase, sessionId: String, t: Clock, type: String, payload: JSONObject?) {
        d.insertOrThrow("event", null, ContentValues().apply {
            put("session_id", sessionId); put("wall_ms", t.wall); put("elapsed_ms", t.elapsed); put("boot_count", t.boot)
            put("type", type); put("payload", payload?.toString())
        })
    }

    /** Returns the current build's snapshot id, inserting it (and a build_changed event) when new. */
    private fun ensureBuildSnapshot(d: SQLiteDatabase, t: Clock, sessionId: String? = null): Long {
        d.rawQuery("SELECT id FROM build_snapshot WHERE fingerprint = ?", arrayOf(Build.FINGERPRINT)).use { c ->
            if (c.moveToFirst()) return c.getLong(0)
        }
        val id = d.insertOrThrow("build_snapshot", null, ContentValues().apply {
            put("fingerprint", Build.FINGERPRINT); put("display", Build.DISPLAY); put("sdk_int", Build.VERSION.SDK_INT)
            put("security_patch", Build.VERSION.SECURITY_PATCH); put("model", Build.MODEL); put("first_seen_wall", t.wall)
        })
        if (sessionId != null) insertEvent(d, sessionId, t, "build_changed", JSONObject().put("fingerprint", Build.FINGERPRINT))
        return id
    }

    private fun lastExitReason(): JSONObject? = runCatching {
        app.getSystemService(ActivityManager::class.java)
            .getHistoricalProcessExitReasons(app.packageName, 0, 1).firstOrNull()?.let {
                JSONObject().put("reason", it.reason).put("description", it.description).put("timestamp", it.timestamp)
            }
    }.getOrNull()

    private fun flushStats() {
        if (statBroadcasts == 0L && statRows == 0L) return
        db.writableDatabase.execSQL(
            """INSERT INTO overhead_stat (day, broadcasts, rows_written, handler_cpu_ns) VALUES (?, ?, ?, ?)
               ON CONFLICT(day) DO UPDATE SET broadcasts = broadcasts + excluded.broadcasts,
               rows_written = rows_written + excluded.rows_written, handler_cpu_ns = handler_cpu_ns + excluded.handler_cpu_ns""",
            arrayOf(LocalDate.now().toString(), statBroadcasts, statRows, statCpuNs),
        )
        statBroadcasts = 0; statRows = 0; statCpuNs = 0
    }

    /** Runs [block] on the executor and adds its thread CPU time to the overhead counters. */
    private inline fun measured(crossinline block: () -> Unit) = post {
        val start = Debug.threadCpuTimeNanos()
        try {
            block()
        } finally {
            statCpuNs += Debug.threadCpuTimeNanos() - start
        }
    }

    private fun directionOf(r: BatteryReading) = when (r.status) {
        BatteryManager.BATTERY_STATUS_CHARGING -> 1
        BatteryManager.BATTERY_STATUS_DISCHARGING -> -1
        else -> if (r.plugged == 0) -1 else 0
    }

    /** Where the live estimate counts to: the test's limit, or the always-on reserve / charge target. */
    private fun limitOf(s: Active, dir: Int): Int = when {
        s.passive && dir > 0 -> db.getSetting(SETTING_CHARGE_TARGET)?.toIntOrNull() ?: 100
        s.passive -> db.getSetting(SETTING_RESERVE)?.toIntOrNull() ?: 20
        s.type == "charging" -> s.target ?: 100
        else -> s.threshold ?: 0
    }

    /**
     * History for the current configuration, as computed by the UI's engine and stored under
     * [SETTING_PRIORS]: {"draining": {"keys": [...], "rates": {"k=v;…": {"rate": r, "steps": n}}}, "charging": …}.
     */
    private fun prior(dir: Int): Pair<Double, Int>? {
        val all = priorsCache ?: runCatching { JSONObject(db.getSetting(SETTING_PRIORS) ?: "{}") }.getOrNull()
            ?.also { priorsCache = it } ?: return null
        val side = all.optJSONObject(if (dir > 0) "charging" else "draining") ?: return null
        val keys = side.optJSONArray("keys") ?: return null
        val parts = (0 until keys.length()).map { keys.getString(it) }.sorted().map { k ->
            "$k=${values[k]?.value ?: return null}"
        }
        val r = side.optJSONObject("rates")?.optJSONObject(parts.joinToString(";")) ?: return null
        return r.optDouble("rate").takeIf { it > 0 }?.let { it to r.optInt("steps") }
    }

    /** Live rate: this configuration's history blended with the current run (display only). */
    private fun liveRate(dir: Int): Double? {
        val p = prior(dir)
        return LiveEstimator.blend(p?.first, p?.second ?: 0, live.ratePerHour(), live.steps)
    }

    private fun hoursTo(level: Int, limit: Int, dir: Int, rate: Double?): Double? {
        val points = (limit - level) * dir
        return if (rate != null && rate > 0 && points > 0) points / rate else null
    }

    /** Replays the current configuration's samples (this boot, since the last pause/resume) into the live estimator. */
    private fun rebuildLive(sessionId: String, t: Clock, gap: Boolean) {
        live.reset()
        if (gap || active?.status != "active") return
        val since = db.queryOne(
            "SELECT MAX(elapsed_ms) AS e FROM event WHERE session_id = ? AND boot_count = ? AND type IN ('pause','resume')",
            sessionId, t.boot.toString(),
        )?.optLong("e") ?: 0L
        val rows = db.queryJson(
            "SELECT elapsed_ms, level, status, plugged FROM sample WHERE session_id = ? AND config_state_id = ? " +
                "AND boot_count = ? AND elapsed_ms >= ? ORDER BY id",
            sessionId, stateId.toString(), t.boot.toString(), since.toString(),
        )
        for (i in 0 until rows.length()) {
            val o = rows.getJSONObject(i)
            val r = BatteryReading(o.getInt("level"), 100, o.getInt("status"), o.getInt("plugged"), 0, 0, 0)
            live.observe(o.getLong("elapsed_ms"), r.level, directionOf(r))
        }
    }

    private fun notify(s: Active, r: BatteryReading) {
        val svc = service ?: return
        svc.updateNotification(liveSummary(s, r), s.status == "paused", s.startWall)
    }

    data class Notice(val title: String, val text: String, val details: String)

    /** Notification content: expected time to the limit plus the measured rate it comes from, nothing else. */
    private fun liveSummary(s: Active, r: BatteryReading): Notice {
        val dir = directionOf(r)
        val limit = limitOf(s, dir)
        val wanted = if (s.passive) dir else if (s.type == "charging") 1 else -1
        val title = if (s.passive) "Always-on · ${r.level}%"
            else "${if (s.type == "charging") "Charging" else "Draining"} test · ${r.level}%"
        val lines = mutableListOf<String>()
        val text = when {
            s.status == "paused" -> "Paused, not counted"
            dir == 0 -> if (s.passive) "Plugged in, not charging" else "Plugged in but not charging, not counted"
            dir != wanted -> if (s.type == "charging") "Unplugged, interruption not counted" else "Charging, interruption not counted"
            else -> {
                val rate = liveRate(dir)
                val hours = hoursTo(r.level, limit, dir, rate)
                val hasHistory = prior(dir) != null
                if (hours != null) {
                    lines += if (dir < 0) "Recharge around ${clockIn(hours)}" else "Reaches $limit% around ${clockIn(hours)}"
                }
                when {
                    rate == null -> "Measuring… waiting for the next 1% change"
                    hours == null -> "%.1f %%/h".format(rate)
                    live.steps < LiveEstimator.MIN_STEPS_MEASURED && !hasHistory -> "Early estimate ≈ ${duration(hours)} to $limit%"
                    else -> "≈ ${duration(hours)} to $limit% · " + "%.1f %%/h".format(rate)
                }
            }
        }
        return Notice(title, text, (listOf(text) + lines).joinToString("\n"))
    }

    private fun configSummary(s: Active): String = s.tracked.map { key ->
        val v = values[key]?.value ?: return@map "${key.replace('_', ' ')} ?"
        when (key) {
            "network_mode" -> v.uppercase()
            "mobile_data" -> "data $v"
            "power_saving" -> "power saving $v"
            "perf_profile" -> v
            else -> "${key.replace('_', ' ')} $v"
        }
    }.joinToString(" · ")

    private fun duration(hours: Double): String {
        val m = (hours * 60).toLong().coerceAtLeast(0)
        return if (m >= 60) "${m / 60} h ${m % 60} m" else "$m m"
    }

    /** Clock time [hours] from now, in the phone's own 12/24-hour format. */
    private fun clockIn(hours: Double): String =
        android.text.format.DateFormat.getTimeFormat(app).format(java.util.Date(System.currentTimeMillis() + (hours * 3_600_000).toLong()))

    private fun notifyFinished(row: JSObject) {
        val nm = app.getSystemService(android.app.NotificationManager::class.java)
        nm.createNotificationChannel(
            android.app.NotificationChannel(RESULTS_CHANNEL, "Test results", android.app.NotificationManager.IMPORTANCE_DEFAULT),
        )
        val type = row.getString("type") ?: "?"
        val startLevel = row.optInt("start_level")
        val endLevel = row.optInt("end_level")
        val took = duration((row.optLong("end_wall") - row.optLong("start_wall")) / 3_600_000.0)
        val title = when (row.getString("status")) {
            "held_at_limit" -> "Charging stopped at $endLevel% (battery protection)"
            "target_reached" -> "Charging test finished"
            else -> "Draining test finished"
        }
        val open = android.app.PendingIntent.getActivity(
            app, row.getString("id").hashCode(),
            Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_OPEN, "session:${row.getString("id")}"),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = "${type.replaceFirstChar { it.uppercase() }} $startLevel% → $endLevel% took $took"
        nm.notify(row.getString("id").hashCode(), android.app.Notification.Builder(app, RESULTS_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_monitor)
            .setColor(0xFF4565BC.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build())
    }

    /** Live indicator for the Test screen (same numbers as the notification). */
    fun liveJson(): JSObject? {
        val s = active ?: return null
        val r = readBattery() ?: lastPersisted ?: return null
        val bm = app.getSystemService(BatteryManager::class.java)
        val counter = validCounter(bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER))
        val current = validCurrent(bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE))
        val dir = directionOf(r)
        val limit = limitOf(s, dir)
        val instant = LiveEstimator.instantHours(counter, current, r.level, limit, dir)
        val notice = liveSummary(s, r)
        val rate = liveRate(dir)
        val p = prior(dir)
        return JSObject().apply {
            put("limit", limit)
            put("direction", dir)
            put("steps", live.steps)
            put("ratePerHour", rate ?: JSONObject.NULL)
            put("runRatePerHour", live.ratePerHour() ?: JSONObject.NULL)
            put("hoursToLimit", hoursTo(r.level, limit, dir, rate) ?: JSONObject.NULL)
            put("measured", live.steps >= LiveEstimator.MIN_STEPS_MEASURED || p != null)
            put("historyRate", p?.first ?: JSONObject.NULL)
            put("historySteps", p?.second ?: 0)
            put("passive", s.passive)
            put("instantMa", instant?.first ?: JSONObject.NULL)
            put("instantHours", instant?.second ?: JSONObject.NULL)
            put("summary", notice.text)
            put("config", configSummary(s))
        }
    }

    fun sessionJson(id: String): JSObject = db.queryOne("SELECT * FROM session WHERE id = ?", id) ?: JSObject()

    fun currentValuesJson(): JSObject = JSObject().also { o ->
        values.forEach { (k, v) -> o.put(k, JSObject().put("value", v.value ?: JSONObject.NULL).put("src", v.src)) }
    }

    fun activeSessionId(): String? = active?.id

    fun currentRadio(): String? = radio

    private fun appVersion(): String =
        runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "?"

    private fun JSONObject.optIntOrNull(key: String): Int? = if (isNull(key)) null else optInt(key)
}
