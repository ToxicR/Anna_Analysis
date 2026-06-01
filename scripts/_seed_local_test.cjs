/* eslint-disable */
// Seed a local test user with must_change_password = 1
const path = require("node:path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
const { hashPassword } = require(path.join(__dirname, "..", "dist", "password.js"));

const dbPath = path.join(__dirname, "..", "data", "anna_analysis.db");
const db = new Database(dbPath);
const account = process.argv[2] || "localtest";
const password = process.argv[3] || "123456";

db.prepare("DELETE FROM app_users WHERE account = ?").run(account);
db.prepare(
  `INSERT INTO app_users(account, password_hash, display_name, enabled, must_change_password, created_at)
   VALUES (?, ?, ?, 1, 1, datetime('now'))`
).run(account, hashPassword(password), account);

const row = db
  .prepare("SELECT id, account, must_change_password FROM app_users WHERE account = ?")
  .get(account);
console.log("seeded:", JSON.stringify(row));
db.close();
