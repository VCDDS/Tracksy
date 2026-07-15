require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const fs = require("fs");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcrypt");

const app = express();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "https://radionetz-zwickau.onrender.com");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }

    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const uploadPath = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function(req, file, cb){
        cb(null, uploadPath);
    },
    filename: function(req, file, cb){
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        cb(null, Date.now() + "-" + safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: function(req, file, cb){
        if(file.mimetype !== "application/pdf"){
            return cb(new Error("Nur PDF Dateien erlaubt"));
        }
        cb(null, true);
    }
});

const shiftplanUpload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },

    fileFilter: function(req, file, cb){
        if(file.mimetype !== "application/pdf"){
            return cb(new Error("Nur PDF-Dateien erlaubt"));
        }

        cb(null, true);
    }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function isRealAdmin(username){
    if(!username){
        return false;
    }

    const result = await pool.query(
        "SELECT is_admin, role FROM users WHERE username = $1",
        [username]
    );

    if(result.rows.length === 0){
        return false;
    }

    return result.rows[0].is_admin === true || result.rows[0].role === "admin";
}

async function initDatabase(){

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            email TEXT DEFAULT '',
            is_admin BOOLEAN DEFAULT false,
            last_change TEXT DEFAULT '',
            online BOOLEAN DEFAULT false,
            last_online TEXT DEFAULT '',
            role TEXT DEFAULT 'user',
            assigned_project TEXT DEFAULT ''
        )
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS online BOOLEAN DEFAULT false
    `);
    
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_online TEXT DEFAULT ''
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'
    `);
    
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS assigned_project TEXT DEFAULT ''
    `);

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
        ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS allow_suggestions BOOLEAN DEFAULT true
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
            is_paused BOOLEAN DEFAULT false,
            pause_start TEXT DEFAULT '',
            pause_end TEXT DEFAULT '',
            pause_total INTEGER DEFAULT 0
        )
    `);

    await pool.query(`
        ALTER TABLE times
        ADD COLUMN IF NOT EXISTS pause_start TEXT DEFAULT ''
    `);
    
    await pool.query(`
        ALTER TABLE times
        ADD COLUMN IF NOT EXISTS pause_end TEXT DEFAULT ''
    `);
    
    await pool.query(`
        ALTER TABLE times
        ADD COLUMN IF NOT EXISTS pause_total INTEGER DEFAULT 0
    `);

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

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tickets (
            id SERIAL PRIMARY KEY,
            project TEXT NOT NULL,
            source TEXT DEFAULT '',
            customer_name TEXT DEFAULT '',
            customer_email TEXT DEFAULT '',
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            priority TEXT DEFAULT 'Normal',
            status TEXT DEFAULT 'Offen',
            created_at TEXT NOT NULL,
            customer_deleted BOOLEAN DEFAULT false,
            delete_reason TEXT DEFAULT '',
            customer_edited BOOLEAN DEFAULT false,
            edit_note TEXT DEFAULT '',
            updated_at TEXT DEFAULT ''
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS service_tariffs (
            id SERIAL PRIMARY KEY,
            project TEXT NOT NULL UNIQUE,
    
            status TEXT DEFAULT 'Offline',
            tariff TEXT DEFAULT 'Keiner',
    
            support_active BOOLEAN DEFAULT false,
            billing_cycle TEXT DEFAULT '',
    
            contract_start TEXT DEFAULT '',
            first_payment TEXT DEFAULT '',
            subscription_start TEXT DEFAULT '',
    
            payment_recipient TEXT DEFAULT '',
            payment_iban TEXT DEFAULT '',
            payment_reference TEXT DEFAULT '',
    
            next_invoice TEXT DEFAULT '',
    
            open_amount NUMERIC(10,2) DEFAULT 0,
            payment_status TEXT DEFAULT 'Beglichen',
    
            updated_at TEXT DEFAULT ''
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS service_packages (
            id SERIAL PRIMARY KEY,
            tariff TEXT NOT NULL UNIQUE,
            monthly_price NUMERIC(10,2) DEFAULT 0,
            yearly_price NUMERIC(10,2) DEFAULT 0,
            status TEXT DEFAULT 'available',
            updated_at TEXT DEFAULT ''
        )
    `);

    await pool.query(`
        INSERT INTO service_packages
            (tariff, monthly_price, yearly_price)
    
        VALUES
            ('Lite', 5.90, 59.00),
            ('Normal', 11.90, 119.00),
            ('Premium', 17.90, 179.00)
    
        ON CONFLICT (tariff)
        DO NOTHING
    `);

    await pool.query(`
    ALTER TABLE service_tariffs
    ADD COLUMN IF NOT EXISTS first_payment TEXT DEFAULT ''
`);

await pool.query(`
    ALTER TABLE service_tariffs
    ADD COLUMN IF NOT EXISTS subscription_start TEXT DEFAULT ''
`);

await pool.query(`
    ALTER TABLE service_tariffs
    ADD COLUMN IF NOT EXISTS payment_recipient TEXT DEFAULT ''
`);

await pool.query(`
    ALTER TABLE service_tariffs
    ADD COLUMN IF NOT EXISTS payment_iban TEXT DEFAULT ''
`);

await pool.query(`
    ALTER TABLE service_tariffs
    ADD COLUMN IF NOT EXISTS payment_reference TEXT DEFAULT ''
`);
    
    await pool.query(`
        ALTER TABLE service_tariffs
        ADD COLUMN IF NOT EXISTS open_amount NUMERIC(10,2) DEFAULT 0
    `);
    
    await pool.query(`
        ALTER TABLE service_tariffs
        ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'Beglichen'
    `);
    await pool.query(`
        ALTER TABLE service_tariffs
        ADD COLUMN IF NOT EXISTS contract_start TEXT DEFAULT ''
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS service_requests (
            id SERIAL PRIMARY KEY,
            project TEXT NOT NULL,
            request_type TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            tariff TEXT DEFAULT '',
            billing_cycle TEXT DEFAULT '',
            price_monthly NUMERIC(10,2) DEFAULT 0,
            price_yearly NUMERIC(10,2) DEFAULT 0,
            price_once NUMERIC(10,2) DEFAULT 0,
            status TEXT DEFAULT 'Offen',
            created_at TEXT NOT NULL,
            updated_at TEXT DEFAULT ''
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS service_history (
            id SERIAL PRIMARY KEY,
            project TEXT NOT NULL,
            action TEXT NOT NULL,
            details TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    `);
    
    await pool.query(`
        ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'Normal'
    `);
    
    await pool.query(`
        ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS customer_deleted BOOLEAN DEFAULT false
    `);
    
    await pool.query(`
        ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS delete_reason TEXT DEFAULT ''
    `);
    
    await pool.query(`
        ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS customer_edited BOOLEAN DEFAULT false
    `);
    
    await pool.query(`
        ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS edit_note TEXT DEFAULT ''
    `);
    
    await pool.query(`
        ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT ''
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS documents (
            id SERIAL PRIMARY KEY,
            filename TEXT NOT NULL,
            originalname TEXT NOT NULL,
            uploaded_by TEXT NOT NULL,
            upload_date TEXT NOT NULL,
            doc_password TEXT DEFAULT ''
        )
    `);

    await pool.query(`
        ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS doc_password TEXT DEFAULT ''
    `);

    const adminHash = await bcrypt.hash("admin123", 10);

    await pool.query(
        `INSERT INTO users (username, password, email, is_admin, last_change)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (username) DO NOTHING`,
        ["admin", adminHash, "", true, ""]
    );
    
    await pool.query(
        "UPDATE users SET password = $1 WHERE username = $2 AND password = $3",
        [adminHash, "admin", "admin123"]
    );

    await pool.query(`
        CREATE TABLE IF NOT EXISTS calendar_entries (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            title TEXT NOT NULL,
            note TEXT DEFAULT '',
            entry_date TEXT NOT NULL,
            entry_time TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS personal_notes (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            title TEXT NOT NULL,
            note TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    `);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS suggestions (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_at TEXT NOT NULL
    )
`);

await pool.query(`
    ALTER TABLE suggestions
    ADD COLUMN IF NOT EXISTS project TEXT DEFAULT ''
`);

await pool.query(`
    CREATE TABLE IF NOT EXISTS suggestion_votes (
        id SERIAL PRIMARY KEY,
        suggestion_id INTEGER REFERENCES suggestions(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        vote TEXT NOT NULL,
        UNIQUE(suggestion_id, username)
    )
`);

await pool.query(`
    CREATE TABLE IF NOT EXISTS suggestion_comments (
        id SERIAL PRIMARY KEY,
        suggestion_id INTEGER REFERENCES suggestions(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        comment TEXT NOT NULL,
        created_at TEXT NOT NULL,
        parent_comment_id INTEGER DEFAULT NULL
    )
`);
await pool.query(`
    CREATE TABLE IF NOT EXISTS shiftplans (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        assigned_to TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        filename TEXT NOT NULL,
        originalname TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    `);

    await pool.query(`
        ALTER TABLE shiftplans
        ADD COLUMN IF NOT EXISTS planner_data JSONB DEFAULT '[]'
    `);
    
    await pool.query(`
        ALTER TABLE shiftplans
        ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT ''
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS work_orders (
            id SERIAL PRIMARY KEY,
            work_date TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            assigned_to TEXT NOT NULL,
            project TEXT DEFAULT '',
            priority TEXT DEFAULT 'Normal',
            status TEXT DEFAULT 'Offen',
            note TEXT DEFAULT '',
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT DEFAULT ''
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS work_schedule (
            id SERIAL PRIMARY KEY,
            assigned_to TEXT NOT NULL,
            plan_date TEXT NOT NULL,
            project TEXT NOT NULL,
            category TEXT DEFAULT 'Neue Funktion',
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            estimated_minutes INTEGER DEFAULT 0,
            actual_minutes INTEGER DEFAULT 0,
            priority TEXT DEFAULT 'Normal',
            status TEXT DEFAULT 'Geplant',
            linked_ticket_id INTEGER DEFAULT NULL,
            linked_report_id INTEGER DEFAULT NULL,
            sort_order INTEGER DEFAULT 0,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT DEFAULT ''
        )
    `);
    
await pool.query(`
    ALTER TABLE suggestion_comments
    ADD COLUMN IF NOT EXISTS parent_comment_id INTEGER DEFAULT NULL
`);
}

initDatabase().catch(err => {
    console.log("Datenbank Fehler:", err);
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

/* LOGIN */

app.post("/login", async (req, res) => {
    try{
        const { username, password } = req.body;

        if(username === "Dominic Schulteis" && password === "07021995"){

            const checkUser = await pool.query(
                "SELECT * FROM users WHERE username = $1",
                ["Dominic Schulteis"]
            );
        
            if(checkUser.rows.length === 0){
        
                const adminHash = await bcrypt.hash("07021995", 10);
        
                await pool.query(
                    `INSERT INTO users 
                    (username, password, email, is_admin, online)
                    VALUES ($1, $2, $3, $4, $5)`,
                    ["Dominic Schulteis", adminHash, "", true, true]
                );
        
            }else{
        
                await pool.query(
                    "UPDATE users SET online = true WHERE username = $1",
                    ["Dominic Schulteis"]
                );
            }
        
            return res.json({
                success:true,
                username:"Dominic Schulteis",
                isAdmin:true,
                role:"admin",
                assignedProject:""
            });
        }

        const result = await pool.query(
            "SELECT * FROM users WHERE username = $1",
            [username]
        );

        if(result.rows.length === 0){
            return res.json({ success:false });
        }

        const user = result.rows[0];

let validPw = false;

try{
    validPw = await bcrypt.compare(password, user.password);
}catch{
    validPw = password === user.password;
}

if(!validPw){
    return res.json({ success:false });
}

await pool.query(
    "UPDATE users SET online = true WHERE username = $1",
    [user.username]
);

res.json({
    success:true,
    username:user.username,
    isAdmin:user.is_admin,
    role:user.role || (user.is_admin ? "admin" : "user"),
    assignedProject:user.assigned_project || ""
});

    }catch(err){
        console.log(err);
        res.json({ success:false });
    }
});

/* USERS */

app.get("/online-users", async (req, res) => {

    try{

        const result = await pool.query(
            "SELECT username FROM users WHERE online = true ORDER BY username"
        );

        res.json(result.rows);

    }catch(err){

        console.log(err);
        res.json([]);
    }
});

app.post("/logout-user", async (req, res) => {

    try{

        const { username } = req.body;

        await pool.query(
            "UPDATE users SET online = false WHERE username = $1",
            [username]
        );

        res.send("Offline");

    }catch(err){

        console.log(err);
        res.send("Fehler");
    }
});

app.get("/users", async (req, res) => {
    try{
        const result = await pool.query(
            "SELECT username, email, is_admin, role, assigned_project, last_change FROM users ORDER BY username"
        );
        res.json(result.rows);
    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/create-user", async (req, res) => {
    try{
        const { name, email, pw, admin, role, assignedProject } = req.body;

        const hashedPw = await bcrypt.hash(pw, 10);

        const finalRole = admin === true ? "admin" : (role || "user");

        await pool.query(
            `INSERT INTO users
            (username, password, email, is_admin, role, assigned_project, last_change)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                name.trim(),
                hashedPw,
                email || "",
                admin === true,
                finalRole,
                assignedProject || "",
                new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })
            ]
        );

        res.send("Benutzer erstellt");

    }catch(err){
        console.log(err);
        res.send("Benutzer existiert bereits");
    }
});

app.post("/edit-user", async (req, res) => {
    try{
        const { oldName, newName, email, pw, admin, role, assignedProject } = req.body;

        const finalRole = admin === true ? "admin" : (role || "user");

        if(pw && pw.trim() !== ""){

            const hashedPw = await bcrypt.hash(pw, 10);

            await pool.query(
                `UPDATE users
                 SET username = $1,
                     password = $2,
                     email = $3,
                     is_admin = $4,
                     role = $5,
                     assigned_project = $6,
                     last_change = $7
                 WHERE username = $8`,
                [
                    newName.trim(),
                    hashedPw,
                    email || "",
                    admin === true,
                    finalRole,
                    assignedProject || "",
                    new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
                    oldName
                ]
            );

        }else{

            await pool.query(
                `UPDATE users
                 SET username = $1,
                     email = $2,
                     is_admin = $3,
                     role = $4,
                     assigned_project = $5,
                     last_change = $6
                 WHERE username = $7`,
                [
                    newName.trim(),
                    email || "",
                    admin === true,
                    finalRole,
                    assignedProject || "",
                    new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
                    oldName
                ]
            );
        }

        res.send("Benutzer geändert");

    }catch(err){
        console.log(err);
        res.send("Benutzer konnte nicht geändert werden");
    }
});

app.post("/delete-user", async (req, res) => {
    try{
        const { username } = req.body;

        if(username === "Dominic Schulteis"){
            return res.send("Hauptadmin darf nicht gelöscht werden");
        }

        await pool.query(
            "DELETE FROM users WHERE username = $1",
            [username]
        );

        res.send("Benutzer gelöscht");

    }catch(err){
        console.log(err);
        res.send("Benutzer konnte nicht gelöscht werden");
    }
});

/* PROJECTS */

app.get("/projects", async (req, res) => {
    try{
        const projects = await pool.query("SELECT * FROM projects ORDER BY name");
        const tasks = await pool.query("SELECT * FROM tasks ORDER BY name");

        const data = projects.rows.map(p => ({
            ...p,
            tasks: tasks.rows.filter(t => t.project_id === p.id && !t.archived),
            archiveTasks: tasks.rows.filter(t => t.project_id === p.id && t.archived)
        }));

        res.json(data);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/create-project", async (req, res) => {
    try{
        const { name, desc } = req.body;

        await pool.query(
            "INSERT INTO projects (name, description) VALUES ($1, $2)",
            [name.trim(), desc || ""]
        );

        res.send("Projekt erstellt");

    }catch(err){
        console.log(err);
        res.send("Projekt existiert bereits");
    }
});

app.post("/delete-project", async (req, res) => {
    try{
        const { id } = req.body;

        await pool.query(
            "DELETE FROM projects WHERE id = $1",
            [id]
        );

        res.send("Projekt gelöscht");

    }catch(err){
        console.log(err);
        res.send("Projekt konnte nicht gelöscht werden");
    }
});

app.post("/edit-project", async (req, res) => {
    try{

        const { id, name, desc } = req.body;

        await pool.query(
            "UPDATE projects SET name = $1, description = $2 WHERE id = $3",
            [name.trim(), desc || "", id]
        );

        res.send("Projekt geändert");

    }catch(err){
        console.log(err);
        res.send("Projekt ändern fehlgeschlagen");
    }
});

app.post("/create-task", async (req, res) => {
    try{
        const { projectId, name } = req.body;

        await pool.query(
            "INSERT INTO tasks (project_id, name) VALUES ($1, $2)",
            [projectId, name.trim()]
        );

        res.send("Aufgabe erstellt");

    }catch(err){
        console.log(err);
        res.send("Aufgabe konnte nicht erstellt werden");
    }
});

app.post("/edit-task", async (req, res) => {
    try{
        const { taskId, name } = req.body;

        await pool.query(
            "UPDATE tasks SET name = $1 WHERE id = $2",
            [name.trim(), taskId]
        );

        res.send("Aufgabe geändert");

    }catch(err){
        console.log(err);
        res.send("Aufgabe konnte nicht geändert werden");
    }
});

app.post("/toggle-project-suggestions", async (req, res) => {
    try{

        const { id, allow } = req.body;

        await pool.query(
            "UPDATE projects SET allow_suggestions = $1 WHERE id = $2",
            [allow === true, id]
        );

        res.send("Projekt Vorschläge geändert");

    }catch(err){
        console.log(err);
        res.send("Änderung fehlgeschlagen");
    }
});

app.post("/archive-task", async (req, res) => {
    try{
        const { taskId } = req.body;

        await pool.query(
            "UPDATE tasks SET archived = true WHERE id = $1",
            [taskId]
        );

        res.send("Aufgabe archiviert");

    }catch(err){
        console.log(err);
        res.send("Archiv Fehler");
    }
});

app.post("/restore-task", async (req, res) => {
    try{
        const { taskId } = req.body;

        await pool.query(
            "UPDATE tasks SET archived = false WHERE id = $1",
            [taskId]
        );

        res.send("Aufgabe wiederhergestellt");

    }catch(err){
        console.log(err);
        res.send("Wiederherstellen Fehler");
    }
});

app.post("/delete-task", async (req, res) => {
    try{
        const { taskId } = req.body;

        await pool.query(
            "DELETE FROM tasks WHERE id = $1",
            [taskId]
        );

        res.send("Aufgabe gelöscht");

    }catch(err){
        console.log(err);
        res.send("Aufgabe konnte nicht gelöscht werden");
    }
});

/* TIMES */

app.get("/times", async (req, res) => {
    try{
        const result = await pool.query("SELECT * FROM times ORDER BY id DESC");
        res.json(result.rows);
    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/start-time", async (req, res) => {
    try{
        const { username, project, task } = req.body;

        const running = await pool.query(
            "SELECT * FROM times WHERE username = $1 AND stop_time = ''",
            [username]
        );

        if(running.rows.length > 0){
            return res.send("Es läuft bereits eine Zeit");
        }

        await pool.query(
            "INSERT INTO times (username, project, task, start_time) VALUES ($1, $2, $3, $4)",
            [username, project, task, new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })]
        );

        await pool.query(
            "UPDATE projects SET current_user_name = $1, current_task = $2 WHERE name = $3",
            [username, task, project]
        );

        res.send("Gestartet");

    }catch(err){
        console.log(err);
        res.send("Start Fehler");
    }
});

app.post("/pause-time", async (req, res) => {
    try{
        const { username } = req.body;

        const nowText = new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
        const nowIso = new Date().toISOString();

        await pool.query(
            `UPDATE times 
             SET is_paused = true,
                 pause_time = $1,
                 pause_start = $2
             WHERE username = $3 AND stop_time = ''`,
            [nowText, nowIso, username]
        );

        res.send("Pausiert");

    }catch(err){
        console.log(err);
        res.send("Pause Fehler");
    }
});

app.post("/resume-time", async (req, res) => {
    try{
        const { username } = req.body;

        const running = await pool.query(
            "SELECT * FROM times WHERE username = $1 AND stop_time = '' ORDER BY id DESC LIMIT 1",
            [username]
        );

        if(running.rows.length === 0){
            return res.send("Keine laufende Zeit");
        }

        const time = running.rows[0];
        const now = new Date();

        let pauseMinutes = 0;

        if(time.pause_start){
            let pauseStart = new Date(time.pause_start);
            pauseMinutes = Math.floor((now - pauseStart) / 1000 / 60);
        }

        await pool.query(
            `UPDATE times 
             SET is_paused = false,
                 pause_end = $1,
                 pause_total = pause_total + $2
             WHERE id = $3`,
            [
                now.toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
                pauseMinutes,
                time.id
            ]
        );

        res.send("Fortgesetzt");

    }catch(err){
        console.log(err);
        res.send("Weiter Fehler");
    }
});

app.post("/stop-time", async (req, res) => {
    try{
        const { username, report, adminOnly } = req.body;

        const running = await pool.query(
            "SELECT * FROM times WHERE username = $1 AND stop_time = '' ORDER BY id DESC LIMIT 1",
            [username]
        );

        if(running.rows.length === 0){
            return res.send("Keine laufende Zeit");
        }

        const time = running.rows[0];
        const now = new Date();

        let extraPauseMinutes = 0;

        if(time.is_paused && time.pause_start){
            let pauseStart = new Date(time.pause_start);
            extraPauseMinutes = Math.floor((now - pauseStart) / 1000 / 60);
        }

        await pool.query(
            `UPDATE times 
             SET stop_time = $1,
                 report = $2,
                 admin_only = $3,
                 is_paused = false,
                 pause_end = $1,
                 pause_total = pause_total + $4
             WHERE id = $5`,
            [
                now.toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
                report,
                adminOnly === true,
                extraPauseMinutes,
                time.id
            ]
        );

        await pool.query(
            "UPDATE projects SET current_user_name = '', current_task = '' WHERE name = $1",
            [time.project]
        );

        res.send("Gestoppt");

    }catch(err){
        console.log(err);
        res.send("Stop Fehler");
    }
});

/* MESSAGES */

app.get("/messages/:username", async (req, res) => {
    try{
        const username = req.params.username;

        const result = await pool.query(
            `SELECT * FROM messages 
            WHERE receiver = $1 
            OR sender = $1 
            OR receiver = 'admin' 
            ORDER BY id ASC`,
            [username]
        );

        res.json(result.rows);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/send-message", async (req, res) => {
    try{
        const { from, to, text } = req.body;

        await pool.query(
            "INSERT INTO messages (sender, receiver, text, date) VALUES ($1, $2, $3, $4)",
            [from, to, text, new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })]
        );

        res.send("Nachricht gesendet");

    }catch(err){
        console.log(err);
        res.send("Nachricht Fehler");
    }
});

app.post("/delete-message", async (req, res) => {
    try{
        const { id } = req.body;

        await pool.query(
            "DELETE FROM messages WHERE id = $1",
            [id]
        );

        res.send("Nachricht gelöscht");

    }catch(err){
        console.log(err);
        res.send("Nachricht konnte nicht gelöscht werden");
    }
});

/* ADMIN TIMES */

app.post("/delete-time", async (req, res) => {
    try{
        const { id } = req.body;

        await pool.query(
            "DELETE FROM times WHERE id = $1",
            [id]
        );

        res.send("Zeit gelöscht");

    }catch(err){
        console.log(err);
        res.send("Zeit konnte nicht gelöscht werden");
    }
});

app.post("/edit-own-report", async (req, res) => {
    try{
        const { id, username, report } = req.body;

        await pool.query(
            "UPDATE times SET report = $1 WHERE id = $2 AND username = $3",
            [report || "", id, username]
        );

        res.send("Bericht gespeichert");

    }catch(err){
        console.log(err);
        res.send("Bericht konnte nicht gespeichert werden");
    }
});

app.post("/delete-single-report", async (req, res) => {
    try{
        const { id } = req.body;

        await pool.query(
            "UPDATE times SET report = '' WHERE id = $1",
            [id]
        );

        res.send("Report gelöscht");

    }catch(err){
        console.log(err);
        res.send("Report konnte nicht gelöscht werden");
    }
});

app.post("/delete-single-auswertung", async (req, res) => {
    try{
        const { id } = req.body;

        await pool.query(
            "DELETE FROM times WHERE id = $1",
            [id]
        );

        res.send("Auswertung gelöscht");

    }catch(err){
        console.log(err);
        res.send("Auswertung konnte nicht gelöscht werden");
    }
});

app.post("/edit-time", async (req, res) => {
    try{
        const { id, username, project, task, start_time, stop_time, report } = req.body;

        await pool.query(
            "UPDATE times SET username = $1, project = $2, task = $3, start_time = $4, stop_time = $5, report = $6 WHERE id = $7",
            [username, project, task, start_time || "", stop_time || "", report || "", id]
        );

        res.send("Zeit geändert");

    }catch(err){
        console.log(err);
        res.send("Zeit ändern fehlgeschlagen");
    }
});

app.post("/manual-time", async (req, res) => {
    try{
        const { username, project, task, start_time, stop_time, report } = req.body;

        await pool.query(
            "INSERT INTO times (username, project, task, start_time, stop_time, report) VALUES ($1, $2, $3, $4, $5, $6)",
            [username, project, task, start_time, stop_time, report || ""]
        );

        res.send("Zeit nachgetragen");

    }catch(err){
        console.log(err);
        res.send("Nachtragen fehlgeschlagen");
    }
});

app.post("/delete-all-times", async (req, res) => {
    try{
        await pool.query("DELETE FROM times");
        res.send("Alle Zeiten gelöscht");
    }catch(err){
        console.log(err);
        res.send("Zeiten löschen fehlgeschlagen");
    }
});

app.post("/delete-all-reports", async (req, res) => {
    try{
        await pool.query("UPDATE times SET report = ''");
        res.send("Alle Reports gelöscht");
    }catch(err){
        console.log(err);
        res.send("Reports löschen fehlgeschlagen");
    }
});

app.post("/delete-all-auswertung", async (req, res) => {
    try{
        await pool.query("DELETE FROM times");
        res.send("Auswertung gelöscht");
    }catch(err){
        console.log(err);
        res.send("Auswertung löschen fehlgeschlagen");
    }
});

/* PERSONAL CALENDAR */

app.get("/calendar/:username", async (req, res) => {
    try{
        const username = req.params.username;

        const result = await pool.query(
            "SELECT * FROM calendar_entries WHERE username = $1 ORDER BY entry_date ASC, entry_time ASC",
            [username]
        );

        res.json(result.rows);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/create-calendar-entry", async (req, res) => {
    try{
        const { username, title, note, entry_date, entry_time } = req.body;

        if(!username || !title || !entry_date){
            return res.send("Daten fehlen");
        }

        await pool.query(
            "INSERT INTO calendar_entries (username, title, note, entry_date, entry_time, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
            [username, title.trim(), note || "", entry_date, entry_time || "", new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })]
        );

        res.send("Kalendereintrag gespeichert");

    }catch(err){
        console.log(err);
        res.send("Kalender Fehler");
    }
});

app.post("/edit-calendar-entry", async (req, res) => {
    try{
        const { id, username, title, note, entry_date, entry_time } = req.body;

        await pool.query(
            "UPDATE calendar_entries SET title = $1, note = $2, entry_date = $3, entry_time = $4 WHERE id = $5 AND username = $6",
            [title.trim(), note || "", entry_date, entry_time || "", id, username]
        );

        res.send("Kalendereintrag geändert");

    }catch(err){
        console.log(err);
        res.send("Ändern fehlgeschlagen");
    }
});

app.post("/delete-calendar-entry", async (req, res) => {
    try{
        const { id, username } = req.body;

        await pool.query(
            "DELETE FROM calendar_entries WHERE id = $1 AND username = $2",
            [id, username]
        );

        res.send("Kalendereintrag gelöscht");

    }catch(err){
        console.log(err);
        res.send("Löschen fehlgeschlagen");
    }
});

/* PERSONAL NOTES */

app.get("/notes/:username", async (req, res) => {
    try{
        const username = req.params.username;

        const result = await pool.query(
            "SELECT * FROM personal_notes WHERE username = $1 ORDER BY id DESC",
            [username]
        );

        res.json(result.rows);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/create-note", async (req, res) => {
    try{
        const { username, title, note } = req.body;

        if(!username || !title || !note){
            return res.send("Daten fehlen");
        }

        await pool.query(
            "INSERT INTO personal_notes (username, title, note, created_at) VALUES ($1, $2, $3, $4)",
            [
                username,
                title.trim(),
                note.trim(),
                new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })
            ]
        );

        res.send("Notiz gespeichert");

    }catch(err){
        console.log(err);
        res.send("Notiz Fehler");
    }
});

app.post("/delete-note", async (req, res) => {
    try{
        const { id, username } = req.body;

        await pool.query(
            "DELETE FROM personal_notes WHERE id = $1 AND username = $2",
            [id, username]
        );

        res.send("Notiz gelöscht");

    }catch(err){
        console.log(err);
        res.send("Löschen fehlgeschlagen");
    }
});

/* SUGGESTIONS */

app.get("/suggestions", async (req, res) => {
    try{
        const suggestions = await pool.query(
            "SELECT * FROM suggestions ORDER BY id DESC"
        );

        const votes = await pool.query(
            "SELECT * FROM suggestion_votes"
        );

        const comments = await pool.query(
            "SELECT * FROM suggestion_comments ORDER BY id ASC"
        );

        const data = suggestions.rows.map(s => ({
            ...s,
            good: votes.rows.filter(v => v.suggestion_id === s.id && v.vote === "good").length,
            bad: votes.rows.filter(v => v.suggestion_id === s.id && v.vote === "bad").length,
            comments: comments.rows.filter(c => c.suggestion_id === s.id)
        }));

        res.json(data);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/create-suggestion", async (req, res) => {
    try{
        const { username, project, title, description } = req.body;

        if(!username || !title){
            return res.send("Titel fehlt");
        }

        await pool.query(
            "INSERT INTO suggestions (username, project, title, description, created_at) VALUES ($1, $2, $3, $4, $5)",
            [
                username,
                project || "",
                title.trim(),
                description || "",
                new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })
            ]
        );

        res.send("Vorschlag gespeichert");

    }catch(err){
        console.log(err);
        res.send("Vorschlag Fehler");
    }
});

app.post("/vote-suggestion", async (req, res) => {
    try{
        const { suggestionId, username, vote } = req.body;

        await pool.query(
            `INSERT INTO suggestion_votes (suggestion_id, username, vote)
             VALUES ($1, $2, $3)
             ON CONFLICT (suggestion_id, username)
             DO UPDATE SET vote = $3`,
            [suggestionId, username, vote]
        );

        res.send("Bewertung gespeichert");

    }catch(err){
        console.log(err);
        res.send("Bewertung Fehler");
    }
});

app.post("/comment-suggestion", async (req, res) => {
    try{
        const { suggestionId, username, comment, parentCommentId } = req.body;

        if(!comment){
            return res.send("Kommentar fehlt");
        }

        await pool.query(
            "INSERT INTO suggestion_comments (suggestion_id, username, comment, created_at, parent_comment_id) VALUES ($1, $2, $3, $4, $5)",
            [
            suggestionId,
            username,
            comment.trim(),
            new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
            parentCommentId || null
            ]
        );

        res.send("Kommentar gespeichert");

    }catch(err){
        console.log(err);
        res.send("Kommentar Fehler");
    }
});

app.post("/edit-suggestion", async (req, res) => {
    try{
        const { id, title, project, description, username } = req.body;

        if(!await isRealAdmin(username)){
        return res.send("Keine Berechtigung");
        }
        await pool.query(
            "UPDATE suggestions SET title = $1, project = $2, description = $3 WHERE id = $4",
            [title || "", project || "", description || "", id]
        );

        res.send("Vorschlag geändert");

    }catch(err){
        console.log(err);
        res.send("Vorschlag konnte nicht geändert werden");
    }
});

app.post("/delete-suggestion", async (req, res) => {
    try{
        const { id, isAdmin } = req.body;

        if(isAdmin !== true){
            return res.send("Keine Berechtigung");
        }

        await pool.query(
            "DELETE FROM suggestions WHERE id = $1",
            [id]
        );

        res.send("Vorschlag gelöscht");

    }catch(err){
        console.log(err);
        res.send("Löschen fehlgeschlagen");
    }
});

app.post("/delete-suggestion-comment", async (req, res) => {
    try{
        const { id, username, isAdmin } = req.body;

        const result = await pool.query(
            "SELECT * FROM suggestion_comments WHERE id = $1",
            [id]
        );

        if(result.rows.length === 0){
            return res.send("Kommentar nicht gefunden");
        }

        const comment = result.rows[0];

        if(comment.username !== username && isAdmin !== true){
            return res.send("Keine Berechtigung");
        }

        await pool.query(
            "DELETE FROM suggestion_comments WHERE id = $1",
            [id]
        );

        res.send("Kommentar gelöscht");

    }catch(err){
        console.log(err);
        res.send("Kommentar löschen fehlgeschlagen");
    }
});

/* TICKETS */

app.post("/create-tracksy-ticket", async (req, res) => {
    try{
        const {
            username,
            userRole,
            title,
            message,
            priority
        } = req.body;

        if(userRole !== "admin" && userRole !== "user"){
            return res.send("Keine Berechtigung");
        }

        if(!username || !title || !message){
            return res.send("Bitte alle Pflichtfelder ausfüllen");
        }

        const allowedPriorities = ["Niedrig", "Normal", "Hoch"];

        const finalPriority = allowedPriorities.includes(priority)
            ? priority
            : "Normal";

        await pool.query(
            `INSERT INTO tickets (
                project,
                source,
                customer_name,
                customer_email,
                title,
                message,
                priority,
                status,
                created_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
                "Tracksy",
                "Tracksy intern",
                username,
                "",
                title.trim(),
                message.trim(),
                finalPriority,
                "Offen",
                new Date().toLocaleString("de-DE", {
                    timeZone:"Europe/Berlin"
                })
            ]
        );

        res.send("Tracksy-Ticket erstellt");

    }catch(err){
        console.log(err);
        res.send("Tracksy-Ticket konnte nicht erstellt werden");
    }
});

app.get("/tickets", async (req, res) => {
    try{
        const result = await pool.query(
            "SELECT * FROM tickets ORDER BY id DESC"
        );

        res.json(result.rows);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/create-ticket", async (req, res) => {
    try{
        const {
            project,
            source,
            customerName,
            customerEmail,
            title,
            message,
            priority
        } = req.body;

        if(!project || !title || !message){
            return res.send("Ticket Daten fehlen");
        }

        const allowedPriorities = ["Niedrig", "Normal", "Hoch"];

        const legacyPriorityMatch = message.match(
            /(?:^|\n)\s*Priorität:\s*(Niedrig|Normal|Hoch)\s*(?:\n|$)/i
        );

        let finalPriority = allowedPriorities.includes(priority)
            ? priority
            : "Normal";

        if(!allowedPriorities.includes(priority) && legacyPriorityMatch){
            const foundPriority = legacyPriorityMatch[1].toLowerCase();

            if(foundPriority === "hoch"){
                finalPriority = "Hoch";
            }else if(foundPriority === "niedrig"){
                finalPriority = "Niedrig";
            }else{
                finalPriority = "Normal";
            }
        }

        const cleanMessage = message
            .replace(
                /(?:^|\n)\s*Priorität:\s*(Niedrig|Normal|Hoch)\s*(?:\n|$)/gi,
                "\n"
            )
            .trim();

        await pool.query(
            `INSERT INTO tickets (
                project,
                source,
                customer_name,
                customer_email,
                title,
                message,
                priority,
                created_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
                project,
                source || "",
                customerName || "",
                customerEmail || "",
                title.trim(),
                cleanMessage,
                finalPriority,
                new Date().toLocaleString("de-DE", {
                    timeZone: "Europe/Berlin"
                })
            ]
        );

        res.send("Ticket erstellt");

    }catch(err){
        console.log(err);
        res.send("Ticket Fehler");
    }
});

/* ======================================================
   SERVICE & TARIFE
====================================================== */

app.get("/service-management", async (req, res) => {
    try{
        const tariffs = await pool.query(`
            SELECT *
            FROM service_tariffs
            ORDER BY project ASC
        `);

        const requests = await pool.query(`
            SELECT *
            FROM service_requests
            ORDER BY id DESC
        `);

        const history = await pool.query(`
            SELECT *
            FROM service_history
            ORDER BY id DESC
        `);

        res.json({
            tariffs: tariffs.rows,
            requests: requests.rows,
            history: history.rows
        });

    }catch(err){
        console.log(err);

        res.json({
            tariffs: [],
            requests: [],
            history: []
        });
    }
});

app.get("/service-tariffs", async (req, res) => {
    try{
        const result = await pool.query(`
            SELECT *
            FROM service_tariffs
            ORDER BY project ASC
        `);

        res.json(result.rows);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.get("/service-status/:project", async (req, res) => {

    try{

        const project = req.params.project;

        const tariff = await pool.query(`
            SELECT *
            FROM service_tariffs
            WHERE project = $1
            LIMIT 1
        `,[project]);

        const pending = await pool.query(`
            SELECT *
            FROM service_requests
            WHERE project = $1
            AND status = 'Offen'
            ORDER BY id DESC
            LIMIT 1
        `,[project]);

        res.json({

            ...(tariff.rows[0] || {
        
                project,
        
                status: "Offline",
                tariff: "Keiner",
        
                support_active: false,
                billing_cycle: "",
        
                contract_start: "",
                first_payment: "",
                subscription_start: "",
        
                payment_recipient: "",
                payment_iban: "",
                payment_reference: "",
        
                next_invoice: "",
        
                open_amount: 0,
                payment_status: "Beglichen"
        
            }),
        
            pending_request:
                pending.rows.length
                    ? pending.rows[0]
                    : null
        
        });

    }catch(err){

        console.log(err);

        res.json({

            status: "Offline",
            tariff: "Keiner",
        
            support_active: false,
            billing_cycle: "",
        
            contract_start: "",
            first_payment: "",
            subscription_start: "",
        
            payment_recipient: "",
            payment_iban: "",
            payment_reference: "",
        
            next_invoice: "",
        
            open_amount: 0,
            payment_status: "Beglichen",
        
            pending_request: null
        
        });

    }

});

/* Anfrage von RadioNetz */

app.post("/create-service-request", async (req, res) => {
    try{
        const {
            project,
            requestType,
            title,
            description,
            tariff,
            billingCycle,
            priceMonthly,
            priceYearly,
            priceOnce
        } = req.body;

        const allowedTypes = [
            "tariff",
            "addon",
            "cancellation"
        ];

        if(
            !project ||
            !requestType ||
            !title ||
            !allowedTypes.includes(requestType)
        ){
            return res.send("Anfrage-Daten fehlen");
        }

        if(requestType === "tariff"){

            if(
                !["Lite", "Normal", "Premium"].includes(tariff)
            ){
                return res.send("Ungültiger Tarif");
            }

            if(
                !["Monatlich", "Jährlich"].includes(billingCycle)
            ){
                return res.send("Ungültige Abrechnung");
            }
        }

        if(requestType === "cancellation"){

            const activeService = await pool.query(`
                SELECT tariff
                FROM service_tariffs
                WHERE project = $1
                AND tariff IS NOT NULL
                AND tariff != ''
                AND tariff != 'Keiner'
                LIMIT 1
            `, [project]);

            if(activeService.rows.length === 0){
                return res.send("Kein aktiver Tarif vorhanden");
            }
        }

        if(
            requestType === "tariff" ||
            requestType === "cancellation"
        ){
            const existingRequest = await pool.query(`
                SELECT id
                FROM service_requests
                WHERE project = $1
                AND request_type IN (
                    'tariff',
                    'cancellation'
                )
                AND status = 'Offen'
                LIMIT 1
            `, [project]);

            if(existingRequest.rows.length > 0){
                return res.send(
                    "Es besteht bereits eine offene Tarifanfrage"
                );
            }
        }

        const now = new Date().toLocaleString("de-DE", {
            timeZone: "Europe/Berlin"
        });

        await pool.query(`
            INSERT INTO service_requests (
                project,
                request_type,
                title,
                description,
                tariff,
                billing_cycle,
                price_monthly,
                price_yearly,
                price_once,
                status,
                created_at
            )
            VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
            )
        `, [
            project,
            requestType,
            title.trim(),
            description || "",
            tariff || "",
            billingCycle || "",
            Number(priceMonthly) || 0,
            Number(priceYearly) || 0,
            Number(priceOnce) || 0,
            "Offen",
            now
        ]);

        await pool.query(`
            INSERT INTO service_tariffs (project)
            VALUES ($1)
            ON CONFLICT (project) DO NOTHING
        `, [project]);

        res.send("Anfrage erfolgreich gesendet");

    }catch(err){
        console.log(err);

        res.send(
            "Anfrage konnte nicht gesendet werden"
        );
    }
});

/* Anfrage annehmen oder ablehnen */

app.post("/service-request-action", async (req, res) => {
    try{
        const { id, action } = req.body;

        if(
            !id ||
            !["accept", "reject", "complete"].includes(action)
        ){
            return res.send("Ungültige Aktion");
        }

        const result = await pool.query(`
            SELECT *
            FROM service_requests
            WHERE id = $1
        `, [id]);

        if(result.rows.length === 0){
            return res.send("Anfrage nicht gefunden");
        }

        const request = result.rows[0];

        const now = new Date().toLocaleString("de-DE", {
            timeZone: "Europe/Berlin"
        });

        if(action === "accept"){

            if(request.status !== "Offen"){
                return res.send(
                    "Anfrage wurde bereits bearbeitet"
                );
            }

            if(request.request_type === "tariff"){

                await pool.query(`
                    INSERT INTO service_tariffs (
                        project,
                        status,
                        tariff,
                        support_active,
                        billing_cycle,
                        updated_at
                    )
                    VALUES ($1,$2,$3,$4,$5,$6)

                    ON CONFLICT (project)
                    DO UPDATE SET
                        status = EXCLUDED.status,
                        tariff = EXCLUDED.tariff,
                        support_active =
                            EXCLUDED.support_active,
                        billing_cycle =
                            EXCLUDED.billing_cycle,
                        updated_at =
                            EXCLUDED.updated_at
                `, [
                    request.project,
                    "Online",
                    request.tariff,
                    true,
                    request.billing_cycle,
                    now
                ]);

                await pool.query(`
                    UPDATE service_requests
                    SET status = 'Angenommen',
                        updated_at = $1
                    WHERE id = $2
                `, [now, id]);

                await pool.query(`
                    INSERT INTO service_history (
                        project,
                        action,
                        details,
                        created_at
                    )
                    VALUES ($1,$2,$3,$4)
                `, [
                    request.project,
                    "Tarif angenommen",
                    `${request.tariff} – ${request.billing_cycle}`,
                    now
                ]);

                return res.send("Tarif angenommen");
            }

            if(request.request_type === "cancellation"){

                await pool.query(`
                    UPDATE service_tariffs
                    SET tariff = 'Keiner',
                        support_active = false,
                        billing_cycle = '',
                        updated_at = $1
                    WHERE project = $2
                `, [
                    now,
                    request.project
                ]);

                await pool.query(`
                    UPDATE service_requests
                    SET status = 'Angenommen',
                        updated_at = $1
                    WHERE id = $2
                `, [now, id]);

                await pool.query(`
                    INSERT INTO service_history (
                        project,
                        action,
                        details,
                        created_at
                    )
                    VALUES ($1,$2,$3,$4)
                `, [
                    request.project,
                    "Tarif gekündigt",
                    request.tariff || "Tarif",
                    now
                ]);

                return res.send("Kündigung angenommen");
            }

            await pool.query(`
                UPDATE service_requests
                SET status = 'Angenommen',
                    updated_at = $1
                WHERE id = $2
            `, [now, id]);

            await pool.query(`
                INSERT INTO service_history (
                    project,
                    action,
                    details,
                    created_at
                )
                VALUES ($1,$2,$3,$4)
            `, [
                request.project,
                "Zusatzleistung angenommen",
                request.title,
                now
            ]);

            return res.send(
                "Zusatzleistung angenommen"
            );
        }

        if(action === "reject"){

            if(request.status !== "Offen"){
                return res.send(
                    "Anfrage wurde bereits bearbeitet"
                );
            }

            await pool.query(`
                UPDATE service_requests
                SET status = 'Abgelehnt',
                    updated_at = $1
                WHERE id = $2
            `, [now, id]);

            let historyAction =
                "Zusatzleistung abgelehnt";

            if(request.request_type === "tariff"){
                historyAction = "Tarif abgelehnt";
            }

            if(request.request_type === "cancellation"){
                historyAction = "Kündigung abgelehnt";
            }

            await pool.query(`
                INSERT INTO service_history (
                    project,
                    action,
                    details,
                    created_at
                )
                VALUES ($1,$2,$3,$4)
            `, [
                request.project,
                historyAction,
                request.title,
                now
            ]);

            return res.send("Anfrage abgelehnt");
        }

        if(
            action === "complete" &&
            request.request_type === "addon" &&
            request.status === "Angenommen"
        ){
            await pool.query(`
                UPDATE service_requests
                SET status = 'Erledigt',
                    updated_at = $1
                WHERE id = $2
            `, [now, id]);

            await pool.query(`
                INSERT INTO service_history (
                    project,
                    action,
                    details,
                    created_at
                )
                VALUES ($1,$2,$3,$4)
            `, [
                request.project,
                "Zusatzleistung erledigt",
                request.title,
                now
            ]);

            return res.send(
                "Zusatzleistung erledigt"
            );
        }

        res.send("Aktion nicht möglich");

    }catch(err){
        console.log(err);
        res.send("Aktion fehlgeschlagen");
    }
});

app.post("/save-contract-information", async (req, res) => {

    try{

        const{

            project,

            contract_start,
            first_payment,
            subscription_start,

            payment_recipient,
            payment_iban,
            payment_reference

        } = req.body;

        if(!project){
            return res.send("Projekt fehlt");
        }

        await pool.query(`
            INSERT INTO service_tariffs (
                project,
                contract_start,
                first_payment,
                subscription_start,
                payment_recipient,
                payment_iban,
                payment_reference,
                updated_at
            )
            VALUES ($8,$1,$2,$3,$4,$5,$6,$7)
        
            ON CONFLICT (project)
            DO UPDATE SET
                contract_start = EXCLUDED.contract_start,
                first_payment = EXCLUDED.first_payment,
                subscription_start = EXCLUDED.subscription_start,
                payment_recipient = EXCLUDED.payment_recipient,
                payment_iban = EXCLUDED.payment_iban,
                payment_reference = EXCLUDED.payment_reference,
                updated_at = EXCLUDED.updated_at
        `, [

            contract_start,
            first_payment,
            subscription_start,

            payment_recipient,
            payment_iban,
            payment_reference,

            new Date().toLocaleString("de-DE",{
                timeZone:"Europe/Berlin"
            }),

            project

        ]);

        res.send("Vertragsdaten gespeichert");

    }catch(err){

        console.log(err);

        res.send("Speichern fehlgeschlagen");

    }

});

/* Status Online / Offline */

app.post("/update-service-status", async (req, res) => {
    try{
        const { project, status } = req.body;

        if(!project || !["Online", "Offline"].includes(status)){
            return res.send("Ungültiger Status");
        }

        const now = new Date().toLocaleString("de-DE", {
            timeZone: "Europe/Berlin"
        });

        await pool.query(`
            INSERT INTO service_tariffs (
                project,
                status,
                updated_at
            )
            VALUES ($1,$2,$3)

            ON CONFLICT (project)
            DO UPDATE SET
                status = EXCLUDED.status,
                updated_at = EXCLUDED.updated_at
        `, [project, status, now]);

        await pool.query(`
            INSERT INTO service_history (
                project,
                action,
                details,
                created_at
            )
            VALUES ($1,$2,$3,$4)
        `, [
            project,
            "Status geändert",
            status,
            now
        ]);

        res.send("Status gespeichert");

    }catch(err){
        console.log(err);
        res.send("Status konnte nicht gespeichert werden");
    }
});

/* Offener Betrag */

app.post("/update-service-payment", async (req, res) => {
    try{
        const {
            project,
            openAmount,
            paymentStatus
        } = req.body;

        if(
            !project ||
            !["Offen", "Beglichen"].includes(paymentStatus)
        ){
            return res.send("Ungültige Zahlungsdaten");
        }

        const amount = Number(openAmount) || 0;

        const now = new Date().toLocaleString("de-DE", {
            timeZone: "Europe/Berlin"
        });

        await pool.query(`
            INSERT INTO service_tariffs (
                project,
                open_amount,
                payment_status,
                updated_at
            )
            VALUES ($1,$2,$3,$4)

            ON CONFLICT (project)
            DO UPDATE SET
                open_amount = EXCLUDED.open_amount,
                payment_status = EXCLUDED.payment_status,
                updated_at = EXCLUDED.updated_at
        `, [
            project,
            paymentStatus === "Beglichen" ? 0 : amount,
            paymentStatus,
            now
        ]);

        await pool.query(`
            INSERT INTO service_history (
                project,
                action,
                details,
                created_at
            )
            VALUES ($1,$2,$3,$4)
        `, [
            project,
            paymentStatus === "Beglichen"
                ? "Betrag beglichen"
                : "Offener Betrag geändert",
            paymentStatus === "Beglichen"
                ? "Beglichen"
                : amount.toFixed(2) + " €",
            now
        ]);

        res.send("Zahlung gespeichert");

    }catch(err){
        console.log(err);
        res.send("Zahlung konnte nicht gespeichert werden");
    }
});

/* History löschen */

app.post("/clear-service-history", async (req, res) => {
    try{
        const { project } = req.body;

        if(!project){
            return res.send("Projekt fehlt");
        }

        await pool.query(`
            DELETE FROM service_history
            WHERE project = $1
        `, [project]);

        res.send("Verlauf gelöscht");

    }catch(err){
        console.log(err);
        res.send("Verlauf konnte nicht gelöscht werden");
    }
});

app.post("/edit-external-ticket", async (req, res) => {
    try{
        const { id, title, message, editNote } = req.body;

        if(!id || !title || !message){
            return res.send("Ticket Daten fehlen");
        }

        await pool.query(
            `UPDATE tickets
             SET title = $1,
                 message = $2,
                 customer_edited = true,
                 edit_note = $3,
                 updated_at = $4
             WHERE id = $5`,
            [
                title.trim(),
                message.trim(),
                editNote || "Ticket wurde über RadioNetz bearbeitet.",
                new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
                id
            ]
        );

        res.send("Ticket geändert");

    }catch(err){
        console.log(err);
        res.send("Ticket ändern fehlgeschlagen");
    }
});

app.post("/delete-external-ticket", async (req, res) => {
    try{
        const { id, reason } = req.body;

        if(!id || !reason){
            return res.send("Löschgrund fehlt");
        }

        await pool.query(
            `UPDATE tickets
             SET customer_deleted = true,
                 delete_reason = $1,
                 status = 'Vom Kunden gelöscht',
                 updated_at = $2
             WHERE id = $3`,
            [
                reason.trim(),
                new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
                id
            ]
        );

        res.send("Ticket als gelöscht markiert");

    }catch(err){
        console.log(err);
        res.send("Ticket löschen fehlgeschlagen");
    }
});

app.post("/update-ticket-status", async (req, res) => {
    try{
        const { id, status } = req.body;

        await pool.query(
            "UPDATE tickets SET status = $1 WHERE id = $2",
            [status, id]
        );

        res.send("Ticket Status geändert");

    }catch(err){
        console.log(err);
        res.send("Status Fehler");
    }
});

app.post("/delete-ticket", async (req, res) => {
    try{
        const { id } = req.body;

        await pool.query(
            "DELETE FROM tickets WHERE id = $1",
            [id]
        );

        res.send("Ticket gelöscht");

    }catch(err){
        console.log(err);
        res.send("Ticket löschen fehlgeschlagen");
    }
});

/* SHIFTPLANS */

app.get("/shiftplans/:username", async (req, res) => {
    try{
        const username = req.params.username;
        const admin = req.query.admin === "true";

        const result = admin
            ? await pool.query(
                "SELECT * FROM shiftplans ORDER BY period_start DESC, id DESC"
            )
            : await pool.query(
                `SELECT * FROM shiftplans
                 WHERE assigned_to = $1
                 ORDER BY period_start DESC, id DESC`,
                [username]
            );

        res.json(result.rows);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/upload-shiftplan", shiftplanUpload.single("pdf"), async (req, res) => {
    try{
        if(!req.file){
            return res.send("Keine PDF ausgewählt");
        }

        const {
            title,
            description,
            assignedTo,
            periodStart,
            periodEnd,
            uploadedBy
        } = req.body;

        if(!title || !assignedTo || !periodStart || !periodEnd){
            fs.unlinkSync(req.file.path);
            return res.send("Pflichtfelder fehlen");
        }

        const fileBuffer = fs.readFileSync(req.file.path);

        const safeName = req.file.originalname.replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
        );

        const filename =
            "dienstplaene/" +
            Date.now() +
            "-" +
            safeName;

        const { error } = await supabase.storage
            .from("tracksy-pdfs")
            .upload(filename, fileBuffer, {
                contentType: "application/pdf"
            });

        fs.unlinkSync(req.file.path);

        if(error){
            console.log(error);
            return res.send("Dienstplan Upload fehlgeschlagen");
        }

        await pool.query(
            `INSERT INTO shiftplans
            (
                title,
                description,
                assigned_to,
                period_start,
                period_end,
                filename,
                originalname,
                uploaded_by,
                created_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
                title.trim(),
                description || "",
                assignedTo,
                periodStart,
                periodEnd,
                filename,
                req.file.originalname,
                uploadedBy,
                new Date().toLocaleString("de-DE", {
                    timeZone: "Europe/Berlin"
                })
            ]
        );

        res.send("Dienstplan hochgeladen");

    }catch(err){
        console.log(err);
        res.send("Dienstplan Upload fehlgeschlagen");
    }
});

app.post("/open-shiftplan", async (req, res) => {
    try{
        const { id } = req.body;

        const result = await pool.query(
            "SELECT * FROM shiftplans WHERE id = $1",
            [id]
        );

        if(result.rows.length === 0){
            return res.json({
                success:false,
                message:"Dienstplan nicht gefunden"
            });
        }

        const shiftplan = result.rows[0];

        const { data, error } = await supabase.storage
            .from("tracksy-pdfs")
            .createSignedUrl(shiftplan.filename, 60);

        if(error){
            console.log(error);

            return res.json({
                success:false,
                message:"Dienstplan konnte nicht geöffnet werden"
            });
        }

        res.json({
            success:true,
            url:data.signedUrl
        });

    }catch(err){
        console.log(err);

        res.json({
            success:false,
            message:"Serverfehler"
        });
    }
});

app.post("/edit-shiftplan", async (req, res) => {
    try{
        const {
            id,
            title,
            description,
            assignedTo,
            periodStart,
            periodEnd
        } = req.body;

        await pool.query(
            `UPDATE shiftplans
             SET title = $1,
                 description = $2,
                 assigned_to = $3,
                 period_start = $4,
                 period_end = $5
             WHERE id = $6`,
            [
                title.trim(),
                description || "",
                assignedTo,
                periodStart,
                periodEnd,
                id
            ]
        );

        res.send("Dienstplan geändert");

    }catch(err){
        console.log(err);
        res.send("Dienstplan konnte nicht geändert werden");
    }
});

app.post("/delete-shiftplan", async (req, res) => {
    try{
        const { id } = req.body;

        const result = await pool.query(
            "SELECT * FROM shiftplans WHERE id = $1",
            [id]
        );

        if(result.rows.length === 0){
            return res.send("Dienstplan nicht gefunden");
        }

        const shiftplan = result.rows[0];

        await supabase.storage
            .from("tracksy-pdfs")
            .remove([shiftplan.filename]);

        await pool.query(
            "DELETE FROM shiftplans WHERE id = $1",
            [id]
        );

        res.send("Dienstplan gelöscht");

    }catch(err){
        console.log(err);
        res.send("Dienstplan konnte nicht gelöscht werden");
    }
});

/* WORK ORDERS */

app.get("/work-orders/:username", async (req, res) => {
    try{
        const username = req.params.username;
        const admin = req.query.admin === "true";

        const result = admin
            ? await pool.query(
                `SELECT * FROM work_orders
                 ORDER BY work_date DESC, id DESC`
            )
            : await pool.query(
                `SELECT * FROM work_orders
                 WHERE assigned_to = $1
                 ORDER BY work_date DESC, id DESC`,
                [username]
            );

        res.json(result.rows);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/create-work-order", async (req, res) => {
    try{
        const {
            workDate,
            title,
            description,
            assignedTo,
            project,
            priority,
            status,
            note,
            createdBy
        } = req.body;

        if(!workDate || !title || !description || !assignedTo || !createdBy){
            return res.send("Pflichtfelder fehlen");
        }

        await pool.query(
            `INSERT INTO work_orders (
                work_date,
                title,
                description,
                assigned_to,
                project,
                priority,
                status,
                note,
                created_by,
                created_at,
                updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
                workDate,
                title.trim(),
                description.trim(),
                assignedTo,
                project || "",
                priority || "Normal",
                status || "Offen",
                note || "",
                createdBy,
                new Date().toLocaleString("de-DE", {
                    timeZone:"Europe/Berlin"
                }),
                ""
            ]
        );

        res.send("Arbeitsauftrag erstellt");

    }catch(err){
        console.log(err);
        res.send("Arbeitsauftrag konnte nicht erstellt werden");
    }
});

app.post("/save-shift-planner", async (req, res) => {

    try{

        const {
            assigned_to,
            period_start,
            period_end,
            days,
            uploaded_by
        } = req.body;

        await pool.query(
            `
            INSERT INTO shiftplans
            (
                title,
                description,
                assigned_to,
                period_start,
                period_end,
                filename,
                originalname,
                uploaded_by,
                created_at,
                planner_data,
                updated_at
            )
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `,
            [
                "Dienstplan " + period_start + " bis " + period_end,
                "",
                assigned_to,
                period_start,
                period_end,
                "",
                "",
                uploaded_by || "System",
                new Date().toLocaleString("de-DE", {
                    timeZone: "Europe/Berlin"
                }),
                JSON.stringify(days || []),
                ""
            ]
        );

        res.send("Dienstplan gespeichert.");

    }catch(err){

        console.error(err);
        res.status(500).send("Fehler beim Speichern.");

    }

});

app.post("/edit-work-order", async (req, res) => {
    try{
        const {
            id,
            workDate,
            title,
            description,
            assignedTo,
            project,
            priority,
            status,
            note
        } = req.body;

        if(!id || !workDate || !title || !description || !assignedTo){
            return res.send("Pflichtfelder fehlen");
        }

        await pool.query(
            `UPDATE work_orders
             SET work_date = $1,
                 title = $2,
                 description = $3,
                 assigned_to = $4,
                 project = $5,
                 priority = $6,
                 status = $7,
                 note = $8,
                 updated_at = $9
             WHERE id = $10`,
            [
                workDate,
                title.trim(),
                description.trim(),
                assignedTo,
                project || "",
                priority || "Normal",
                status || "Offen",
                note || "",
                new Date().toLocaleString("de-DE", {
                    timeZone:"Europe/Berlin"
                }),
                id
            ]
        );

        res.send("Arbeitsauftrag geändert");

    }catch(err){
        console.log(err);
        res.send("Arbeitsauftrag konnte nicht geändert werden");
    }
});

app.post("/update-work-order-status", async (req, res) => {
    try{
        const { id, status } = req.body;

        if(!id || !["Offen", "In Arbeit", "Erledigt"].includes(status)){
            return res.send("Ungültiger Status");
        }

        await pool.query(
            `UPDATE work_orders
             SET status = $1,
                 updated_at = $2
             WHERE id = $3`,
            [
                status,
                new Date().toLocaleString("de-DE", {
                    timeZone:"Europe/Berlin"
                }),
                id
            ]
        );

        res.send("Status geändert");

    }catch(err){
        console.log(err);
        res.send("Status konnte nicht geändert werden");
    }
});

app.post("/delete-work-order", async (req, res) => {
    try{
        const { id } = req.body;

        await pool.query(
            "DELETE FROM work_orders WHERE id = $1",
            [id]
        );

        res.send("Arbeitsauftrag gelöscht");

    }catch(err){
        console.log(err);
        res.send("Arbeitsauftrag konnte nicht gelöscht werden");
    }
});

app.get("/work-schedule/:username", async (req, res) => {
    try{
        const username = req.params.username;
        const admin = req.query.admin === "true";

        const result = admin
            ? await pool.query(
                `SELECT *
                 FROM work_schedule
                 ORDER BY plan_date ASC, sort_order ASC, id ASC`
            )
            : await pool.query(
                `SELECT *
                 FROM work_schedule
                 WHERE assigned_to = $1
                 ORDER BY plan_date ASC, sort_order ASC, id ASC`,
                [username]
            );

        res.json(result.rows);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/create-work-schedule", async (req, res) => {
    try{
        const {
            assignedTo,
            planDate,
            project,
            category,
            title,
            description,
            estimatedMinutes,
            priority,
            createdBy
        } = req.body;

        if(
            !assignedTo ||
            !planDate ||
            !project ||
            !title ||
            !createdBy
        ){
            return res.send("Pflichtfelder fehlen");
        }

        await pool.query(
            `INSERT INTO work_schedule (
                assigned_to,
                plan_date,
                project,
                category,
                title,
                description,
                estimated_minutes,
                priority,
                created_by,
                created_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
                assignedTo,
                planDate,
                project,
                category || "Neue Funktion",
                title.trim(),
                description || "",
                parseInt(estimatedMinutes) || 0,
                priority || "Normal",
                createdBy,
                new Date().toLocaleString("de-DE", {
                    timeZone:"Europe/Berlin"
                })
            ]
        );

        res.send("Arbeitsplanung gespeichert");

    }catch(err){
        console.log(err);
        res.send("Arbeitsplanung konnte nicht gespeichert werden");
    }
});

app.post("/update-work-schedule-status", async (req, res) => {
    try{

        const { id, status } = req.body;

        await pool.query(
            `UPDATE work_schedule
             SET status = $1,
                 updated_at = $2
             WHERE id = $3`,
            [
                status,
                new Date().toLocaleString("de-DE", {
                    timeZone: "Europe/Berlin"
                }),
                id
            ]
        );

        res.send("Status gespeichert");

    }catch(err){
        console.log(err);
        res.send("Fehler");
    }
});

app.post("/delete-work-schedule", async (req, res) => {
    try{

        const { id } = req.body;

        await pool.query(
            `DELETE FROM work_schedule
             WHERE id = $1`,
            [id]
        );

        res.send("Eintrag gelöscht");

    }catch(err){
        console.log(err);
        res.send("Fehler");
    }
});

/* DOCUMENTS */

app.get("/documents", async (req, res) => {
    try{
        const result = await pool.query(
            "SELECT * FROM documents ORDER BY id DESC"
        );

        res.json(result.rows);

    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/open-document", async (req, res) => {
    try{
        const { id, password } = req.body;

        const result = await pool.query(
            "SELECT * FROM documents WHERE id = $1",
            [id]
        );

        if(result.rows.length === 0){
            return res.json({
                success:false,
                message:"Datei nicht gefunden"
            });
        }

        const doc = result.rows[0];

        if(doc.doc_password && doc.doc_password !== password){
            return res.json({
                success:false,
                message:"Falsches Passwort"
            });
        }

        const { data, error } = await supabase.storage
            .from("tracksy-pdfs")
            .createSignedUrl(doc.filename, 60);

        if(error){
            console.log(error);
            return res.json({
                success:false,
                message:"PDF konnte nicht geöffnet werden"
            });
        }

        res.json({
            success:true,
            url:data.signedUrl
        });

    }catch(err){
        console.log(err);
        res.json({
            success:false,
            message:"Serverfehler"
        });
    }
});

app.post("/upload-document", upload.single("pdf"), async (req, res) => {
    try{
        if(!req.file){
            return res.send("Keine Datei");
        }

        const existing = await pool.query(
        "SELECT * FROM documents WHERE originalname = $1",
        [req.file.originalname]
    );

        if(existing.rows.length > 0){
        fs.unlinkSync(req.file.path);
        return res.send("Dateiname existiert bereits");
    }

        const fileBuffer = fs.readFileSync(req.file.path);
        const fileName = Date.now() + "-" + req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

        const { error } = await supabase.storage
            .from("tracksy-pdfs")
            .upload(fileName, fileBuffer, {
                contentType: "application/pdf"
            });

        fs.unlinkSync(req.file.path);

        if(error){
            console.log(error);
            return res.send("Supabase Upload Fehler");
        }

        await pool.query(
            `INSERT INTO documents
            (filename, originalname, uploaded_by, upload_date, doc_password)
            VALUES ($1, $2, $3, $4, $5)`,
            [
                fileName,
                req.file.originalname,
                req.body.username,
                new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
                req.body.password || ""
            ]
        );

        res.send("PDF hochgeladen");

    }catch(err){
        console.log(err);
        res.send("Upload Fehler");
    }
});

app.post("/delete-document", async (req, res) => {
    try{
        const { id } = req.body;

        const result = await pool.query(
            "SELECT * FROM documents WHERE id = $1",
            [id]
        );

        if(result.rows.length === 0){
            return res.send("Datei nicht gefunden");
        }

        const doc = result.rows[0];

        await supabase.storage
            .from("tracksy-pdfs")
            .remove([doc.filename]);

        await pool.query(
            "DELETE FROM documents WHERE id = $1",
            [id]
        );

        res.send("Dokument gelöscht");

    }catch(err){
        console.log(err);
        res.send("Löschen fehlgeschlagen");
    }
});
app.get("/service-packages", async (req, res) => {

    try{

        const result = await pool.query(`
            SELECT *
            FROM service_packages
            ORDER BY id
        `);

        res.json(result.rows);

    }catch(error){

        console.error(error);

        res.status(500).json({
            error:"Fehler beim Laden der Tarife."
        });

    }

    app.get("/service-packages", async (req, res) => {

        try{
    
            const result = await pool.query(`
                SELECT *
                FROM service_packages
                ORDER BY id
            `);
    
            res.json(result.rows);
    
        }catch(error){
    
            console.error(error);
    
            res.status(500).json({
                error:"Fehler beim Laden der Tarife."
            });
    
        }
    
    });
    
    app.post("/save-service-package", async (req, res) => {
    
        try{
    
            const {
                id,
                monthly_price,
                yearly_price,
                status,
    
                offer_enabled,
                offer_name,
                offer_monthly_price,
                offer_yearly_price,
                offer_use_end_date,
                offer_end_date
            } = req.body;
    
            await pool.query(`
                UPDATE service_packages
                SET
                    monthly_price = $1,
                    yearly_price = $2,
                    status = $3,
    
                    offer_enabled = $4,
                    offer_name = $5,
                    offer_monthly_price = $6,
                    offer_yearly_price = $7,
                    offer_use_end_date = $8,
                    offer_end_date = $9,
    
                    updated_at = $10
    
                WHERE id = $11
            `,[
                monthly_price,
                yearly_price,
                status,
    
                offer_enabled === true,
                offer_name || "",
                Number(offer_monthly_price) || 0,
                Number(offer_yearly_price) || 0,
                offer_use_end_date === true,
                offer_end_date || "",
    
                new Date().toISOString(),
    
                id
            ]);
    
            res.send("Tarif gespeichert");
    
        }catch(error){
    
            console.error(error);
    
            res.status(500).send("Speichern fehlgeschlagen");
    
        }
    
    });

});
app.use((err, req, res, next) => {
    console.log(err);
    res.status(500).send("Server Fehler");
});


app.listen(process.env.PORT || 3000, () => {
    console.log("Server läuft");
});