const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDatabase(){
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            email TEXT DEFAULT '',
            is_admin BOOLEAN DEFAULT false,
            last_change TEXT DEFAULT ''
        )
    `);

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_change TEXT DEFAULT ''`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS projects (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            current_user_name TEXT DEFAULT '',
            current_task TEXT DEFAULT ''
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tasks (
            id SERIAL PRIMARY KEY,
            project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            archived BOOLEAN DEFAULT false
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS times (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            project TEXT NOT NULL,
            task TEXT NOT NULL,
            start_time TEXT NOT NULL,
            stop_time TEXT DEFAULT '',
            report TEXT DEFAULT '',
            admin_only BOOLEAN DEFAULT false,
            pause_time TEXT DEFAULT '',
            is_paused BOOLEAN DEFAULT false
        )
    `);

    await pool.query(`ALTER TABLE times ADD COLUMN IF NOT EXISTS pause_time TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE times ADD COLUMN IF NOT EXISTS is_paused BOOLEAN DEFAULT false`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            sender TEXT NOT NULL,
            receiver TEXT NOT NULL,
            text TEXT NOT NULL,
            date TEXT NOT NULL,
            is_read BOOLEAN DEFAULT false
        )
    `);