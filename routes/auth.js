const express = require("express");
const router = express.Router();
const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.query(`
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
)
`);

pool.query(`
INSERT INTO users (username, password)
VALUES ('admin', 'admin123')
ON CONFLICT (username) DO NOTHING
`);

router.post("/login", express.urlencoded({ extended: true }), async (req, res) => {

    const username = req.body.username;
    const password = req.body.password;

    const result = await pool.query(
        "SELECT * FROM users WHERE username = $1 AND password = $2",
        [username, password]
    );

    if (result.rows.length > 0) {
        res.redirect("/dashboard");
    } else {
        res.send("Falsche Anmeldedaten");
    }
});

router.get("/logout", (req, res) => {
    res.redirect("/login");
});

module.exports = router;