import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const SECTION_CONFIG = {
  exercises: {
    query: '("military exercise" OR "joint exercise" OR "training exercise")',
    timespan: "3d",
    allowedDomains: [
      "af.mil",
      "army.mil",
      "coastguard.mil",
      "defense.gov",
      "dvidshub.net",
      "marines.mil",
      "navy.mil",
      "spaceforce.mil",
      "uscg.mil",
    ],
  },
  safety: {
    query: '("military training" AND (mishap OR accident OR crash OR fatality))',
    timespan: "14d",
    allowedDomains: [
      "af.mil",
      "army.mil",
      "coastguard.mil",
      "defense.gov",
      "marines.mil",
      "navalsafetycommand.navy.mil",
      "navy.mil",
      "safety.af.mil",
      "safety.army.mil",
      "spaceforce.mil",
      "uscg.mil",
    ],
  },
  conflicts: {
    query: '(war OR "armed conflict" OR airstrike OR escalation OR ceasefire)',
    timespan: "3d",
    allowedDomains: [
      "aljazeera.com",
      "apnews.com",
      "bbc.com",
      "cfr.org",
      "crisisgroup.org",
      "defense.gov",
      "dw.com",
      "france24.com",
      "nato.int",
      "reliefweb.int",
      "reuters.com",
      "state.gov",
      "un.org",
      "understandingwar.org",
      "ukmto.org",
    ],
  },
};

const OFFICIAL_DOMAINS = ["defense.gov", "state.gov", "un.org", "nato.int", "ukmto.org"];
const ANALYTIC_DOMAINS = ["cfr.org", "crisisgroup.org", "reliefweb.int", "understandingwar.org"];

function parseSections() {
  const flag = process.argv.find((argument) => argument.startsWith("--sections="));
  const requested = (flag?.split("=")[1] || Object.keys(SECTION_CONFIG).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const invalid = requested.filter((section) => !(section in SECTION_CONFIG));
  if (invalid.length) throw new Error(`Unknown section: ${invalid.join(", ")}`);
  return requested;
}

function dataPath() {
  if (process.env.DASHBOARD_DATA_PATH) return resolve(process.env.DASHBOARD_DATA_PATH);
  return resolve(existsSync("public") ? "public/data/live-headlines.json" : "data/live-headlines.json");
}

function normalizeDomain(value = "") {
  return value.toLowerCase().replace(/^www\./, "");
}

function domainIsAllowed(domain, allowlist) {
  const normalized = normalizeDomain(domain);
  return allowlist.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`));
}

function sourceTier(domain) {
  if (domainIsAllowed(domain, OFFICIAL_DOMAINS)) return "Official / intergovernmental";
  if (domainIsAllowed(domain, ANALYTIC_DOMAINS)) return "Structured / analytic";
  return "Independent reporting";
}

function cleanTitle(value = "") {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function reportDate(value = "") {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : new Date().toISOString().slice(0, 10);
}

function classifyService(item) {
  const text = `${item.domain} ${item.title}`.toLowerCase();
  if (text.includes("marines.mil") || /\bmarine(s| corps)?\b/.test(text)) {
    return { branch: "Marine Corps", department: "Department of the Navy" };
  }
  if (text.includes("navy.mil") || text.includes("navalsafetycommand") || /\bnavy\b/.test(text)) {
    return { branch: "Navy", department: "Department of the Navy" };
  }
  if (text.includes("spaceforce.mil") || /\bspace force\b/.test(text)) {
    return { branch: "Space Force", department: "Department of the Air Force" };
  }
  if (text.includes("af.mil") || /\bair force\b/.test(text)) {
    return { branch: "Air Force", department: "Department of the Air Force" };
  }
  if (text.includes("uscg.mil") || text.includes("coastguard.mil") || /\bcoast guard\b/.test(text)) {
    return { branch: "Coast Guard", department: "Department of Homeland Security" };
  }
  return { branch: "Army", department: "Department of the Army" };
}

function classifyMishap(title) {
  const text = title.toLowerCase();
  if (/(aircraft|aviation|helicopter|plane|jet|flight|crash|hard landing|eject)/.test(text)) return "Aviation";
  if (/(ship|vessel|boat|collision at sea|maritime)/.test(text)) return "Maritime";
  if (/(vehicle|rollover|range|weapon|ammunition|ground|training area)/.test(text)) return "Ground";
  return "Other";
}

function incidentFromItem(item) {
  const service = classifyService(item);
  return {
    id: `auto-${createHash("sha256").update(item.url).digest("hex").slice(0, 12)}`,
    reportDate: reportDate(item.seen),
    dateBasis: "report discovery date",
    branch: service.branch,
    department: service.department,
    type: classifyMishap(item.title),
    event: item.title,
    location: "See official source",
    fatalities: null,
    injuries: null,
    status: "AUTOMATED INTAKE",
    source: item.url,
    sourceLabel: item.domain,
  };
}

async function requestSection(section) {
  const config = SECTION_CONFIG[section];
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  const domainQuery = config.allowedDomains.map((domain) => `domainis:${domain}`).join(" OR ");
  url.searchParams.set("query", `${config.query} (${domainQuery})`);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("maxrecords", "75");
  url.searchParams.set("format", "json");
  url.searchParams.set("timespan", config.timespan);
  url.searchParams.set("sort", "HybridRel");

  const response = await fetch(url, {
    headers: { "User-Agent": "Open-Source-Readiness-Dashboard/2.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${section}: source returned ${response.status}`);

  const payload = await response.json();
  const seen = new Set();
  const items = (Array.isArray(payload.articles) ? payload.articles : [])
    .map((article) => {
      let domain = normalizeDomain(article.domain);
      try {
        domain ||= normalizeDomain(new URL(article.url).hostname);
      } catch {
        return null;
      }
      return {
        title: cleanTitle(article.title),
        url: article.url,
        domain,
        sourceTier: sourceTier(domain),
        seen: article.seendate || "",
      };
    })
    .filter((item) => item?.title && item?.url && domainIsAllowed(item.domain, config.allowedDomains))
    .filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .slice(0, section === "safety" ? 20 : 8);

  if (!items.length) throw new Error(`${section}: no allowlisted public-source results`);
  return items;
}

async function main() {
  const path = dataPath();
  const sections = parseSections();
  let current = { schemaVersion: 1, generatedAt: null, sections: {} };

  try {
    current = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const updates = await Promise.all(
    sections.map(async (section) => [section, await requestSection(section)]),
  );
  const generatedAt = new Date().toISOString();

  for (const [section, items] of updates) {
    current.sections[section] = {
      generatedAt,
      cadence: section === "safety" ? "daily" : "every 6 hours",
      items,
      ...(section === "safety" ? { incidents: items.map(incidentFromItem) } : {}),
    };
  }

  current.schemaVersion = 1;
  current.generatedAt = generatedAt;
  current.method =
    "Automated discovery from GDELT, restricted to allowlisted public and official domains. Curated dashboard records require human validation.";

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`Updated ${sections.join(", ")} in ${path}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
