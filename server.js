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
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: function(req, file, cb){
        if(file.mimetype !== "application/pdf"){
            return cb(new Error("Nur PDF Dateien erlaubt"));
        }
        cb(null, true);
    }
});

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

        const result = await pool.query(
            "SELECT * FROM users WHERE username = $1",
            [username]
        );

        if(result.rows.length === 0){
            return res.json({ success:false });
        }

        const user = result.rows[0];

        if(username === "Dominic Schulteis" && password === "07021995"){
            return res.json({
            success:true,
            username:"Dominic Schulteis",
            isAdmin:true
            });
            }

let validPw = false;

try{
    validPw = await bcrypt.compare(password, user.password);
}catch{
    validPw = password === user.password;
}

if(!validPw){
    return res.json({ success:false });
}

        res.json({
            success:true,
            username:user.username,
            isAdmin:user.is_admin
        });

    }catch(err){
        console.log(err);
        res.json({ success:false });
    }
});

/* USERS */

app.get("/users", async (req, res) => {
    try{
        const result = await pool.query(
            "SELECT username, email, is_admin, last_change FROM users ORDER BY username"
        );
        res.json(result.rows);
    }catch(err){
        console.log(err);
        res.json([]);
    }
});

app.post("/create-user", async (req, res) => {
    try{
        const { name, email, pw, admin } = req.body;

        const hashedPw = await bcrypt.hash(pw, 10);

        await pool.query(
            "INSERT INTO users (username, password, email, is_admin, last_change) VALUES ($1, $2, $3, $4, $5)",
            [name.trim(), hashedPw, email || "", admin === true, new Date().toLocaleString("de-DE")]
        );

        res.send("Benutzer erstellt");

    }catch(err){
        console.log(err);
        res.send("Benutzer existiert bereits");
    }
});

app.post("/edit-user", async (req, res) => {
    try{
        const { oldName, newName, email, pw, admin } = req.body;

        const hashedPw = await bcrypt.hash(pw, 10);

        await pool.query(
            "UPDATE users SET username = $1, password = $2, email = $3, is_admin = $4, last_change = $5 WHERE username = $6",
            [newName.trim(), hashedPw, email || "", admin === true, new Date().toLocaleString("de-DE"), oldName]
        );

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
            [username, project, task, new Date().toLocaleString("de-DE")]
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

        await pool.query(
            "UPDATE times SET is_paused = true, pause_time = $1 WHERE username = $2 AND stop_time = ''",
            [new Date().toLocaleString("de-DE"), username]
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

        await pool.query(
            "UPDATE times SET is_paused = false WHERE username = $1 AND stop_time = ''",
            [username]
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

        await pool.query(
            "UPDATE times SET stop_time = $1, report = $2, admin_only = $3, is_paused = false WHERE id = $4",
            [new Date().toLocaleString("de-DE"), report, adminOnly === true, time.id]
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
            "SELECT * FROM messages WHERE receiver = $1 OR receiver = 'admin' ORDER BY id DESC",
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
            [from, to, text, new Date().toLocaleString("de-DE")]
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
                new Date().toLocaleString("de-DE"),
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

app.use((err, req, res, next) => {
    console.log(err);
    res.status(500).send("Server Fehler");
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Server läuft");
});