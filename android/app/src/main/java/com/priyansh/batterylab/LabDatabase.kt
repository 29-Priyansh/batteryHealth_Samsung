package com.priyansh.batterylab

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

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
        )

        @Volatile private var instance: LabDatabase? = null

        fun get(context: Context): LabDatabase =
            instance ?: synchronized(this) {
                instance ?: LabDatabase(context.applicationContext).also { instance = it }
            }
    }
}
