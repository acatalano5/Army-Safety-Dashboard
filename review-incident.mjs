import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const base = existsSync("public/data") ? "public/data" : "data";
const livePath = resolve(base, "live-headlines.json");
const validatedPath = resolve(base, "validated-incidents.json");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function number(name, min, max) {
  const value = Number(required(name));
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function integer(name, allowUnknown = false) {
  const raw = process.env[name]?.trim();
  if (allowUnknown && (!raw || raw.toUpperCase() === "TBD")) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer or TBD`);
  return value;
}

function displayDate(date) {
  const [year, month, day] = date.split("-");
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${day} ${months[Number(month) - 1]} ${year}`;
}

const live = JSON.parse(await readFile(livePath, "utf8"));
let validated = { schemaVersion: 1, updatedAt: null, incidents: [] };
try {
  validated = JSON.parse(await readFile(validatedPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const incidentId = required("INCIDENT_ID");
const candidates = live?.sections?.safety?.incidents || [];
const candidate = candidates.find((item) => item.id === incidentId);
if (!candidate) throw new Error(`No automated safety candidate found with ID ${incidentId}`);

const date = required("EVENT_DATE");
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
  throw new Error("EVENT_DATE must use YYYY-MM-DD");
}

const type = required("MISHAP_TYPE");
if (!["Aviation", "Ground", "Maritime", "Other"].includes(type)) throw new Error("Unsupported MISHAP_TYPE");

const record = {
  id: `validated-${createHash("sha256").update(candidate.source).digest("hex").slice(0, 12)}`,
  date,
  displayDate: displayDate(date),
  branch: candidate.branch,
  department: candidate.department,
  type,
  event: candidate.event,
  location: required("LOCATION"),
  lat: number("LATITUDE", -90, 90),
  lon: number("LONGITUDE", -180, 180),
  fatalities: integer("FATALITIES"),
  injuries: integer("INJURIES", true),
  status: "VALIDATED OPEN SOURCE",
  summary: required("SUMMARY"),
  source: candidate.source,
  sourceLabel: candidate.sourceLabel,
};

validated.incidents = [...(validated.incidents || []).filter((item) => item.source !== record.source), record]
  .sort((a, b) => b.date.localeCompare(a.date));
validated.schemaVersion = 1;
validated.updatedAt = new Date().toISOString();
live.sections.safety.incidents = candidates.filter((item) => item.id !== incidentId);

await writeFile(validatedPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
await writeFile(livePath, `${JSON.stringify(live, null, 2)}\n`, "utf8");
console.log(`Validated ${incidentId} as ${record.id}`);
