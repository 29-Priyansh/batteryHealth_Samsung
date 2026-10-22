package com.priyansh.batterylab

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject

fun Cursor.rowJson(): JSObject = JSObject().also { o ->
    for (i in 0 until columnCount) {
        val name = getColumnName(i)
        when (getType(i)) {
            Cursor.FIELD_TYPE_NULL -> o.put(name, JSONObject.NULL)
            Cursor.FIELD_TYPE_INTEGER -> o.put(name, getLong(i))
            Cursor.FIELD_TYPE_FLOAT -> o.put(name, getDouble(i))
            else -> o.put(name, getString(i))
        }
    }
}

/**
 * Framework SQLite store (no Room). Each schema version is an ordered migration step;
 * never edit a released step, append a new one. See docs/PLAN.md §5 and Revision 2.
 */
class LabDatabase private constructor(context: Context) :
    SQLiteOpenHelper(context, NAME, null, MIGRATIONS.size) {

    override fun onConfigure(db: SQLiteDatabase) {
        db.enableWriteAheadLogging()
        db.setForeignKeyConstraintsEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) = migrate(db, 0, MIGRATIONS.size)

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = migrate(db, oldVersion, newVersion)

    private fun migrate(db: SQLiteDatabase, from: Int, to: Int) {
        for (v in from until to) MIGRATIONS[v].forEach(db::execSQL)
    }

    fun <T> tx(block: (SQLiteDatabase) -> T): T {
        val db = writableDatabase
        db.beginTransaction()
        try {
            return block(db).also { db.setTransactionSuccessful() }
        } finally {
            db.endTransaction()
        }
    }

    fun queryJson(sql: String, vararg args: String): JSArray =
        readableDatabase.rawQuery(sql, args).use { c ->
            JSArray().apply { while (c.moveToNext()) put(c.rowJson()) }
        }

    fun queryOne(sql: String, vararg args: String): JSObject? =
        readableDatabase.rawQuery(sql, args).use { c -> if (c.moveToFirst()) c.rowJson() else null }

    fun getSetting(key: String): String? =
        readableDatabase.rawQuery("SELECT value FROM setting WHERE key = ?", arrayOf(key)).use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    fun setSetting(key: String, value: String) {
        writableDatabase.insertWithOnConflict(
            "setting", null,
            ContentValues().apply { put("key", key); put("value", value) },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    companion object {
        private const val NAME = "batterylab.db"

        /** MIGRATIONS[i] upgrades schema version i to i+1. */
        private val MIGRATIONS: List<List<String>> = listOf(
            listOf("CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
            // v2: recorder (M2). Raw tables are append-only apart from session status/end fields.
            listOf(
                """CREATE TABLE build_snapshot (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE, display TEXT,
                    sdk_int INTEGER, security_patch TEXT, model TEXT, first_seen_wall INTEGER NOT NULL)""",
                """CREATE TABLE session (
                    id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('charging','draining')),
                    status TEXT NOT NULL, start_wall INTEGER NOT NULL, start_elapsed INTEGER NOT NULL,
                    start_boot INTEGER NOT NULL, end_wall INTEGER, end_elapsed INTEGER, end_boot INTEGER,
                    start_level INTEGER, end_level INTEGER, target_level INTEGER, lower_threshold INTEGER,
                    tracked_params TEXT NOT NULL, conditions TEXT, notes TEXT,
                    build_snapshot_id INTEGER REFERENCES build_snapshot(id), app_version TEXT)""",
                """CREATE TABLE config_state (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                    wall_ms INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, boot_count INTEGER NOT NULL)""",
                """CREATE TABLE param_value (
                    config_state_id INTEGER NOT NULL REFERENCES config_state(id) ON DELETE CASCADE,
                    param_key TEXT NOT NULL, value TEXT, src TEXT NOT NULL,
                    PRIMARY KEY (config_state_id, param_key))""",
                """CREATE TABLE config_change (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                    prev_state_id INTEGER REFERENCES config_state(id), new_state_id INTEGER NOT NULL REFERENCES config_state(id),
                    param_key TEXT NOT NULL, prev_value TEXT, new_value TEXT,
                    event_wall INTEGER NOT NULL, event_elapsed INTEGER NOT NULL, boot_count INTEGER NOT NULL,
                    window_start_elapsed INTEGER NOT NULL, window_end_elapsed INTEGER NOT NULL,
                    detection_source TEXT NOT NULL, verification TEXT NOT NULL, evidence TEXT)""",
                """CREATE TABLE sample (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                    wall_ms INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, boot_count INTEGER NOT NULL,
                    level INTEGER NOT NULL, scale INTEGER NOT NULL, status INTEGER NOT NULL, plugged INTEGER NOT NULL,
                    health INTEGER, temp_dc INTEGER, voltage_mv INTEGER,
                    charge_counter_uah INTEGER, current_now_raw INTEGER, current_avg_raw INTEGER,
                    screen_on INTEGER, brightness INTEGER, radio TEXT, signal_level INTEGER,
                    rx_bytes INTEGER, tx_bytes INTEGER, charge_eta_ms INTEGER, vendor_extras TEXT,
                    config_state_id INTEGER REFERENCES config_state(id), reason TEXT NOT NULL,
                    flags INTEGER NOT NULL DEFAULT 0)""",
                """CREATE TABLE event (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                    wall_ms INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, boot_count INTEGER NOT NULL,
                    type TEXT NOT NULL, payload TEXT)""",
                """CREATE TABLE overhead_stat (
                    day TEXT PRIMARY KEY, broadcasts INTEGER NOT NULL DEFAULT 0,
                    rows_written INTEGER NOT NULL DEFAULT 0, handler_cpu_ns INTEGER NOT NULL DEFAULT 0)""",
                "CREATE INDEX sample_session_time ON sample (session_id, boot_count, elapsed_ms)",
                "CREATE INDEX event_session_time ON event (session_id, elapsed_ms)",
                "CREATE INDEX config_state_session ON config_state (session_id, elapsed_ms)",
                "CREATE INDEX config_change_session ON config_change (session_id, event_elapsed)",
                "CREATE INDEX session_type_start ON session (type, start_wall)",
            ),
            // v3: always-on recording. 'test' = user-started test; 'passive' = everyday recording, one per day.
            listOf("ALTER TABLE session ADD COLUMN mode TEXT NOT NULL DEFAULT 'test'"),
        )

        @Volatile private var instance: LabDatabase? = null

        fun get(context: Context): LabDatabase =
            instance ?: synchronized(this) {
                instance ?: LabDatabase(context.applicationContext).also { instance = it }
            }
    }
}
