# Open-Source Military Readiness Dashboard

Public-facing executive dashboard covering:

- publicly reported U.S. military exercises;
- training incidents, mishaps, findings, fatalities, and safety trends; and
- strategic conflict reporting from open sources.

The dashboard is an open-source awareness product, not an operational,
intelligence, or authoritative mishap-reporting system.

## Scheduled updates

The GitHub Pages package includes three GitHub Actions workflows:

- **Open-source refresh:** every six hours for exercise and conflict headlines.
- **Safety refresh:** daily at 8:43 a.m. America/Los_Angeles.
- **Source review:** every Monday at 8:00 a.m. America/Los_Angeles. It opens one
  review reminder and waits for that issue to be closed before creating another.

The automated intake uses GDELT discovery and retains only results from an
allowlist of public or official domains. New safety reports are automatically
added to the dashboard's **incident intake** with inferred service, department,
and mishap type. The browser reloads the published JSON every 15 minutes while
the dashboard remains open.

## Human-review boundary

Automation adds incident reports to a visibly marked **awaiting review** area.
It does not automatically assert fatalities or injuries, and automated reports
do not affect curated fatality totals, department charts, conflict assessments,
or executive takeaways. Review the official source before promoting an intake
record into the validated chronology.

## GitHub requirements

In **Settings → Actions → General → Workflow permissions**, select:

**Read and write permissions**

GitHub Pages must remain configured to publish from the repository’s default
branch and root directory. Scheduled workflows run from the latest commit on
the default branch.

## Run a refresh manually

Open the repository’s **Actions** tab, choose either refresh workflow, select
**Run workflow**, and wait for it to finish. A successful refresh commits only
`data/live-headlines.json`.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
npm run build
```
