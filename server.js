require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const fs = require("fs");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcrypt");
const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const nodemailer = require("nodemailer");

const app = express();


const mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
    }
});

function sendTracksyNotification(subject, text){
    console.log("📧 Web3Forms-Benachrichtigung wird gestartet...");
    console.log("Betreff:", subject);

    fetch("https://api.web3forms.com/submit", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify({
            access_key: process.env.WEB3FORMS_ACCESS_KEY,
            subject: subject,
            from_name: "Tracksy",
            message: text
        })
    })
    .then(async response => {
        const rawResponse = await response.text();
    
        console.log("📨 Web3Forms HTTP-Status:", response.status);
        console.log("📨 Web3Forms Antwort:", rawResponse);
    
        if(response.ok){
            console.log("✅ Web3Forms Anfrage angenommen");
        }else{
            console.error("❌ Web3Forms Fehler");
        }
    })
    .catch(error => {
        console.error("❌ Web3Forms Verbindung fehlgeschlagen:", error);
    });
}

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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

/* =====================================================
   WEBSEITEN-MONITORING
===================================================== */

const WEBSITE_MONITOR_INTERVAL = 60 * 1000;
const WEBSITE_MONITOR_TIMEOUT = 5000;

let websiteMonitorRunning = false;

function isPrivateIpAddress(address){

    if(!address){
        return true;
    }

    if(net.isIPv4(address)){

        const parts = address
            .split(".")
            .map(Number);

        if(parts[0] === 10){
            return true;
        }

        if(parts[0] === 127){
            return true;
        }

        if(
            parts[0] === 169 &&
            parts[1] === 254
        ){
            return true;
        }

        if(
            parts[0] === 172 &&
            parts[1] >= 16 &&
            parts[1] <= 31
        ){
            return true;
        }

        if(
            parts[0] === 192 &&
            parts[1] === 168
        ){
            return true;
        }

        if(parts[0] === 0){
            return true;
        }

        return false;
    }

    if(net.isIPv6(address)){

        const cleanAddress =
            address.toLowerCase();

        return (
            cleanAddress === "::1" ||
            cleanAddress.startsWith("fc") ||
            cleanAddress.startsWith("fd") ||
            cleanAddress.startsWith("fe80:")
        );
    }

    return true;
}

async function validateMonitoringUrl(value){

    let parsedUrl;

    try{
        parsedUrl = new URL(value);
    }catch{
        throw new Error("Ungültige Webseiten-Adresse");
    }

    if(
        parsedUrl.protocol !== "https:" &&
        parsedUrl.protocol !== "http:"
    ){
        throw new Error(
            "Nur HTTP- und HTTPS-Adressen sind erlaubt"
        );
    }

    if(
        parsedUrl.username ||
        parsedUrl.password
    ){
        throw new Error(
            "Zugangsdaten in der URL sind nicht erlaubt"
        );
    }

    const addresses = await dns.lookup(
        parsedUrl.hostname,
        {
            all: true
        }
    );

    if(
        addresses.length === 0 ||
        addresses.some(item =>
            isPrivateIpAddress(item.address)
        )
    ){
        throw new Error(
            "Lokale oder private Adressen sind nicht erlaubt"
        );
    }

    return parsedUrl.toString();
}

function requestWebsite(url, redirectCount = 0){

    return new Promise((resolve, reject) => {

        if(redirectCount > 5){
            reject(
                new Error("Zu viele Weiterleitungen")
            );

            return;
        }

        const parsedUrl = new URL(url);

        const requestModule =
            parsedUrl.protocol === "https:"
                ? https
                : http;

        const startedAt = Date.now();

        const request = requestModule.request(
            parsedUrl,
            {
                method: "GET",

                headers: {
                    "User-Agent":
                        "Tracksy-Monitor/1.0",

                    "Accept":
                        "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
                },

                timeout:
                    WEBSITE_MONITOR_TIMEOUT
            },
            response => {

                const responseTime =
                    Date.now() - startedAt;

                const statusCode =
                    Number(response.statusCode) || 0;

                const location =
                    response.headers.location;

                response.resume();

                if(
                    statusCode >= 300 &&
                    statusCode < 400 &&
                    location
                ){
                    const redirectUrl =
                        new URL(
                            location,
                            parsedUrl
                        ).toString();

                    requestWebsite(
                        redirectUrl,
                        redirectCount + 1
                    )
                        .then(resolve)
                        .catch(reject);

                    return;
                }

                resolve({
                    httpCode: statusCode,
                    responseTime,
                    isOnline:
                        statusCode >= 200 &&
                        statusCode < 500
                });
            }
        );

        request.on("timeout", () => {
            request.destroy(
                new Error("Zeitüberschreitung")
            );
        });

        request.on("error", reject);

        request.end();
    });
}

async function saveWebsiteCheck(
    website,
    checkResult
){

    const checkedAt =
        new Date();

    const status =
        checkResult.isOnline
            ? (
                checkResult.responseTime > 1000
                    ? "Langsam"
                    : "Online"
            )
            : "Offline";

    await pool.query(`
        UPDATE monitored_websites

        SET
            last_status = $1,
            last_http_code = $2,
            last_response_time = $3,
            last_checked_at = $4,
            last_error = $5,
            updated_at = NOW()

        WHERE id = $6
    `, [
        status,
        checkResult.httpCode || null,
        checkResult.responseTime || null,
        checkedAt,
        checkResult.error || "",
        website.id
    ]);

    await pool.query(`
        INSERT INTO website_monitor_checks (
            website_id,
            status,
            http_code,
            response_time,
            error_message,
            checked_at
        )

        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6
        )
    `, [
        website.id,
        status,
        checkResult.httpCode || null,
        checkResult.responseTime || null,
        checkResult.error || "",
        checkedAt
    ]);

    await pool.query(`
        DELETE FROM website_monitor_checks

        WHERE id IN (
            SELECT id

            FROM website_monitor_checks

            WHERE website_id = $1

            ORDER BY checked_at DESC

            OFFSET 500
        )
    `, [
        website.id
    ]);
}

async function checkMonitoredWebsite(website){

    try{

        const safeUrl =
            await validateMonitoringUrl(
                website.url
            );

        const result =
            await requestWebsite(safeUrl);

        await saveWebsiteCheck(
            website,
            result
        );

        return {
            success: true,
            ...result
        };

    }catch(error){

        await saveWebsiteCheck(
            website,
            {
                isOnline: false,
                httpCode: null,
                responseTime: null,
                error:
                    error.message ||
                    "Webseite nicht erreichbar"
            }
        );

        return {
            success: false,
            error:
                error.message ||
                "Webseite nicht erreichbar"
        };
    }
}

async function runWebsiteMonitoring(){

    if(websiteMonitorRunning){
        return;
    }

    websiteMonitorRunning = true;

    try{

        const result = await pool.query(`
            SELECT *

            FROM monitored_websites

            WHERE is_active = true

            ORDER BY id ASC
        `);

        for(const website of result.rows){
            await checkMonitoredWebsite(
                website
            );
        }

    }catch(error){

        console.error(
            "Webseiten-Monitoring Fehler:",
            error
        );

    }finally{

        websiteMonitorRunning = false;
    }
}

function startWebsiteMonitoring(){

    runWebsiteMonitoring();

    setInterval(
        runWebsiteMonitoring,
        WEBSITE_MONITOR_INTERVAL
    );
}

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

const planningPriorities = new Set([
    "Niedrig",
    "Normal",
    "Hoch"
]);

const planningStatuses = new Set([
    "Offen",
    "In Bearbeitung",
    "Erledigt"
]);

function isValidPlanningDate(value){
    if(
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ){
        return false;
    }

    const [year, month, day] = value
        .split("-")
        .map(Number);

    const date = new Date(
        Date.UTC(year, month - 1, day)
    );

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function isValidPlanningTime(value){
    return typeof value === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

async function savePlanningDayOff(
    userId,
    workDate,
    isDayOff,
    createdBy
){
    if(isDayOff){
        await pool.query(`
            INSERT INTO work_schedules (
                user_id,
                work_date,
                start_time,
                end_time,
                is_day_off,
                created_by
            )
            VALUES (
                $1,
                $2::date,
                NULL,
                NULL,
                true,
                $3
            )
            ON CONFLICT (
                user_id,
                work_date
            )
            DO UPDATE SET
                start_time = NULL,
                end_time = NULL,
                is_day_off = true,
                updated_at = NOW()
        `, [
            userId,
            workDate,
            createdBy
        ]);

        return "Tag als Frei – Keine Entwicklung gespeichert";
    }

    await pool.query(`
        UPDATE work_schedules
        SET
            is_day_off = false,
            updated_at = NOW()
        WHERE user_id = $1
        AND work_date = $2::date
    `, [
        userId,
        workDate
    ]);

    return "Freier Tag aufgehoben";
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
        CREATE TABLE IF NOT EXISTS work_schedules (
            id SERIAL PRIMARY KEY,
    
            user_id INTEGER NOT NULL
                REFERENCES users(id)
                ON DELETE CASCADE,
    
            work_date DATE NOT NULL,
    
            start_time TIME DEFAULT NULL,
end_time TIME DEFAULT NULL,
is_day_off BOOLEAN NOT NULL DEFAULT false,

created_by TEXT DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
    
            UNIQUE(user_id, work_date),
    
            CONSTRAINT work_schedules_time_check
            CHECK (
                start_time IS NULL
                OR end_time IS NULL
                OR end_time > start_time
            )
        )
        `);

    await pool.query(`
        ALTER TABLE work_schedules
        ADD COLUMN IF NOT EXISTS is_day_off BOOLEAN NOT NULL DEFAULT false
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS work_tasks (
            id SERIAL PRIMARY KEY,
    
            schedule_id INTEGER NOT NULL
                REFERENCES work_schedules(id)
                ON DELETE CASCADE,
    
            title TEXT NOT NULL,
    
            priority TEXT NOT NULL DEFAULT 'Normal',
            status TEXT NOT NULL DEFAULT 'Offen',
    
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
    
            CONSTRAINT work_tasks_priority_check
            CHECK (
                priority IN (
                    'Niedrig',
                    'Normal',
                    'Hoch'
                )
            ),
    
            CONSTRAINT work_tasks_status_check
            CHECK (
                status IN (
                    'Offen',
                    'In Bearbeitung',
                    'Erledigt'
                )
            )
        )
    `);
    
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_work_schedules_date
        ON work_schedules(work_date)
    `);
    
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_work_tasks_schedule
        ON work_tasks(schedule_id)
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
    
            previous_tariff TEXT DEFAULT '',
            previous_billing_cycle TEXT DEFAULT '',
    
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
        ALTER TABLE service_tariffs
        ADD COLUMN IF NOT EXISTS previous_tariff TEXT DEFAULT ''
    `);
    
    await pool.query(`
        ALTER TABLE service_tariffs
        ADD COLUMN IF NOT EXISTS previous_billing_cycle TEXT DEFAULT ''
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
        ALTER TABLE service_packages
        ADD COLUMN IF NOT EXISTS offer_enabled BOOLEAN DEFAULT false
    `);
    
    await pool.query(`
        ALTER TABLE service_packages
        ADD COLUMN IF NOT EXISTS offer_name TEXT DEFAULT ''
    `);
    
    await pool.query(`
        ALTER TABLE service_packages
        ADD COLUMN IF NOT EXISTS offer_monthly_price NUMERIC(10,2) DEFAULT 0
    `);
    
    await pool.query(`
        ALTER TABLE service_packages
        ADD COLUMN IF NOT EXISTS offer_yearly_price NUMERIC(10,2) DEFAULT 0
    `);
    
    await pool.query(`
        ALTER TABLE service_packages
        ADD COLUMN IF NOT EXISTS offer_use_end_date BOOLEAN DEFAULT false
    `);
    
    await pool.query(`
        ALTER TABLE service_packages
        ADD COLUMN IF NOT EXISTS offer_end_date TEXT DEFAULT ''
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS service_addons (
            id SERIAL PRIMARY KEY,
            service_name TEXT NOT NULL UNIQUE,
            price_once NUMERIC(10,2) DEFAULT 0,
            status TEXT DEFAULT 'available',
            updated_at TEXT DEFAULT ''
        )
    `);
    
    await pool.query(`
        INSERT INTO service_addons
            (service_name, price_once)
        VALUES
            ('Neue Webseite', 399.00),
            ('Neue Unterseite', 49.90),
            ('Umfangreiche Designänderungen', 199.00),
            ('Individuelle Funktionen', 99.00),
            ('Schnittstellen und Integrationen', 99.00)
        ON CONFLICT (service_name)
        DO NOTHING
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

    /* =====================================================
   ZENTRALER SERVICEKATALOG
===================================================== */

await pool.query(`
    ALTER TABLE service_packages
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS subtitle TEXT,
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS icon TEXT,
    ADD COLUMN IF NOT EXISTS features JSONB,
    ADD COLUMN IF NOT EXISTS recommended BOOLEAN,
    ADD COLUMN IF NOT EXISTS recommendation_text TEXT,
    ADD COLUMN IF NOT EXISTS sort_order INTEGER
`);

await pool.query(`
    UPDATE service_packages
    SET
        display_name = tariff,

        subtitle = CASE tariff
            WHEN 'Lite'
                THEN 'Für kleine Webseiten'
            WHEN 'Normal'
                THEN 'Für regelmäßige Unterstützung'
            WHEN 'Premium'
                THEN 'Rundum-Betreuung'
            ELSE ''
        END,

        description = CASE tariff
            WHEN 'Lite'
                THEN 'Grundlegende Absicherung und Unterstützung für kleinere Webseiten.'
            WHEN 'Normal'
                THEN 'Der empfohlene Tarif für eine zuverlässige laufende Betreuung.'
            WHEN 'Premium'
                THEN 'Umfassende Betreuung für Webseiten mit höheren Anforderungen.'
            ELSE ''
        END,

        icon = CASE tariff
            WHEN 'Lite' THEN '🌿'
            WHEN 'Normal' THEN '⭐'
            WHEN 'Premium' THEN '💎'
            ELSE '📦'
        END,

        features = CASE tariff
            WHEN 'Lite' THEN
                '[
                    "Sicherheitsupdates",
                    "Versionsupdates",
                    "Regelmäßige Fehlerprüfung",
                    "Fehlerbehebung",
                    "Kleine Designanpassungen",
                    "Support per E-Mail oder WhatsApp"
                ]'::jsonb

            WHEN 'Normal' THEN
                '[
                    "Alle Leistungen aus Lite",
                    "Erweiterte Fehlerbehebung",
                    "Performance- und Funktionsprüfung",
                    "Kleinere Inhaltsänderungen",
                    "Bevorzugte Bearbeitung von Supportanfragen"
                ]'::jsonb

            WHEN 'Premium' THEN
                '[
                    "Alle Leistungen aus Normal",
                    "Regelmäßige Optimierung der Webseite",
                    "Individuelle Beratung",
                    "Monatlicher System- und Funktionscheck",
                    "Planung und Empfehlung zukünftiger Verbesserungen"
                ]'::jsonb

            ELSE '[]'::jsonb
        END,

        recommended =
            CASE
                WHEN tariff = 'Normal' THEN true
                ELSE false
            END,

        recommendation_text =
            CASE
                WHEN tariff = 'Normal'
                    THEN 'Beliebteste Wahl'
                ELSE ''
            END,

        sort_order = CASE tariff
            WHEN 'Lite' THEN 1
            WHEN 'Normal' THEN 2
            WHEN 'Premium' THEN 3
            ELSE id
        END

    WHERE display_name IS NULL
`);

await pool.query(`
    ALTER TABLE service_packages
    ALTER COLUMN display_name SET DEFAULT '',
    ALTER COLUMN subtitle SET DEFAULT '',
    ALTER COLUMN description SET DEFAULT '',
    ALTER COLUMN icon SET DEFAULT '📦',
    ALTER COLUMN features SET DEFAULT '[]'::jsonb,
    ALTER COLUMN recommended SET DEFAULT false,
    ALTER COLUMN recommendation_text SET DEFAULT '',
    ALTER COLUMN sort_order SET DEFAULT 0
`);

await pool.query(`
    ALTER TABLE service_addons
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS icon TEXT,
    ADD COLUMN IF NOT EXISTS price_prefix TEXT,
    ADD COLUMN IF NOT EXISTS sort_order INTEGER
`);

await pool.query(`
    UPDATE service_addons
    SET
        display_name = CASE service_name
            WHEN 'Umfangreiche Designänderungen'
                THEN 'Designänderungen'
            WHEN 'Schnittstellen und Integrationen'
                THEN 'Schnittstellen & Integrationen'
            ELSE service_name
        END,

        description = CASE service_name
            WHEN 'Neue Webseite'
                THEN 'Komplette Erstellung einer neuen Webseite.'
            WHEN 'Neue Unterseite'
                THEN 'Erweiterung einer bestehenden Webseite.'
            WHEN 'Umfangreiche Designänderungen'
                THEN 'Umfangreiche optische Anpassungen.'
            WHEN 'Individuelle Funktionen'
                THEN 'Neue Funktionen passend zur Webseite.'
            WHEN 'Schnittstellen und Integrationen'
                THEN 'Anbindung externer Dienste und Systeme.'
            ELSE ''
        END,

        icon = CASE service_name
            WHEN 'Neue Webseite' THEN '🖥️'
            WHEN 'Neue Unterseite' THEN '📄'
            WHEN 'Umfangreiche Designänderungen' THEN '🎨'
            WHEN 'Individuelle Funktionen' THEN '💻'
            WHEN 'Schnittstellen und Integrationen' THEN '🧩'
            ELSE '🛠️'
        END,

        price_prefix = 'ab',

        sort_order = CASE service_name
            WHEN 'Neue Webseite' THEN 1
            WHEN 'Neue Unterseite' THEN 2
            WHEN 'Umfangreiche Designänderungen' THEN 3
            WHEN 'Individuelle Funktionen' THEN 4
            WHEN 'Schnittstellen und Integrationen' THEN 5
            ELSE id
        END

    WHERE display_name IS NULL
`);

await pool.query(`
    ALTER TABLE service_addons
    ALTER COLUMN display_name SET DEFAULT '',
    ALTER COLUMN description SET DEFAULT '',
    ALTER COLUMN icon SET DEFAULT '🛠️',
    ALTER COLUMN price_prefix SET DEFAULT 'ab',
    ALTER COLUMN sort_order SET DEFAULT 0
`);

await pool.query(`
    UPDATE service_packages
    SET status = 'unavailable'
    WHERE status = 'waiting'
`);

await pool.query(`
    UPDATE service_addons
    SET status = 'unavailable'
    WHERE status = 'waiting'
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
        ALTER TABLE service_requests
        ADD COLUMN IF NOT EXISTS customer_hidden BOOLEAN NOT NULL DEFAULT false
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
    ALTER TABLE suggestion_comments
    ADD COLUMN IF NOT EXISTS parent_comment_id INTEGER DEFAULT NULL
`);

/* =====================================================
   PROJEKTANFRAGEN
===================================================== */

await pool.query(`
    CREATE TABLE IF NOT EXISTS project_requests (
        id SERIAL PRIMARY KEY,

        name TEXT NOT NULL,
        company TEXT DEFAULT '',
        email TEXT NOT NULL,
        phone TEXT NOT NULL,

        project_name TEXT NOT NULL,
        project_type TEXT NOT NULL,

        description TEXT NOT NULL,
        requested_functions TEXT NOT NULL,

        project_start DATE DEFAULT NULL,
        deadline DATE NOT NULL,

        budget TEXT DEFAULT '',
        notes TEXT DEFAULT '',

        status TEXT NOT NULL DEFAULT 'Offen',

        admin_note TEXT DEFAULT '',
        created_project_id INTEGER DEFAULT NULL,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT project_requests_status_check
        CHECK (
            status IN (
                'Offen',
                'In Bearbeitung',
                'Angenommen',
                'Abgelehnt',
                'Projekt erstellt'
            )
        )
    )
`);

await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_project_requests_status
    ON project_requests(status)
`);

await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_project_requests_created_at
    ON project_requests(created_at DESC)
`);

/* =====================================================
   WEBSEITEN-MONITORING
===================================================== */

await pool.query(`
    CREATE TABLE IF NOT EXISTS monitored_websites (
        id SERIAL PRIMARY KEY,

        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,

        is_active BOOLEAN NOT NULL DEFAULT true,

        last_status TEXT NOT NULL DEFAULT 'Ungeprüft',
        last_http_code INTEGER DEFAULT NULL,
        last_response_time INTEGER DEFAULT NULL,
        last_checked_at TIMESTAMPTZ DEFAULT NULL,
        last_error TEXT NOT NULL DEFAULT '',

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
`);

await pool.query(`
    CREATE TABLE IF NOT EXISTS website_monitor_checks (
        id BIGSERIAL PRIMARY KEY,

        website_id INTEGER NOT NULL
            REFERENCES monitored_websites(id)
            ON DELETE CASCADE,

        status TEXT NOT NULL,
        http_code INTEGER DEFAULT NULL,
        response_time INTEGER DEFAULT NULL,
        error_message TEXT NOT NULL DEFAULT '',
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
`);

await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_website_monitor_checks_website_date

    ON website_monitor_checks (
        website_id,
        checked_at DESC
    )
`);

await pool.query(`
    INSERT INTO monitored_websites (
        name,
        url
    )

    VALUES
        (
            'Tracksy',
            'https://tracksy.onrender.com'
        ),
        (
            'RadioNetz',
            'https://radionetz-zwickau.onrender.com'
        )

    ON CONFLICT (url)
    DO NOTHING
`);
}

initDatabase()
    .then(() => {

        console.log(
            "Datenbank erfolgreich initialisiert"
        );

        startWebsiteMonitoring();
    })
    .catch(err => {

        console.log(
            "Datenbank Fehler:",
            err
        );
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

/* =====================================================
   ÖFFENTLICHE PROJEKTANFRAGEN
===================================================== */

function cleanProjectRequestText(
    value,
    maximumLength = 1000
){
    if(typeof value !== "string"){
        return "";
    }

    return value
        .replace(/\0/g, "")
        .trim()
        .slice(0, maximumLength);
}

function isValidProjectRequestEmail(value){

    if(typeof value !== "string"){
        return false;
    }

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        value.trim()
    );
}

function isValidProjectRequestDate(value){

    if(value === ""){
        return true;
    }

    if(
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ){
        return false;
    }

    const [
        year,
        month,
        day
    ] = value
        .split("-")
        .map(Number);

    const date = new Date(
        Date.UTC(
            year,
            month - 1,
            day
        )
    );

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

app.post(
    "/create-project-request",
    async (req, res) => {

        try{

            const name =
                cleanProjectRequestText(
                    req.body.name,
                    150
                );

            const company =
                cleanProjectRequestText(
                    req.body.company,
                    150
                );

            const email =
                cleanProjectRequestText(
                    req.body.email,
                    250
                ).toLowerCase();

            const phone =
                cleanProjectRequestText(
                    req.body.phone,
                    80
                );

            const projectName =
                cleanProjectRequestText(
                    req.body.projectName,
                    200
                );

            const projectType =
                cleanProjectRequestText(
                    req.body.projectType,
                    150
                );

            const description =
                cleanProjectRequestText(
                    req.body.description,
                    5000
                );

            const requestedFunctions =
                cleanProjectRequestText(
                    req.body.requestedFunctions,
                    5000
                );

            const projectStart =
                cleanProjectRequestText(
                    req.body.projectStart,
                    10
                );

            const deadline =
                cleanProjectRequestText(
                    req.body.deadline,
                    10
                );

            const budget =
                cleanProjectRequestText(
                    req.body.budget,
                    150
                );

            const notes =
                cleanProjectRequestText(
                    req.body.notes,
                    5000
                );

            if(
                !name ||
                !email ||
                !phone ||
                !projectName ||
                !projectType ||
                !description ||
                !requestedFunctions ||
                !deadline
            ){
                return res.status(400).json({
                    success: false,
                    message:
                        "Bitte alle Pflichtfelder ausfüllen."
                });
            }

            if(
                !isValidProjectRequestEmail(
                    email
                )
            ){
                return res.status(400).json({
                    success: false,
                    message:
                        "Bitte eine gültige E-Mail-Adresse eingeben."
                });
            }

            if(
                !isValidProjectRequestDate(
                    projectStart
                ) ||
                !isValidProjectRequestDate(
                    deadline
                )
            ){
                return res.status(400).json({
                    success: false,
                    message:
                        "Bitte gültige Datumswerte eingeben."
                });
            }

            if(!deadline){
                return res.status(400).json({
                    success: false,
                    message:
                        "Bitte einen gewünschten Fertigstellungstermin eingeben."
                });
            }

            if(
                projectStart &&
                deadline < projectStart
            ){
                return res.status(400).json({
                    success: false,
                    message:
                        "Der Fertigstellungstermin darf nicht vor dem Projektstart liegen."
                });
            }

            const result = await pool.query(`
                INSERT INTO project_requests (
                    name,
                    company,
                    email,
                    phone,
                    project_name,
                    project_type,
                    description,
                    requested_functions,
                    project_start,
                    deadline,
                    budget,
                    notes
                )

                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    NULLIF($9, '')::date,
                    $10::date,
                    $11,
                    $12
                )

                RETURNING
                    id,
                    status,
                    created_at
            `, [
                name,
                company,
                email,
                phone,
                projectName,
                projectType,
                description,
                requestedFunctions,
                projectStart,
                deadline,
                budget,
                notes
            ]);

            await mailTransporter.sendMail({
                from: `"Tracksy Projektanfragen" <${process.env.SMTP_USER}>`,
                to: process.env.PROJECT_REQUEST_EMAIL,
                replyTo: email,
                subject: `Neue Projektanfrage: ${projectName}`,
                text: `
            Neue Projektanfrage über Tracksy
            
            KONTAKTDATEN
            Name: ${name}
            Unternehmen: ${company || "Nicht angegeben"}
            E-Mail: ${email}
            Telefon: ${phone}
            
            PROJEKT
            Projektname: ${projectName}
            Projektart: ${projectType}
            
            BESCHREIBUNG
            ${description}
            
            GEWÜNSCHTE FUNKTIONEN
            ${requestedFunctions}
            
            ZEITRAUM
            Projektstart: ${projectStart || "Nicht angegeben"}
            Fertigstellung: ${deadline}
            
            BUDGET
            ${budget || "Nicht angegeben"}
            
            WEITERE INFORMATIONEN
            ${notes || "Keine weiteren Informationen"}
                `.trim()
            });

            return res.status(201).json({
                success: true,
                message:
                    "Projektanfrage wurde erfolgreich gesendet.",
                requestId:
                    result.rows[0].id
            });

        }catch(error){

            console.error(
                "Projektanfrage konnte nicht gespeichert werden:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    error.message ||
                    "Projektanfrage konnte nicht gesendet werden."
            });
        }
    }
);

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

/* =====================================================
   DIENSTPLAN & AUFGABEN
===================================================== */

app.get("/work-planning", async (req, res) => {
    try{
        const {
            weekStart,
            adminUsername
        } = req.query;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).json({
                error: "Keine Berechtigung"
            });
        }

        if(!isValidPlanningDate(weekStart)){
            return res.status(400).json({
                error: "Ungültiger Wochenbeginn"
            });
        }

        const usersResult = await pool.query(`
            SELECT
                id,
                username

            FROM users

            WHERE COALESCE(
                NULLIF(role, ''),
                CASE
                    WHEN is_admin = true THEN 'admin'
                    ELSE 'user'
                END
            ) != 'kunde'

            ORDER BY username ASC
        `);

        const schedulesResult = await pool.query(`
            SELECT
                ws.id,
                ws.user_id,

                TO_CHAR(
                    ws.work_date,
                    'YYYY-MM-DD'
                ) AS work_date,

                TO_CHAR(
                    ws.start_time,
                    'HH24:MI'
                ) AS start_time,

                TO_CHAR(
                    ws.end_time,
                    'HH24:MI'
                ) AS end_time,

COALESCE(
    ws.is_day_off,
    false
) AS is_day_off,

COALESCE(
    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', wt.id,
                            'title', wt.title,
                            'priority', wt.priority,
                            'status', wt.status
                        )

                        ORDER BY
                            (wt.status = 'Erledigt'),
                            wt.id
                    )

                    FILTER (
                        WHERE wt.id IS NOT NULL
                    ),

                    '[]'::json
                ) AS tasks

            FROM work_schedules ws

            LEFT JOIN work_tasks wt
                ON wt.schedule_id = ws.id

            WHERE ws.work_date BETWEEN
                $1::date
                AND
                (
                    $1::date +
                    INTERVAL '6 days'
                )::date

            GROUP BY
                ws.id,
                ws.user_id,
                ws.work_date,
                ws.start_time,
ws.end_time,
ws.is_day_off

ORDER BY
                ws.work_date ASC,
                ws.user_id ASC
        `, [
            weekStart
        ]);

        res.json({
            users: usersResult.rows,
            schedules: schedulesResult.rows
        });

    }catch(err){
        console.log(err);

        res.status(500).json({
            error: "Dienstplanung konnte nicht geladen werden"
        });
    }
});

app.get("/my-work-plan/:username", async (req, res) => {
    try{
        const username = req.params.username;
        const { weekStart } = req.query;

        if(!isValidPlanningDate(weekStart)){
            return res.status(400).json({
                error: "Ungültiger Wochenbeginn"
            });
        }

        const userResult = await pool.query(`
            SELECT
                id,
                username

            FROM users

            WHERE username = $1

            AND COALESCE(
                NULLIF(role, ''),
                CASE
                    WHEN is_admin = true THEN 'admin'
                    ELSE 'user'
                END
            ) != 'kunde'

            LIMIT 1
        `, [
            username
        ]);

        if(userResult.rows.length === 0){
            return res.status(404).json({
                error: "Benutzer nicht gefunden"
            });
        }

        const user = userResult.rows[0];

        const schedulesResult = await pool.query(`
            SELECT
                ws.id,
                ws.user_id,

                TO_CHAR(
                    ws.work_date,
                    'YYYY-MM-DD'
                ) AS work_date,

                TO_CHAR(
                    ws.start_time,
                    'HH24:MI'
                ) AS start_time,

                TO_CHAR(
                    ws.end_time,
                    'HH24:MI'
                ) AS end_time,

COALESCE(
    ws.is_day_off,
    false
) AS is_day_off,

COALESCE(
    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', wt.id,
                            'title', wt.title,
                            'priority', wt.priority,
                            'status', wt.status
                        )

                        ORDER BY wt.id
                    )

                    FILTER (
                        WHERE wt.id IS NOT NULL
                        AND wt.status != 'Erledigt'
                    ),

                    '[]'::json
                ) AS tasks

            FROM work_schedules ws

            LEFT JOIN work_tasks wt
                ON wt.schedule_id = ws.id

            WHERE ws.user_id = $1

            AND ws.work_date BETWEEN
                $2::date
                AND
                (
                    $2::date +
                    INTERVAL '6 days'
                )::date

            GROUP BY
                ws.id,
                ws.user_id,
                ws.work_date,
                ws.start_time,
ws.end_time,
ws.is_day_off

ORDER BY ws.work_date ASC
        `, [
            user.id,
            weekStart
        ]);

        res.json({
            user,
            schedules: schedulesResult.rows
        });

    }catch(err){
        console.log(err);

        res.status(500).json({
            error: "Dienstplan konnte nicht geladen werden"
        });
    }
});

app.post("/save-work-schedule", async (req, res) => {
    try{
        const {
            adminUsername,
            userId,
            workDate,
            startTime,
            endTime
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        if(
            !userId ||
            !isValidPlanningDate(workDate)
        ){
            return res.send(
                "Ungültige Dienstplandaten"
            );
        }

        const cleanStart = String(
            startTime || ""
        ).trim();

        const cleanEnd = String(
            endTime || ""
        ).trim();

        if(
            !isValidPlanningTime(cleanStart) ||
            !isValidPlanningTime(cleanEnd)
        ){
            return res.send(
                "Start- und Endzeit fehlen"
            );
        }

        if(cleanEnd <= cleanStart){
            return res.send(
                "Endzeit muss nach der Startzeit liegen"
            );
        }

        const userCheck = await pool.query(`
            SELECT id
            FROM users
            WHERE id = $1
        `, [
            userId
        ]);

        if(userCheck.rows.length === 0){
            return res.send(
                "Benutzer nicht gefunden"
            );
        }

        await pool.query(`
            INSERT INTO work_schedules (
                user_id,
                work_date,
                start_time,
                end_time,
                created_by
            )

            VALUES (
                $1,
                $2::date,
                $3::time,
                $4::time,
                $5
            )

            ON CONFLICT (
                user_id,
                work_date
            )

            DO UPDATE SET
    start_time = EXCLUDED.start_time,
    end_time = EXCLUDED.end_time,
    is_day_off = false,
    updated_at = NOW()
        `, [
            userId,
            workDate,
            cleanStart,
            cleanEnd,
            adminUsername
        ]);

        res.send("Dienstzeit gespeichert");

    }catch(err){
        console.log(err);
        res.send("Dienstzeit konnte nicht gespeichert werden");
    }
});

app.post("/set-work-day-off", async (req, res) => {
    try{
        const {
            adminUsername,
            userId,
            workDate,
            isDayOff
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        if(
            !userId ||
            !isValidPlanningDate(workDate) ||
            typeof isDayOff !== "boolean"
        ){
            return res.send(
                "Ungültige Tagesdaten"
            );
        }

        const userCheck = await pool.query(`
            SELECT id
            FROM users
            WHERE id = $1
        `, [
            userId
        ]);

        if(userCheck.rows.length === 0){
            return res.send(
                "Benutzer nicht gefunden"
            );
        }

        const message = await savePlanningDayOff(
            userId,
            workDate,
            isDayOff,
            adminUsername
        );

        res.send(message);

    }catch(err){
        console.log(err);
        res.send(
            "Tagesstatus konnte nicht gespeichert werden"
        );
    }
});

app.post("/set-my-work-day-off", async (req, res) => {
    try{
        const {
            username,
            workDate,
            isDayOff
        } = req.body;

        if(
            !username ||
            !isValidPlanningDate(workDate) ||
            typeof isDayOff !== "boolean"
        ){
            return res.send(
                "Ungültige Tagesdaten"
            );
        }

        const userResult = await pool.query(`
            SELECT id
            FROM users
            WHERE username = $1

            AND COALESCE(
                NULLIF(role, ''),
                CASE
                    WHEN is_admin = true THEN 'admin'
                    ELSE 'user'
                END
            ) != 'kunde'

            LIMIT 1
        `, [
            username
        ]);

        if(userResult.rows.length === 0){
            return res.send(
                "Benutzer nicht gefunden"
            );
        }

        const userId = userResult.rows[0].id;

        const message = await savePlanningDayOff(
            userId,
            workDate,
            isDayOff,
            username
        );

        res.send(message);

    }catch(err){
        console.log(err);
        res.send(
            "Tagesstatus konnte nicht gespeichert werden"
        );
    }
});

app.post("/clear-work-schedule-time", async (req, res) => {
    try{
        const {
            adminUsername,
            scheduleId
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        await pool.query(`
            UPDATE work_schedules

            SET
                start_time = NULL,
                end_time = NULL,
                updated_at = NOW()

            WHERE id = $1
        `, [
            scheduleId
        ]);

        res.send("Dienstzeit entfernt");

    }catch(err){
        console.log(err);
        res.send("Dienstzeit konnte nicht entfernt werden");
    }
});

app.post("/create-work-task", async (req, res) => {
    try{
        const {
            adminUsername,
            userId,
            workDate,
            title,
            priority
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        if(
            !userId ||
            !isValidPlanningDate(workDate) ||
            !title ||
            !title.trim()
        ){
            return res.send(
                "Aufgabendaten fehlen"
            );
        }

        const finalPriority =
            planningPriorities.has(priority)
                ? priority
                : "Normal";

        await pool.query(`
            WITH selected_schedule AS (

                INSERT INTO work_schedules (
                    user_id,
                    work_date,
                    created_by
                )

                VALUES (
                    $1,
                    $2::date,
                    $3
                )

                ON CONFLICT (
                    user_id,
                    work_date
                )

                DO UPDATE SET
    is_day_off = false,
    updated_at = NOW()

RETURNING id
            )

            INSERT INTO work_tasks (
                schedule_id,
                title,
                priority,
                status
            )

            SELECT
                id,
                $4,
                $5,
                'Offen'

            FROM selected_schedule
        `, [
            userId,
            workDate,
            adminUsername,
            title.trim().slice(0, 300),
            finalPriority
        ]);

        res.send("Aufgabe erstellt");

    }catch(err){
        console.log(err);
        res.send("Aufgabe konnte nicht erstellt werden");
    }
});

app.post("/edit-work-task", async (req, res) => {
    try{
        const {
            adminUsername,
            id,
            title,
            priority,
            status
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        if(
            !id ||
            !title ||
            !title.trim()
        ){
            return res.send(
                "Aufgabendaten fehlen"
            );
        }

        const finalPriority =
            planningPriorities.has(priority)
                ? priority
                : "Normal";

        const finalStatus =
            planningStatuses.has(status)
                ? status
                : "Offen";

        const result = await pool.query(`
            UPDATE work_tasks

            SET
                title = $1,
                priority = $2,
                status = $3,
                updated_at = NOW()

            WHERE id = $4

            RETURNING id
        `, [
            title.trim().slice(0, 300),
            finalPriority,
            finalStatus,
            id
        ]);

        if(result.rows.length === 0){
            return res.send(
                "Aufgabe nicht gefunden"
            );
        }

        res.send("Aufgabe geändert");

    }catch(err){
        console.log(err);
        res.send("Aufgabe konnte nicht geändert werden");
    }
});

app.post("/delete-work-task", async (req, res) => {
    try{
        const {
            adminUsername,
            id
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        const result = await pool.query(`
            DELETE FROM work_tasks

            WHERE id = $1

            RETURNING id
        `, [
            id
        ]);

        if(result.rows.length === 0){
            return res.send(
                "Aufgabe nicht gefunden"
            );
        }

        res.send("Aufgabe gelöscht");

    }catch(err){
        console.log(err);
        res.send("Aufgabe konnte nicht gelöscht werden");
    }
});

app.post("/update-my-work-task-status", async (req, res) => {
    try{
        const {
            username,
            id,
            status
        } = req.body;

        if(
            !username ||
            !id ||
            !planningStatuses.has(status)
        ){
            return res.send(
                "Ungültiger Status"
            );
        }

        const result = await pool.query(`
            UPDATE work_tasks wt

            SET
                status = $1,
                updated_at = NOW()

            FROM
                work_schedules ws,
                users u

            WHERE wt.id = $2
            AND wt.schedule_id = ws.id
            AND ws.user_id = u.id
            AND u.username = $3

            RETURNING wt.id
        `, [
            status,
            id,
            username
        ]);

        if(result.rows.length === 0){
            return res.send(
                "Aufgabe nicht gefunden oder keine Berechtigung"
            );
        }

        res.send("Status gespeichert");

    }catch(err){
        console.log(err);
        res.send("Status konnte nicht gespeichert werden");
    }
});


/* =====================================================
   WEBSEITEN-MONITORING API
===================================================== */

app.get("/website-monitoring", async (req, res) => {

    try{

        const adminUsername =
            req.query.adminUsername;

        if(
            !await isRealAdmin(
                adminUsername
            )
        ){
            return res.status(403).json({
                error: "Keine Berechtigung"
            });
        }

        const websitesResult =
            await pool.query(`
                SELECT
                    id,
                    name,
                    url,
                    is_active,
                    last_status,
                    last_http_code,
                    last_response_time,
                    last_checked_at,
                    last_error,
                    created_at,
                    updated_at

                FROM monitored_websites

                ORDER BY name ASC
            `);

        const historyResult =
            await pool.query(`
                SELECT
                    id,
                    website_id,
                    status,
                    http_code,
                    response_time,
                    error_message,
                    checked_at

                FROM website_monitor_checks

                WHERE checked_at >=
                    NOW() - INTERVAL '24 hours'

                ORDER BY checked_at ASC
            `);

        const websites =
            websitesResult.rows.map(
                website => ({
                    ...website,

                    history:
                        historyResult.rows.filter(
                            check =>
                                Number(
                                    check.website_id
                                ) ===
                                Number(
                                    website.id
                                )
                        )
                })
            );

        res.json({
            websites
        });

    }catch(error){

        console.error(error);

        res.status(500).json({
            error:
                "Monitoring konnte nicht geladen werden"
        });
    }
});

app.post("/create-monitored-website", async (req, res) => {

    try{

        const {
            adminUsername,
            name,
            url
        } = req.body;

        if(
            !await isRealAdmin(
                adminUsername
            )
        ){
            return res
                .status(403)
                .send("Keine Berechtigung");
        }

        const cleanName =
            String(name || "")
                .trim()
                .slice(0, 100);

        if(!cleanName){
            return res.send(
                "Name fehlt"
            );
        }

        const cleanUrl =
            await validateMonitoringUrl(
                String(url || "").trim()
            );

        const result = await pool.query(`
            INSERT INTO monitored_websites (
                name,
                url
            )

            VALUES (
                $1,
                $2
            )

            RETURNING *
        `, [
            cleanName,
            cleanUrl
        ]);

        await checkMonitoredWebsite(
            result.rows[0]
        );

        res.send(
            "Webseite hinzugefügt"
        );

    }catch(error){

        console.error(error);

        if(error.code === "23505"){
            return res.send(
                "Diese Webseite ist bereits vorhanden"
            );
        }

        res.send(
            error.message ||
            "Webseite konnte nicht hinzugefügt werden"
        );
    }
});

app.post("/edit-monitored-website", async (req, res) => {

    try{

        const {
            adminUsername,
            id,
            name,
            url,
            isActive
        } = req.body;

        if(
            !await isRealAdmin(
                adminUsername
            )
        ){
            return res
                .status(403)
                .send("Keine Berechtigung");
        }

        const cleanName =
            String(name || "")
                .trim()
                .slice(0, 100);

        if(!cleanName){
            return res.send(
                "Name fehlt"
            );
        }

        const cleanUrl =
            await validateMonitoringUrl(
                String(url || "").trim()
            );

            const result = await pool.query(`
                UPDATE monitored_websites
            
                SET
                    name = $1,
                    url = $2,
                    is_active = $3,
                    updated_at = NOW()
            
                WHERE id = $4
            
                RETURNING *
            `, [
                cleanName,
                cleanUrl,
                isActive === true,
                id
            ]);
            
            if(result.rows.length === 0){
                return res.send(
                    "Webseite nicht gefunden"
                );
            }
            
            if(result.rows[0].is_active){
                await checkMonitoredWebsite(
                    result.rows[0]
                );
            }
            
            res.send(
                "Webseite gespeichert"
            );

    }catch(error){

        console.error(error);

        if(error.code === "23505"){
            return res.send(
                "Diese URL ist bereits vorhanden"
            );
        }

        res.send(
            error.message ||
            "Webseite konnte nicht gespeichert werden"
        );
    }
});

app.post("/delete-monitored-website", async (req, res) => {

    try{

        const {
            adminUsername,
            id
        } = req.body;

        if(
            !await isRealAdmin(
                adminUsername
            )
        ){
            return res
                .status(403)
                .send("Keine Berechtigung");
        }

        const result = await pool.query(`
            DELETE FROM monitored_websites

            WHERE id = $1

            RETURNING id
        `, [
            id
        ]);

        if(result.rows.length === 0){
            return res.send(
                "Webseite nicht gefunden"
            );
        }

        res.send(
            "Webseite gelöscht"
        );

    }catch(error){

        console.error(error);

        res.send(
            "Webseite konnte nicht gelöscht werden"
        );
    }
});

app.post("/check-monitored-website", async (req, res) => {

    try{

        const {
            adminUsername,
            id
        } = req.body;

        if(
            !await isRealAdmin(
                adminUsername
            )
        ){
            return res
                .status(403)
                .send("Keine Berechtigung");
        }

        const result = await pool.query(`
            SELECT *

            FROM monitored_websites

            WHERE id = $1
        `, [
            id
        ]);

        if(result.rows.length === 0){
            return res.send(
                "Webseite nicht gefunden"
            );
        }

        await checkMonitoredWebsite(
            result.rows[0]
        );

        res.send(
            "Prüfung abgeschlossen"
        );

    }catch(error){

        console.error(error);

        res.send(
            "Prüfung fehlgeschlagen"
        );
    }
});

app.post("/check-all-monitored-websites", async (req, res) => {

    try{

        const {
            adminUsername
        } = req.body;

        if(
            !await isRealAdmin(
                adminUsername
            )
        ){
            return res
                .status(403)
                .send("Keine Berechtigung");
        }

        await runWebsiteMonitoring();

        res.send(
            "Alle Webseiten wurden geprüft"
        );

    }catch(error){

        console.error(error);

        res.send(
            "Prüfung fehlgeschlagen"
        );
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
            `SELECT *
             FROM times
             WHERE username = $1
             AND stop_time = ''
             ORDER BY id DESC
             LIMIT 1`,
            [username]
        );

        if(running.rows.length === 0){
            return res.send("Keine laufende Zeit");
        }

        const time = running.rows[0];

        if(
            time.is_paused !== true ||
            !time.pause_start
        ){
            return res.send("Zeit ist nicht pausiert");
        }

        const now = new Date();
        const pauseStart = new Date(time.pause_start);

        if(Number.isNaN(pauseStart.getTime())){
            return res.send("Ungültige Pausenzeit");
        }

        const pauseMinutes = Math.max(
            0,
            Math.floor(
                (now - pauseStart) / 1000 / 60
            )
        );

        const result = await pool.query(
            `UPDATE times
             SET is_paused = false,
                 pause_end = $1,
                 pause_start = '',
                 pause_total =
                     COALESCE(pause_total, 0) + $2
             WHERE id = $3
             AND is_paused = true
             RETURNING id`,
            [
                now.toLocaleString(
                    "de-DE",
                    {
                        timeZone: "Europe/Berlin"
                    }
                ),
                pauseMinutes,
                time.id
            ]
        );

        if(result.rows.length === 0){
            return res.send(
                "Zeit wurde bereits fortgesetzt"
            );
        }

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

        const nowText = now.toLocaleString(
            "de-DE",
            {
                timeZone: "Europe/Berlin"
            }
        );
        
        const stoppedDuringPause =
            time.is_paused === true &&
            Boolean(time.pause_start);
        
        const finalPauseEnd =
            stoppedDuringPause
                ? nowText
                : (time.pause_end || "");
        
        await pool.query(
            `UPDATE times
             SET stop_time = $1,
                 report = $2,
                 admin_only = $3,
                 is_paused = false,
                 pause_end = $4,
                 pause_total =
                     COALESCE(pause_total, 0) + $5
             WHERE id = $6`,
            [
                nowText,
                report,
                adminOnly === true,
                finalPauseEnd,
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
        const {
            id,
            username,
            project,
            task,
            start_time,
            stop_time
        } = req.body;

        await pool.query(
            `UPDATE times
             SET username = $1,
                 project = $2,
                 task = $3,
                 start_time = $4,
                 stop_time = $5
             WHERE id = $6`,
            [
                username,
                project,
                task,
                start_time || "",
                stop_time || "",
                id
            ]
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

app.post("/create-ticket", async (req, res) => {
    try {
        const {
            project,
            source,
            customerName,
            customerEmail,
            title,
            message,
            priority
        } = req.body;

        if (!project || !title || !message) {
            return res.status(400).send("Ticket Daten fehlen");
        }

        const priorityMap = {
            niedrig: "Niedrig",
            normal: "Normal",
            hoch: "Hoch"
        };

        const incomingPriority =
            typeof priority === "string"
                ? priority.trim().toLowerCase()
                : "";

        let finalPriority = priorityMap[incomingPriority];

        const legacyPriorityMatch = message.match(
            /(?:^|\n)\s*Priorität:\s*(Niedrig|Normal|Hoch)\s*(?:\n|$)/i
        );

        if (!finalPriority && legacyPriorityMatch) {
            finalPriority =
                priorityMap[legacyPriorityMatch[1].trim().toLowerCase()];
        }

        if (!finalPriority) {
            return res.status(400).send(
                `Ungültige Priorität empfangen: ${String(priority)}`
            );
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

        await sendTracksyNotification(
            `Tracksy – Neues Ticket: ${title.trim()}`,
            `Neues Ticket eingegangen
        
        Projekt: ${project}
        Quelle: ${source || "Nicht angegeben"}
        Kunde: ${customerName || "Nicht angegeben"}
        E-Mail: ${customerEmail || "Nicht angegeben"}
        Priorität: ${finalPriority}
        
        Titel:
        ${title.trim()}
        
        Nachricht:
        ${cleanMessage}`
        );

        res.send("Ticket erstellt");

    } catch (err) {
        console.error("Ticket-Erstellung fehlgeschlagen:", err);
        res.status(500).send("Ticket Fehler");
    }
});

app.get("/tickets", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM tickets ORDER BY id DESC"
        );

        res.json(result.rows);

    } catch (err) {
        console.error("Tickets konnten nicht geladen werden:", err);
        res.status(500).json([]);
    }
});

app.post("/create-tracksy-ticket", async (req, res) => {
    try {
        const {
            username,
            userRole,
            title,
            message,
            priority
        } = req.body;

        if (userRole !== "admin" && userRole !== "user") {
            return res.status(403).send("Keine Berechtigung");
        }

        if (!username || !title || !message) {
            return res.status(400).send(
                "Bitte alle Pflichtfelder ausfüllen"
            );
        }

        const priorityMap = {
            niedrig: "Niedrig",
            normal: "Normal",
            hoch: "Hoch"
        };

        const incomingPriority =
            typeof priority === "string"
                ? priority.trim().toLowerCase()
                : "";

        const finalPriority = priorityMap[incomingPriority];

        if (!finalPriority) {
            return res.status(400).send(
                `Ungültige Priorität: ${String(priority)}`
            );
        }

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
                    timeZone: "Europe/Berlin"
                })
            ]
        );

        res.send("Tracksy-Ticket erstellt");

    } catch (err) {
        console.error("Tracksy-Ticket-Erstellung fehlgeschlagen:", err);
        res.status(500).send(
            "Tracksy-Ticket konnte nicht erstellt werden"
        );
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
            WHERE status != 'Gekündigt'
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
            AND request_type IN (
                'tariff',
                'cancellation'
            )
            AND status = 'Offen'
        
            ORDER BY id DESC
            LIMIT 1
        `,[project]);
        
        const requestHistory = await pool.query(`
            SELECT
                id,
                request_type,
                title,
                description,
                tariff,
                billing_cycle,
                price_monthly,
                price_yearly,
                price_once,
                status,
                created_at,
                updated_at
        
            FROM service_requests
        
            WHERE project = $1
            AND request_type IN (
                'tariff',
                'addon'
            )
            AND COALESCE(
                customer_hidden,
                false
            ) = false
        
            ORDER BY id DESC
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
        : null,

request_history:
    requestHistory.rows
        
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
        
            pending_request: null,
request_history: []
        
        });

    }

});

app.post("/hide-service-request", async (req, res) => {

    try{

        const {
            id,
            project
        } = req.body;

        if(!id || !project){

            return res
                .status(400)
                .send("Daten fehlen");
        }

        const result = await pool.query(`
            UPDATE service_requests

            SET customer_hidden = true

            WHERE id = $1
            AND project = $2
            AND request_type IN (
                'tariff',
                'addon'
            )

            RETURNING id
        `,[
            id,
            project
        ]);

        if(result.rows.length === 0){

            return res
                .status(404)
                .send(
                    "Anfrage nicht gefunden"
                );
        }

        res.send("Meldung gelöscht");

    }catch(error){

        console.error(
            "Anfragemeldung löschen fehlgeschlagen:",
            error
        );

        res.status(500).send(
            "Meldung konnte nicht gelöscht werden"
        );
    }
});

/* Anfrage von verbundenen Webseiten */

app.post("/create-service-request", async (req, res) => {
    try{
        const {
            project,
            requestType,
            title,
            description,
            tariff,
            addon,
            billingCycle
        } = req.body;

        const allowedTypes = [
            "tariff",
            "addon",
            "cancellation"
        ];

        if(
            !project ||
            !requestType ||
            !allowedTypes.includes(requestType)
        ){
            return res.send("Anfrage-Daten fehlen");
        }

        let requestTitle =
            String(title || "").trim();

        let requestDescription =
            String(description || "").trim();

        let requestTariff = "";
        let requestPriceMonthly = 0;
        let requestPriceYearly = 0;
        let requestPriceOnce = 0;

        if(requestType === "tariff"){

            if(
                !["Monatlich", "Jährlich"].includes(
                    billingCycle
                )
            ){
                return res.send(
                    "Ungültige Abrechnung"
                );
            }

            const packageResult = await pool.query(`
                SELECT *
                FROM service_packages
                WHERE tariff = $1
                AND status = 'available'
                LIMIT 1
            `,[
                String(tariff || "")
            ]);

            if(packageResult.rows.length === 0){
                return res.send(
                    "Tarif ist nicht verfügbar"
                );
            }

            const packageItem =
                packageResult.rows[0];

            let offerStillValid = true;

            if(packageItem.offer_use_end_date){

                const endDate = new Date(
                    `${packageItem.offer_end_date}T23:59:59`
                );

                offerStillValid =
                    Boolean(packageItem.offer_end_date) &&
                    !Number.isNaN(endDate.getTime()) &&
                    endDate >= new Date();
            }

            const offerActive =
                packageItem.offer_enabled === true &&
                offerStillValid;

            requestTitle =
                packageItem.display_name ||
                packageItem.tariff;

            requestDescription =
                packageItem.description || "";

            requestTariff =
                packageItem.tariff;

            requestPriceMonthly = Number(
                offerActive
                    ? packageItem.offer_monthly_price
                    : packageItem.monthly_price
            ) || 0;

            requestPriceYearly = Number(
                offerActive
                    ? packageItem.offer_yearly_price
                    : packageItem.yearly_price
            ) || 0;
        }

        if(requestType === "addon"){

            const addonKey =
                String(addon || title || "").trim();

            const addonResult = await pool.query(`
                SELECT *
                FROM service_addons
                WHERE (
                    service_name = $1
                    OR display_name = $1
                )
                AND status = 'available'
                LIMIT 1
            `,[
                addonKey
            ]);

            if(addonResult.rows.length === 0){
                return res.send(
                    "Zusatzleistung ist nicht verfügbar"
                );
            }

            const addonItem =
                addonResult.rows[0];

            requestTitle =
                addonItem.display_name ||
                addonItem.service_name;

            requestDescription =
                addonItem.description || "";

            requestPriceOnce =
                Number(addonItem.price_once) || 0;
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
            `,[
                project
            ]);

            if(activeService.rows.length === 0){
                return res.send(
                    "Kein aktiver Tarif vorhanden"
                );
            }

            requestTitle =
                requestTitle || "Tarif kündigen";
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
            `,[
                project
            ]);

            if(existingRequest.rows.length > 0){
                return res.send(
                    "Es besteht bereits eine offene Tarifanfrage"
                );
            }
        }

        const now = new Date().toLocaleString(
            "de-DE",
            {
                timeZone: "Europe/Berlin"
            }
        );

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
        `,[
            project,
            requestType,
            requestTitle,
            requestDescription,
            requestTariff,
            billingCycle || "",
            requestPriceMonthly,
            requestPriceYearly,
            requestPriceOnce,
            "Offen",
            now
        ]);

        await pool.query(`
            INSERT INTO service_tariffs (project)
            VALUES ($1)
            ON CONFLICT (project) DO NOTHING
        `,[
            project
        ]);

        const requestTypeName = {
            tariff: "Tarif",
            addon: "Zusatzleistung",
            cancellation: "Kündigung"
        }[requestType] || requestType;

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

        await pool.query(`
            UPDATE tickets
            SET status = 'Gelöscht'
            WHERE id = $1
        `, [id]);

        res.send("Ticket archiviert");

    }catch(err){
        console.log(err);
        res.status(500).send("Ticket konnte nicht archiviert werden");
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

app.post("/terminate-service-contract", async (req, res) => {
    try{
        const { id } = req.body;

        if(!id){
            return res.send("Vertrag fehlt");
        }

        const result = await pool.query(
            "SELECT * FROM service_tariffs WHERE id = $1",
            [id]
        );

        if(result.rows.length === 0){
            return res.send("Vertrag nicht gefunden");
        }

        const service = result.rows[0];

        const now = new Date().toLocaleString("de-DE", {
            timeZone: "Europe/Berlin"
        });

        await pool.query(`
            UPDATE service_tariffs
SET
    status = 'Gekündigt',
    previous_tariff = tariff,
    previous_billing_cycle = billing_cycle,
    tariff = 'Keiner',
    support_active = false,
    billing_cycle = '',
    updated_at = $1
WHERE id = $2
        `, [
            now,
            id
        ]);

        await pool.query(`
            UPDATE service_requests
            SET
                status = 'Abgelehnt',
                updated_at = $1
            WHERE project = $2
            AND status = 'Offen'
        `, [
            now,
            service.project
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
            service.project,
            "Vertrag durch VisualCode.dev gekündigt",
            `${service.tariff || "Tarif"} beendet`,
            now
        ]);

        res.send("Vertrag gekündigt");

    }catch(err){
        console.log(err);
        res.status(500).send("Kündigung fehlgeschlagen");
    }
});

app.post("/restore-ticket", async (req, res) => {
    try{
        const { id } = req.body;

        await pool.query(`
            UPDATE tickets
            SET status = 'Offen'
            WHERE id = $1
        `, [id]);

        res.send("Ticket wiederhergestellt");

    }catch(err){
        console.log(err);
        res.status(500).send("Wiederherstellung fehlgeschlagen");
    }
});

app.post("/delete-ticket-final", async (req, res) => {
    try{
        const { id } = req.body;

        await pool.query(
            "DELETE FROM tickets WHERE id = $1",
            [id]
        );

        res.send("Ticket endgültig gelöscht");

    }catch(err){
        console.log(err);
        res.status(500).send("Endgültiges Löschen fehlgeschlagen");
    }
});

app.post("/restore-service-contract", async (req, res) => {
    try{
        const { id } = req.body;

        const result = await pool.query(
            "SELECT * FROM service_tariffs WHERE id = $1",
            [id]
        );

        if(result.rows.length === 0){
            return res.send("Vertrag nicht gefunden");
        }

        const service = result.rows[0];

        if(!service.previous_tariff){
            return res.send("Kein vorheriger Tarif gespeichert");
        }

        const now = new Date().toLocaleString("de-DE", {
            timeZone: "Europe/Berlin"
        });

        await pool.query(`
            UPDATE service_tariffs
            SET
                status = 'Online',
                tariff = previous_tariff,
                billing_cycle = previous_billing_cycle,
                support_active = true,
                updated_at = $1
            WHERE id = $2
        `, [
            now,
            id
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
            service.project,
            "Vertrag wiederhergestellt",
            `${service.previous_tariff} – ${service.previous_billing_cycle || "Keine Abrechnung"}`,
            now
        ]);

        res.send("Vertrag wiederhergestellt");

    }catch(err){
        console.log(err);
        res.status(500).send(
            "Vertrag konnte nicht wiederhergestellt werden"
        );
    }
});

const serviceCatalogStatuses = new Set([
    "available",
    "unavailable"
]);

function normalizeServiceFeatures(value){
    if(!Array.isArray(value)){
        return [];
    }

    return value
        .map(item => String(item).trim())
        .filter(Boolean);
}

app.get("/service-packages", async (req, res) => {
    try{
        const result = await pool.query(`
            SELECT *
            FROM service_packages
            ORDER BY sort_order ASC, id ASC
        `);

        res.json(result.rows);

    }catch(error){
        console.error(error);

        res.status(500).json({
            error: "Fehler beim Laden der Tarife."
        });
    }
});

app.post("/create-service-package", async (req, res) => {
    try{
        const {
            adminUsername,
            display_name,
            subtitle,
            description,
            icon,
            features,
            monthly_price,
            yearly_price,
            status,
            recommended,
            recommendation_text,
            sort_order
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send("Keine Berechtigung");
        }

        const cleanName = String(display_name || "").trim();
        const cleanStatus = String(status || "available");

        if(!cleanName){
            return res.status(400).send("Tarifname fehlt");
        }

        if(!serviceCatalogStatuses.has(cleanStatus)){
            return res.status(400).send(
                "Ungültige Verfügbarkeit"
            );
        }

        const tariffKey =
            `tariff-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;

        await pool.query(`
            INSERT INTO service_packages (
                tariff,
                display_name,
                subtitle,
                description,
                icon,
                features,
                monthly_price,
                yearly_price,
                status,
                recommended,
                recommendation_text,
                sort_order,
                updated_at
            )
            VALUES (
                $1,$2,$3,$4,$5,$6::jsonb,
                $7,$8,$9,$10,$11,$12,$13
            )
        `,[
            tariffKey,
            cleanName,
            String(subtitle || "").trim(),
            String(description || "").trim(),
            String(icon || "📦").trim() || "📦",
            JSON.stringify(
                normalizeServiceFeatures(features)
            ),
            Math.max(
                0,
                Number(monthly_price) || 0
            ),
            Math.max(
                0,
                Number(yearly_price) || 0
            ),
            cleanStatus,
            recommended === true,
            String(
                recommendation_text || ""
            ).trim(),
            Number(sort_order) || 0,
            new Date().toISOString()
        ]);

        res.send("Tarif angelegt");

    }catch(error){
        console.error(error);

        res.status(500).send(
            "Tarif konnte nicht angelegt werden"
        );
    }
});

app.post("/save-service-package", async (req, res) => {
    try{
        const {
            adminUsername,
            id,
            display_name,
            subtitle,
            description,
            icon,
            features,
            monthly_price,
            yearly_price,
            status,
            recommended,
            recommendation_text,
            sort_order,
            offer_enabled,
            offer_name,
            offer_monthly_price,
            offer_yearly_price,
            offer_use_end_date,
            offer_end_date
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        const cleanName =
            String(display_name || "").trim();

        const cleanStatus =
            String(status || "available");

        if(!id || !cleanName){
            return res.status(400).send(
                "Tarif-Daten fehlen"
            );
        }

        if(!serviceCatalogStatuses.has(cleanStatus)){
            return res.status(400).send(
                "Ungültige Verfügbarkeit"
            );
        }

        const result = await pool.query(`
            UPDATE service_packages
            SET
                display_name = $1,
                subtitle = $2,
                description = $3,
                icon = $4,
                features = $5::jsonb,
                monthly_price = $6,
                yearly_price = $7,
                status = $8,
                recommended = $9,
                recommendation_text = $10,
                sort_order = $11,
                offer_enabled = $12,
                offer_name = $13,
                offer_monthly_price = $14,
                offer_yearly_price = $15,
                offer_use_end_date = $16,
                offer_end_date = $17,
                updated_at = $18
            WHERE id = $19
            RETURNING id
        `,[
            cleanName,
            String(subtitle || "").trim(),
            String(description || "").trim(),
            String(icon || "📦").trim() || "📦",
            JSON.stringify(
                normalizeServiceFeatures(features)
            ),
            Math.max(
                0,
                Number(monthly_price) || 0
            ),
            Math.max(
                0,
                Number(yearly_price) || 0
            ),
            cleanStatus,
            recommended === true,
            String(
                recommendation_text || ""
            ).trim(),
            Number(sort_order) || 0,
            offer_enabled === true,
            String(offer_name || "").trim(),
            Math.max(
                0,
                Number(offer_monthly_price) || 0
            ),
            Math.max(
                0,
                Number(offer_yearly_price) || 0
            ),
            offer_use_end_date === true,
            offer_use_end_date === true
                ? String(offer_end_date || "")
                : "",
            new Date().toISOString(),
            id
        ]);

        if(result.rows.length === 0){
            return res.status(404).send(
                "Tarif nicht gefunden"
            );
        }

        res.send("Tarif gespeichert");

    }catch(error){
        console.error(error);

        res.status(500).send(
            "Speichern fehlgeschlagen"
        );
    }
});

app.post("/delete-service-package", async (req, res) => {
    try{
        const {
            adminUsername,
            id
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        const packageResult = await pool.query(`
            SELECT tariff
            FROM service_packages
            WHERE id = $1
            LIMIT 1
        `,[
            id
        ]);

        if(packageResult.rows.length === 0){
            return res.status(404).send(
                "Tarif nicht gefunden"
            );
        }

        const tariffKey =
            packageResult.rows[0].tariff;

        const usageResult = await pool.query(`
            SELECT EXISTS (
                SELECT 1
                FROM service_tariffs
                WHERE tariff = $1
                AND tariff != 'Keiner'
            ) AS is_used
        `,[
            tariffKey
        ]);

        if(usageResult.rows[0].is_used){
            return res.status(409).send(
                "Tarif ist bereits gebucht und kann nur auf Nicht verfügbar gestellt werden"
            );
        }

        await pool.query(
            "DELETE FROM service_packages WHERE id = $1",
            [id]
        );

        res.send("Tarif gelöscht");

    }catch(error){
        console.error(error);

        res.status(500).send(
            "Tarif konnte nicht gelöscht werden"
        );
    }
});

app.get("/service-addons", async (req, res) => {
    try{
        const result = await pool.query(`
            SELECT *
            FROM service_addons
            ORDER BY sort_order ASC, id ASC
        `);

        res.json(result.rows);

    }catch(error){
        console.error(error);

        res.status(500).json({
            error: "Zusatzleistungen konnten nicht geladen werden."
        });
    }
});

app.post("/create-service-addon", async (req, res) => {
    try{
        const {
            adminUsername,
            display_name,
            description,
            icon,
            price_prefix,
            price_once,
            status,
            sort_order
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        const cleanName =
            String(display_name || "").trim();

        const cleanStatus =
            String(status || "available");

        if(!cleanName){
            return res.status(400).send(
                "Name der Zusatzleistung fehlt"
            );
        }

        if(!serviceCatalogStatuses.has(cleanStatus)){
            return res.status(400).send(
                "Ungültige Verfügbarkeit"
            );
        }

        const existing = await pool.query(`
            SELECT id
            FROM service_addons
            WHERE LOWER(display_name) = LOWER($1)
            LIMIT 1
        `,[
            cleanName
        ]);

        if(existing.rows.length > 0){
            return res.status(409).send(
                "Diese Zusatzleistung existiert bereits"
            );
        }

        const serviceKey =
            `addon-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;

        await pool.query(`
            INSERT INTO service_addons (
                service_name,
                display_name,
                description,
                icon,
                price_prefix,
                price_once,
                status,
                sort_order,
                updated_at
            )
            VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9
            )
        `,[
            serviceKey,
            cleanName,
            String(description || "").trim(),
            String(icon || "🛠️").trim() || "🛠️",
            String(price_prefix || "ab").trim(),
            Math.max(
                0,
                Number(price_once) || 0
            ),
            cleanStatus,
            Number(sort_order) || 0,
            new Date().toISOString()
        ]);

        res.send("Zusatzleistung angelegt");

    }catch(error){
        console.error(error);

        res.status(500).send(
            "Zusatzleistung konnte nicht angelegt werden"
        );
    }
});

app.post("/save-service-addon", async (req, res) => {
    try{
        const {
            adminUsername,
            id,
            display_name,
            description,
            icon,
            price_prefix,
            price_once,
            status,
            sort_order
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        const cleanName =
            String(display_name || "").trim();

        const cleanStatus =
            String(status || "available");

        if(!id || !cleanName){
            return res.status(400).send(
                "Daten der Zusatzleistung fehlen"
            );
        }

        if(!serviceCatalogStatuses.has(cleanStatus)){
            return res.status(400).send(
                "Ungültige Verfügbarkeit"
            );
        }

        const existing = await pool.query(`
            SELECT id
            FROM service_addons
            WHERE LOWER(display_name) = LOWER($1)
            AND id != $2
            LIMIT 1
        `,[
            cleanName,
            id
        ]);

        if(existing.rows.length > 0){
            return res.status(409).send(
                "Diese Zusatzleistung existiert bereits"
            );
        }

        const result = await pool.query(`
            UPDATE service_addons
            SET
                display_name = $1,
                description = $2,
                icon = $3,
                price_prefix = $4,
                price_once = $5,
                status = $6,
                sort_order = $7,
                updated_at = $8
            WHERE id = $9
            RETURNING id
        `,[
            cleanName,
            String(description || "").trim(),
            String(icon || "🛠️").trim() || "🛠️",
            String(price_prefix || "ab").trim(),
            Math.max(
                0,
                Number(price_once) || 0
            ),
            cleanStatus,
            Number(sort_order) || 0,
            new Date().toISOString(),
            id
        ]);

        if(result.rows.length === 0){
            return res.status(404).send(
                "Zusatzleistung nicht gefunden"
            );
        }

        res.send("Zusatzleistung gespeichert");

    }catch(error){
        console.error(error);

        res.status(500).send(
            "Zusatzleistung konnte nicht gespeichert werden"
        );
    }
});

app.post("/delete-service-addon", async (req, res) => {
    try{
        const {
            adminUsername,
            id
        } = req.body;

        if(!await isRealAdmin(adminUsername)){
            return res.status(403).send(
                "Keine Berechtigung"
            );
        }

        const result = await pool.query(`
            DELETE FROM service_addons
            WHERE id = $1
            RETURNING id
        `,[
            id
        ]);

        if(result.rows.length === 0){
            return res.status(404).send(
                "Zusatzleistung nicht gefunden"
            );
        }

        res.send("Zusatzleistung gelöscht");

    }catch(error){
        console.error(error);

        res.status(500).send(
            "Zusatzleistung konnte nicht gelöscht werden"
        );
    }
});

/* =====================================================
   ARCHIV LÖSCHEN & RÜCKGÄNGIG
===================================================== */

const ARCHIVE_UNDO_MINUTES = 10;

async function ensureArchiveDeleteTable(client){

    await client.query(`
        CREATE TABLE IF NOT EXISTS archive_delete_batches (
            id BIGSERIAL PRIMARY KEY,
            admin_username TEXT NOT NULL,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            undone_at TIMESTAMPTZ DEFAULT NULL
        )
    `);

    await client.query(`
        ALTER TABLE archive_delete_batches
        ENABLE ROW LEVEL SECURITY
    `);

    await client.query(`
        REVOKE ALL
        ON TABLE archive_delete_batches
        FROM anon, authenticated
    `);

    await client.query(`
        REVOKE ALL
        ON SEQUENCE archive_delete_batches_id_seq
        FROM anon, authenticated
    `);

    await client.query(`
        CREATE INDEX IF NOT EXISTS
        archive_delete_batches_admin_index

        ON archive_delete_batches (
            admin_username,
            created_at DESC
        )
    `);
}

function normalizeArchiveItems(items){

    const normalizedItems = [];
    const usedItems = new Set();

    if(!Array.isArray(items)){
        return normalizedItems;
    }

    items.forEach(item => {

        const type =
            String(item?.type || "");

        const id =
            Number(item?.id);

        if(
            (
                type !== "ticket" &&
                type !== "contract"
            ) ||
            !Number.isInteger(id) ||
            id <= 0
        ){
            return;
        }

        const key =
            `${type}:${id}`;

        if(usedItems.has(key)){
            return;
        }

        usedItems.add(key);

        normalizedItems.push({
            type,
            id
        });
    });

    return normalizedItems;
}

async function loadSelectedArchiveRows(
    client,
    items
){

    const ticketIds =
        items
            .filter(item =>
                item.type === "ticket"
            )
            .map(item => item.id);

    const contractIds =
        items
            .filter(item =>
                item.type === "contract"
            )
            .map(item => item.id);

    let tickets = [];
    let contracts = [];

    if(ticketIds.length > 0){

        const ticketResult =
            await client.query(`
                SELECT *

                FROM tickets

                WHERE id = ANY($1::int[])

                AND LOWER(
                    COALESCE(status, '')
                ) LIKE '%gelöscht%'
            `, [
                ticketIds
            ]);

        tickets =
            ticketResult.rows;
    }

    if(contractIds.length > 0){

        const contractResult =
            await client.query(`
                SELECT *

                FROM service_tariffs

                WHERE id = ANY($1::int[])

                AND LOWER(
                    COALESCE(status, '')
                ) IN (
                    'gekündigt',
                    'cancelled'
                )
            `, [
                contractIds
            ]);

        contracts =
            contractResult.rows;
    }

    return {
        tickets,
        contracts
    };
}

async function loadAllArchiveRows(client){

    const ticketResult =
        await client.query(`
            SELECT *

            FROM tickets

            WHERE LOWER(
                COALESCE(status, '')
            ) LIKE '%gelöscht%'
        `);

    const contractResult =
        await client.query(`
            SELECT *

            FROM service_tariffs

            WHERE LOWER(
                COALESCE(status, '')
            ) IN (
                'gekündigt',
                'cancelled'
            )
        `);

    return {
        tickets: ticketResult.rows,
        contracts: contractResult.rows
    };
}

async function permanentlyDeleteArchiveRows(
    client,
    archiveRows
){

    const ticketIds =
        archiveRows.tickets.map(
            ticket => Number(ticket.id)
        );

    const contractIds =
        archiveRows.contracts.map(
            contract => Number(contract.id)
        );

    if(ticketIds.length > 0){

        await client.query(`
            DELETE FROM tickets

            WHERE id = ANY($1::int[])
        `, [
            ticketIds
        ]);
    }

    if(contractIds.length > 0){

        await client.query(`
            DELETE FROM service_tariffs

            WHERE id = ANY($1::int[])
        `, [
            contractIds
        ]);
    }
}

async function createArchiveDeleteBatch(
    client,
    adminUsername,
    archiveRows
){

    await client.query(`
        INSERT INTO archive_delete_batches (
            admin_username,
            payload
        )

        VALUES (
            $1,
            $2::jsonb
        )
    `, [
        adminUsername,
        JSON.stringify(archiveRows)
    ]);
}

async function deleteArchiveEntries(
    adminUsername,
    selectedItems = null
){

    const client =
        await pool.connect();

    try{

        await client.query("BEGIN");

        await ensureArchiveDeleteTable(
            client
        );

        const archiveRows =
            selectedItems === null
                ? await loadAllArchiveRows(
                    client
                )
                : await loadSelectedArchiveRows(
                    client,
                    selectedItems
                );

        const deletedCount =
            archiveRows.tickets.length +
            archiveRows.contracts.length;

        if(deletedCount === 0){

            await client.query("ROLLBACK");

            return 0;
        }

        await createArchiveDeleteBatch(
            client,
            adminUsername,
            archiveRows
        );

        await permanentlyDeleteArchiveRows(
            client,
            archiveRows
        );

        await client.query("COMMIT");

        return deletedCount;

    }catch(error){

        await client.query("ROLLBACK");

        throw error;

    }finally{

        client.release();
    }
}

app.post(
    "/archive-delete-selected",
    async (req, res) => {

        try{

            const adminUsername =
                String(
                    req.body.adminUsername || ""
                ).trim();

            const isAdminUser =
                await isRealAdmin(
                    adminUsername
                );

            if(!isAdminUser){

                return res
                    .status(403)
                    .send(
                        "Keine Berechtigung"
                    );
            }

            const items =
                normalizeArchiveItems(
                    req.body.items
                );

            if(items.length === 0){

                return res
                    .status(400)
                    .send(
                        "Keine gültigen Archiveinträge ausgewählt"
                    );
            }

            const deletedCount =
                await deleteArchiveEntries(
                    adminUsername,
                    items
                );

            if(deletedCount === 0){

                return res.send(
                    "Keine passenden Archiveinträge gefunden"
                );
            }

            res.send(
                `${deletedCount} Archiveinträge gelöscht. ` +
                `Rückgängig ist ${ARCHIVE_UNDO_MINUTES} Minuten möglich.`
            );

        }catch(error){

            console.error(
                "Archivauswahl löschen fehlgeschlagen:",
                error
            );

            res
                .status(500)
                .send(
                    "Archiveinträge konnten nicht gelöscht werden"
                );
        }
    }
);

app.post(
    "/archive-delete-all",
    async (req, res) => {

        try{

            const adminUsername =
                String(
                    req.body.adminUsername || ""
                ).trim();

            const isAdminUser =
                await isRealAdmin(
                    adminUsername
                );

            if(!isAdminUser){

                return res
                    .status(403)
                    .send(
                        "Keine Berechtigung"
                    );
            }

            const deletedCount =
                await deleteArchiveEntries(
                    adminUsername
                );

            if(deletedCount === 0){

                return res.send(
                    "Das Archiv ist bereits leer"
                );
            }

            res.send(
                `${deletedCount} Archiveinträge gelöscht. ` +
                `Rückgängig ist ${ARCHIVE_UNDO_MINUTES} Minuten möglich.`
            );

        }catch(error){

            console.error(
                "Gesamtes Archiv löschen fehlgeschlagen:",
                error
            );

            res
                .status(500)
                .send(
                    "Das Archiv konnte nicht gelöscht werden"
                );
        }
    }
);

async function restoreArchiveRow(
    client,
    tableName,
    row
){

    let result;

    if(tableName === "tickets"){

        result = await client.query(`
            INSERT INTO tickets

            SELECT *

            FROM json_populate_record(
                NULL::tickets,
                $1::json
            )

            ON CONFLICT DO NOTHING
        `, [
            JSON.stringify(row)
        ]);

    }else if(
        tableName === "service_tariffs"
    ){

        result = await client.query(`
            INSERT INTO service_tariffs

            SELECT *

            FROM json_populate_record(
                NULL::service_tariffs,
                $1::json
            )

            ON CONFLICT DO NOTHING
        `, [
            JSON.stringify(row)
        ]);

    }else{

        throw new Error(
            "Unbekannte Archivtabelle"
        );
    }

    if(result.rowCount !== 1){

        const conflictError =
            new Error(
                "Ein Archiveintrag existiert bereits und konnte nicht wiederhergestellt werden"
            );

        conflictError.statusCode = 409;

        throw conflictError;
    }
}

async function updateArchiveSequences(client){

    await client.query(`
        SELECT setval(
            pg_get_serial_sequence(
                'tickets',
                'id'
            ),
            (
                SELECT MAX(id)
                FROM tickets
            ),
            true
        )

        WHERE EXISTS (
            SELECT 1
            FROM tickets
        )
    `);

    await client.query(`
        SELECT setval(
            pg_get_serial_sequence(
                'service_tariffs',
                'id'
            ),
            (
                SELECT MAX(id)
                FROM service_tariffs
            ),
            true
        )

        WHERE EXISTS (
            SELECT 1
            FROM service_tariffs
        )
    `);
}

app.post(
    "/archive-undo-last",
    async (req, res) => {

        const client =
            await pool.connect();

        try{

            const adminUsername =
                String(
                    req.body.adminUsername || ""
                ).trim();

            const isAdminUser =
                await isRealAdmin(
                    adminUsername
                );

            if(!isAdminUser){

                return res
                    .status(403)
                    .send(
                        "Keine Berechtigung"
                    );
            }

            await client.query("BEGIN");

            await ensureArchiveDeleteTable(
                client
            );

            const batchResult =
                await client.query(`
                    SELECT
                        id,
                        payload

                    FROM archive_delete_batches

                    WHERE admin_username = $1

                    AND undone_at IS NULL

                    AND created_at >=
                        NOW() -
                        (
                            $2::int *
                            INTERVAL '1 minute'
                        )

                    ORDER BY created_at DESC

                    LIMIT 1

                    FOR UPDATE
                `, [
                    adminUsername,
                    ARCHIVE_UNDO_MINUTES
                ]);

            if(batchResult.rows.length === 0){

                await client.query(
                    "ROLLBACK"
                );

                return res.send(
                    "Keine Löschung vorhanden, die noch rückgängig gemacht werden kann"
                );
            }

            const batch =
                batchResult.rows[0];

            const payload =
                batch.payload || {};

            const tickets =
                Array.isArray(payload.tickets)
                    ? payload.tickets
                    : [];

            const contracts =
                Array.isArray(payload.contracts)
                    ? payload.contracts
                    : [];

            let restoredCount = 0;

            for(const ticket of tickets){

                await restoreArchiveRow(
                    client,
                    "tickets",
                    ticket
                );

                restoredCount++;
            }

            for(const contract of contracts){

                await restoreArchiveRow(
                    client,
                    "service_tariffs",
                    contract
                );

                restoredCount++;
            }

            await updateArchiveSequences(
                client
            );

            await client.query(`
                UPDATE archive_delete_batches

                SET undone_at = NOW()

                WHERE id = $1
            `, [
                batch.id
            ]);

            await client.query("COMMIT");

            res.send(
                `${restoredCount} Archiveinträge wiederhergestellt`
            );

        }catch(error){

            await client.query("ROLLBACK");

            console.error(
                "Archiv-Rückgängig fehlgeschlagen:",
                error
            );

            res
                .status(
                    error.statusCode || 500
                )
                .send(
                    error.message ||
                    "Rückgängig konnte nicht ausgeführt werden"
                );

        }finally{

            client.release();
        }
    }
);

app.use((err, req, res, next) => {
    console.log(err);
    res.status(500).send("Server Fehler");
});


app.listen(process.env.PORT || 3000, () => {
    console.log("Server läuft");
});