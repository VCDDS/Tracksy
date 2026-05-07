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

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''
    `);
    
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false
    `);
    
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_change TEXT DEFAULT ''
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
            admin_only BOOLEAN DEFAULT false
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
        INSERT INTO users (username, password, email, is_admin, last_change)
        VALUES ('admin', 'admin123', '', true, '')
        ON CONFLICT (username) DO NOTHING
    `);
}

initDatabase();

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

app.get("/dashboard.html", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

/* LOGIN */
app.post("/login", async (req, res) => {
    const { username, password } = req.body;

    const result = await pool.query(
        "SELECT username, is_admin FROM users WHERE username = $1 AND password = $2",
        [username, password]
    );

    if(result.rows.length === 0){
        return res.json({ success: false });
    }

    res.json({
        success: true,
        username: result.rows[0].username,
        isAdmin: result.rows[0].is_admin
    });
});

app.get("/users", async (req, res) => {

    const result = await pool.query(
        "SELECT username FROM users ORDER BY username"
    );

    res.json(result.rows);

});

app.post("/create-user", async (req, res) => {
    const { name, email, pw, admin } = req.body;

    if(!name || !pw){
        return res.send("Daten fehlen");
    }

    try{
        await pool.query(
            "INSERT INTO users (username, password, email, is_admin, last_change) VALUES ($1, $2, $3, $4, $5)",
            [name, pw, email || "", admin === true, new Date().toLocaleString("de-DE")]
        );

        res.send("Benutzer erstellt");
    }catch(err){
        res.send("Benutzer existiert bereits");
    }
});

app.post("/edit-user", async (req, res) => {
    const { oldName, newName, email, pw, admin } = req.body;

    if(!oldName || !newName || !pw){
        return res.send("Daten fehlen");
    }

    await pool.query(
        "UPDATE users SET username = $1, password = $2, email = $3, is_admin = $4, last_change = $5 WHERE username = $6",
        [newName, pw, email || "", admin === true, new Date().toLocaleString("de-DE"), oldName]
    );

    res.send("Benutzer geändert");
});

app.post("/delete-user", async (req, res) => {
    const { username } = req.body;

    if(username === "admin"){
        return res.send("Admin darf nicht gelöscht werden");
    }

    await pool.query("DELETE FROM users WHERE username = $1", [username]);
    res.send("Benutzer gelöscht");
});

/* PROJECTS */
app.get("/projects", async (req, res) => {
    const projects = await pool.query("SELECT * FROM projects ORDER BY name");
    const tasks = await pool.query("SELECT * FROM tasks ORDER BY name");

    const data = projects.rows.map(p => ({
        ...p,
        tasks: tasks.rows.filter(t => t.project_id === p.id && !t.archived),
        archiveTasks: tasks.rows.filter(t => t.project_id === p.id && t.archived)
    }));

    res.json(data);
});

app.post("/create-project", async (req, res) => {
    const { name, desc } = req.body;

    if(!name){
        return res.send("Projektname fehlt");
    }

    try{
        await pool.query(
            "INSERT INTO projects (name, description) VALUES ($1, $2)",
            [name, desc || ""]
        );

        res.send("Projekt erstellt");
    }catch(err){
        res.send("Projekt existiert bereits");
    }
});

app.post("/delete-project", async (req, res) => {
    const { id } = req.body;

    await pool.query("DELETE FROM projects WHERE id = $1", [id]);
    res.send("Projekt gelöscht");
});

app.post("/create-task", async (req, res) => {
    const { projectId, name } = req.body;

    if(!projectId || !name){
        return res.send("Daten fehlen");
    }

    await pool.query(
        "INSERT INTO tasks (project_id, name) VALUES ($1, $2)",
        [projectId, name]
    );

    res.send("Aufgabe erstellt");
});

app.post("/edit-task", async (req, res) => {
    const { taskId, name } = req.body;

    await pool.query(
        "UPDATE tasks SET name = $1 WHERE id = $2",
        [name, taskId]
    );

    res.send("Aufgabe geändert");
});

app.post("/archive-task", async (req, res) => {
    const { taskId } = req.body;

    await pool.query(
        "UPDATE tasks SET archived = true WHERE id = $1",
        [taskId]
    );

    res.send("Aufgabe archiviert");
});

app.post("/restore-task", async (req, res) => {
    const { taskId } = req.body;

    await pool.query(
        "UPDATE tasks SET archived = false WHERE id = $1",
        [taskId]
    );

    res.send("Aufgabe wiederhergestellt");
});

app.post("/delete-task", async (req, res) => {
    const { taskId } = req.body;

    await pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
    res.send("Aufgabe gelöscht");
});

/* TIMES */
app.get("/times", async (req, res) => {
    const result = await pool.query("SELECT * FROM times ORDER BY id DESC");
    res.json(result.rows);
});

app.post("/start-time", async (req, res) => {
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
    });
    
    app.post("/stop-time", async (req, res) => {
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
            "UPDATE times SET stop_time = $1, report = $2, admin_only = $3 WHERE id = $4",
            [new Date().toLocaleString("de-DE"), report, adminOnly === true, time.id]
        );
    
        await pool.query(
            "UPDATE projects SET current_user_name = '', current_task = '' WHERE name = $1",
            [time.project]
        );
    
        res.send("Gestoppt");
    });

app.post("/delete-time", async (req, res) => {
    const { id } = req.body;

    await pool.query("DELETE FROM times WHERE id = $1", [id]);
    res.send("Zeit gelöscht");
});

/* MESSAGES */
app.get("/messages/:username", async (req, res) => {
    const username = req.params.username;

    const result = await pool.query(
        "SELECT * FROM messages WHERE receiver = $1 OR receiver = 'admin' ORDER BY id DESC",
        [username]
    );

    res.json(result.rows);
});

app.post("/send-message", async (req, res) => {
    const { from, to, text } = req.body;

    await pool.query(
        "INSERT INTO messages (sender, receiver, text, date) VALUES ($1, $2, $3, $4)",
        [from, to, text, new Date().toLocaleString("de-DE")]
    );

    res.send("Nachricht gesendet");
});

app.post("/delete-message", async (req, res) => {
    const { id } = req.body;

    await pool.query("DELETE FROM messages WHERE id = $1", [id]);
    res.send("Nachricht gelöscht");
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Server läuft");
});