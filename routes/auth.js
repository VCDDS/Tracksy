const express = require("express");

const router = express.Router();

router.post("/login", (req, res) => {
    res.redirect("/dashboard");
});

router.get("/logout", (req, res) => {
    res.redirect("/login");
});

module.exports = router;