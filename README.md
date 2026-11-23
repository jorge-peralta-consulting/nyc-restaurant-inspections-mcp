# NYC Restaurant Inspections for Claude

Ask Claude about the health inspection grades of New York City restaurants, in plain English.

This connector (an "MCP server") gives Claude live access to the New York City Health Department's
public restaurant inspection results, the same data behind the A / B / C letter grades posted in
restaurant windows. Claude can look up a restaurant, read its full inspection history, find recent
serious violations in a neighbourhood, and summarise grades across a ZIP code or borough.

- **No account or API key needed.** The data is public (NYC Open Data).
- **Read-only.** It only reads public data; it cannot change anything anywhere.
- **Always current.** Every answer comes from the city's live dataset, which the Health Department
  refreshes regularly (usually daily).

## Questions you can ask Claude

1. *"What grade does Joe's Pizza on Carmine Street have, and what did inspectors find last time?"*
2. *"Which restaurants in ZIP 11211 had critical violations in the last two weeks?"*
3. *"How do restaurant grades in Queens compare with Brooklyn? Give me the share of A grades."*

## What Claude can do with it

| Tool | What it does |
|---|---|
| `search_restaurants` | Find restaurants by name, borough, ZIP code and/or cuisine. Returns name, address, cuisine, current grade, last inspection date and restaurant id. |
| `get_inspection_history` | Every inspection for one restaurant, newest first: date, type, score (lower is better), grade and each violation, marked critical or not. |
| `recent_critical_violations` | Critical violations (the kind most likely to cause food-borne illness) in a ZIP code or borough within the last N days (default 30, up to 365). |
| `grade_summary` | How many restaurants in a ZIP code or borough currently hold an A, B, C, "grade pending" or "not yet graded", with percentages. |

Lists return 20 results by default and at most 100. Boroughs are Manhattan, Bronx, Brooklyn,
Queens and Staten Island.

## Setup

You need **Node.js 22 or newer** ([download](https://nodejs.org/)) and this folder (unzip the ZIP file you received). Open a terminal in the
`nyc-restaurant-inspections` folder once and run:

```bash
npm ci
pwd    # prints the folder path; you need it below
```

In the snippets below, replace `/ABSOLUTE/PATH/TO/nyc-restaurant-inspections` with the path printed by `pwd`
(on Windows, use forward slashes, for example `C:/Users/you/nyc-restaurant-inspections`).

### Claude Desktop

1. Open Claude Desktop → **Settings** → **Developer** → **Edit Config**. This opens
   `claude_desktop_config.json`:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Paste this in (if the file already has an `"mcpServers"` section, add just the
   `"nyc-restaurant-inspections"` entry to it):

   ```json
   {
     "mcpServers": {
       "nyc-restaurant-inspections": {
         "command": "npx",
         "args": ["-y", "tsx", "/ABSOLUTE/PATH/TO/nyc-restaurant-inspections/src/server.ts"]
       }
     }
   }
   ```
3. Save the file and fully quit and reopen Claude Desktop. The tools appear under the
   tools (slider) icon in the chat box.

### Claude Code

Run this once in a terminal:

```bash
claude mcp add nyc-restaurant-inspections --scope user -- npx -y tsx /ABSOLUTE/PATH/TO/nyc-restaurant-inspections/src/server.ts
```

Check it with `claude mcp list`, or type `/mcp` inside Claude Code.

### Cursor

1. Open **Cursor Settings** → **MCP** (called **Tools & MCP** in newer versions) → **New MCP Server**.
   This opens `~/.cursor/mcp.json` (use `.cursor/mcp.json` inside a project to enable it for that
   project only). You can also create or edit that file directly.
2. Paste:

   ```json
   {
     "mcpServers": {
       "nyc-restaurant-inspections": {
         "command": "npx",
         "args": ["-y", "tsx", "/ABSOLUTE/PATH/TO/nyc-restaurant-inspections/src/server.ts"]
       }
     }
   }
   ```
3. Save. The server shows a green dot in Cursor's MCP settings when it is running.

## Environment variables

All are optional. The connector works with none of them set.

| Variable | Default | Meaning |
|---|---|---|
| `NYCRI_APP_TOKEN` | *(none)* | A free NYC Open Data app token. Without one, the city limits how many requests can come from your internet connection; with one, the limit is much higher. Get one by signing in at [data.cityofnewyork.us](https://data.cityofnewyork.us/) → **Developer Settings** → **Create New App Token**. |
| `NYCRI_BASE_URL` | `https://data.cityofnewyork.us/resource/` | Where the data is fetched from. Leave as is. |
| `NYCRI_READ_ONLY` | `0` | Set to `1` to hide tools that change data. Every tool here is already read-only, so this changes nothing; it exists for consistency with the other connectors. |

To set the app token, add an `env` block next to `args`:

```json
"nyc-restaurant-inspections": {
  "command": "npx",
  "args": ["-y", "tsx", "/ABSOLUTE/PATH/TO/nyc-restaurant-inspections/src/server.ts"],
  "env": { "NYCRI_APP_TOKEN": "your-app-token" }
}
```

For Claude Code: `claude mcp add nyc-restaurant-inspections --scope user --env NYCRI_APP_TOKEN=your-app-token -- npx -y tsx /ABSOLUTE/PATH/TO/nyc-restaurant-inspections/src/server.ts`

## Troubleshooting

| Problem | What to do |
|---|---|
| The tools don't appear in Claude Desktop | Fully quit Claude Desktop (not just close the window) and reopen it. Check the JSON is valid (no trailing commas) and the path points at `server.ts`. Logs: **Settings → Developer → Open Logs Folder**, file `mcp-server-nyc-restaurant-inspections.log`. |
| "spawn npx ENOENT" or "command not found" | Claude can't find Node.js. Install Node.js 22+ from nodejs.org, or put the full path to `npx` in `"command"` (run `which npx` on macOS/Linux, `where npx` on Windows). On Windows, if it still fails, use `"command": "cmd"` and put `"/c", "npx"` at the start of `args`. |
| "Cannot find package '@modelcontextprotocol/sdk'" or "zod" | Run `npm ci` in the `nyc-restaurant-inspections` folder. |
| "NYC Open Data is rate-limiting requests" | Wait a minute, or set `NYCRI_APP_TOKEN` (see above). |
| "Could not reach NYC Open Data" | Check your internet connection; the city's site may also be briefly down. |
| A restaurant you know isn't found | Search with a shorter piece of its name (for example `joe` instead of `Joe's Famous Pizza`). The dataset only includes restaurants that are currently open. |
| Very recent inspections are missing | The Health Department publishes results a few days after an inspection. |
| `grade_summary` for a whole borough is slow | It counts every restaurant in the borough (over 10,000 in Manhattan) and can take around 10 seconds. A ZIP code is much faster. |

To test the server by hand: `npx tsx src/server.ts` from the
repository folder should print `nyc-restaurant-inspections-mcp 0.1.0 ready` and wait for input
(press Ctrl+C to stop).

## About the data

Source: [DOHMH New York City Restaurant Inspection Results](https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j)
(dataset `43nn-pn8j`), published by the NYC Department of Health and Mental Hygiene on NYC Open Data
and queried through the Socrata SODA API. It covers restaurants and college cafeterias that are
currently active, with up to three years of inspections.

- **Current grade** is the grade from the restaurant's most recent inspection that produced a grade.
- **Grade codes:** A, B, C; `Z` = grade pending; `P` = grade pending after re-opening following a
  closure (both counted as "pending"); `N` = not yet graded.
- **Score:** points for violations found; lower is better (0–13 points is an A on a graded inspection).
- Restaurants that have a permit but no inspection yet show no last inspection date.

## Unverified

Dataset id, column names, borough spellings, grade codes, the `X-App-Token` header and the 50,000-row
page size were confirmed against the dataset's published metadata, the SODA documentation and live
queries. These points are this connector's own interpretation, not from official documentation:

- "Current grade" = grade from the latest inspection that has a grade. The city's own grade website
  may differ in edge cases (for example while a grade is being adjudicated).
- The `grade_summary` note says "grade pending" usually means a B or C is being contested; the dataset
  dictionary only says "Grade Pending".
- The "0–13 points is an A" score range comes from the city's public grading rules, not from the
  dataset documentation.

## For developers

Code: `src/client.ts` (all SoQL queries), `src/tools.ts` (tools and output shaping),
`src/server.ts` (stdio entry point). Tests in `test/` use a fake `fetch` and invented data;
run `npm run check` at the repository root.

## About

Built by **[Jorge Peralta Consulting](https://github.com/jorge-peralta-consulting)** as a sample of the custom MCP servers I build for businesses: tested, documented and read-only by default.

Want Claude connected to your own CRM, database or internal tools? [Order a custom MCP server on Fiverr](https://www.fiverr.com/sellers/jorgeperalta784/).

Not affiliated with or endorsed by the NYC Department of Health and Mental Hygiene. Data: [NYC Open Data, DOHMH New York City Restaurant Inspection Results](https://data.cityofnewyork.us/).

## License

MIT. See [LICENSE](LICENSE).
