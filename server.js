const express = require("express");
const path = require("path");
const authRoutes = require("./routes/auth");
const app = express();


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

app.listen(3000, () => {
    console.log("http://localhost:3000");
});