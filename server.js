const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const authRoutes = require("./routes/auth");
const app = express();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


app.use("/", authRoutes);
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/login.html", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

app.get("/dashboard.html", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

app.post("/create-user", express.json(), async (req, res) => {

    const { name, pw } = req.body;

    if(!name || !pw){
        return res.send("Daten fehlen");
    }

    try {

        await pool.query(
            "INSERT INTO users (username, password) VALUES ($1, $2)",
            [name, pw]
        );

        res.send("Benutzer erstellt");

    } catch(err){

        res.send("Benutzer existiert bereits");
    }
});

app.get("/users", async (req, res) => {

    const result = await pool.query(
        "SELECT username FROM users ORDER BY username"
    );

    res.json(result.rows);
});

app.post("/edit-user", express.json(), async (req, res) => {

    const { oldName, newName, pw } = req.body;

    if(!oldName || !newName || !pw){
        return res.send("Daten fehlen");
    }

    try{
        await pool.query(
            "UPDATE users SET username = $1, password = $2 WHERE username = $3",
            [newName, pw, oldName]
        );

        res.send("Benutzer geändert");
    }catch(err){
        res.send("Fehler beim Ändern");
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("http://localhost:3000");
});