import type { ToolDefinition } from "./shared/index.ts";
import { z } from "zod";
import { BOROUGHS, type Area, type InspectionRow, type NycRestaurantClient } from "./client.ts";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** What each grade code in the dataset means. */
export const GRADE_MEANINGS: Record<string, string> = {
  A: "Grade A",
  B: "Grade B",
  C: "Grade C",
  N: "Not yet graded",
  Z: "Grade pending",
  P: "Grade pending (issued on re-opening after a closure)",
};

const NOT_INSPECTED_DATE = "1900-01-01";

const borough = z.enum(BOROUGHS).optional().describe("NYC borough: Manhattan, Bronx, Brooklyn, Queens or Staten Island");
const zip = z.string().regex(/^\d{5}$/, "ZIP code must be 5 digits, e.g. 10012").optional().describe("5-digit NYC ZIP code, e.g. 10012");
const limit = (what: string) =>
  z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe(`Maximum number of ${what} to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})`);

export interface ToolOptions {
  /** Current time; injected in tests. */
  now?: () => Date;
}

export function tools(client: NycRestaurantClient, options: ToolOptions = {}): ToolDefinition[] {
  const now = options.now ?? (() => new Date());

  return [
    {
      name: "search_restaurants",
      description:
        "Find New York City restaurants in the NYC Health Department inspection data by name, borough, ZIP code and/or cuisine. " +
        "Returns each restaurant's id, name, address, borough, ZIP, cuisine, current letter grade and last inspection date. " +
        "Use the returned restaurant_id with get_inspection_history for details. Read-only; at least one filter is required.",
      input: {
        name: z.string().trim().min(2).max(100).optional().describe("Part of the restaurant's name, e.g. 'joe's pizza' (case-insensitive)"),
        borough,
        zip,
        cuisine: z.string().trim().min(2).max(60).optional().describe("Part of the cuisine as NYC records it, e.g. 'Italian', 'Pizza', 'Chinese', 'Coffee/Tea'"),
        limit: limit("restaurants"),
      },
      handler: async ({ name, borough, zip, cuisine, limit }) => {
        if (!name && !borough && !zip && !cuisine) {
          throw new Error("Give at least one of: name, borough, zip or cuisine.");
        }
        const rows = await client.searchRestaurants({ name, borough, zip, cuisine }, limit + 1);
        const unique = dedupeByCamis(rows).slice(0, limit + 1);
        const moreAvailable = unique.length > limit;
        const page = unique.slice(0, limit);
        const grades = latestGrades(await client.gradesFor(page.map((row) => row.camis!)));
        const restaurants = page.map((row) => {
          const grade = grades.get(row.camis!);
          return {
            restaurant_id: row.camis,
            name: row.dba ?? null,
            address: address(row),
            borough: row.boro ?? null,
            zip: row.zipcode ?? null,
            cuisine: row.cuisine_description ?? null,
            current_grade: grade?.grade ?? null,
            current_grade_meaning: grade ? (GRADE_MEANINGS[grade.grade] ?? grade.grade) : "No grade on record",
            last_inspection_date: inspectionDate(row.last_inspection_date),
          };
        });
        if (restaurants.length === 0) {
          return { restaurants: [], message: "No restaurants matched. Try a shorter part of the name, or fewer filters." };
        }
        return {
          restaurants,
          showing: restaurants.length,
          more_available: moreAvailable,
          ...(moreAvailable ? { message: `More restaurants match. Narrow the search or raise limit (max ${MAX_LIMIT}).` } : {}),
        };
      },
    },
    {
      name: "get_inspection_history",
      description:
        "Get the NYC Health Department inspection history of one restaurant, newest inspection first. " +
        "Each inspection lists its date, type, score (lower is better), grade, outcome and every violation cited " +
        "(code, description, and whether it was critical). Read-only. Needs a restaurant_id from search_restaurants.",
      input: {
        restaurant_id: z.string().trim().regex(/^\d{1,10}$/, "restaurant_id is the numeric id returned by search_restaurants").describe("The restaurant_id (CAMIS number) from search_restaurants"),
        limit: limit("inspections"),
      },
      handler: async ({ restaurant_id, limit }) => {
        const rows = await client.restaurantRows(restaurant_id);
        if (rows.length === 0) {
          return { message: `No restaurant found with id ${restaurant_id}. Use search_restaurants to look up the id.` };
        }
        const first = rows[0]!;
        const inspections = groupInspections(rows);
        return {
          restaurant: {
            restaurant_id: first.camis,
            name: first.dba ?? null,
            address: address(first),
            borough: first.boro ?? null,
            zip: first.zipcode ?? null,
            cuisine: first.cuisine_description ?? null,
            phone: first.phone ?? null,
          },
          inspection_count: inspections.length,
          inspections: inspections.slice(0, limit),
          ...(inspections.length === 0 ? { message: "This restaurant has a permit but has not been inspected yet." } : {}),
          ...(inspections.length > limit ? { message: `Showing the newest ${limit} of ${inspections.length} inspections.` } : {}),
        };
      },
    },
    {
      name: "recent_critical_violations",
      description:
        "List critical violations (those most likely to cause food-borne illness) cited by NYC Health Department inspectors " +
        "in a ZIP code or borough within the last N days, newest first. Each entry has the restaurant, inspection date and violation. " +
        "Read-only. Give a zip or a borough (or both). Note: the city publishes new results with a delay of a few days.",
      input: {
        borough,
        zip,
        days: z.number().int().min(1).max(365).default(30).describe("How many days back to look (1-365, default 30)"),
        limit: limit("violations"),
      },
      handler: async ({ borough, zip, days, limit }) => {
        const area = requireArea({ borough, zip });
        const since = new Date(now().getTime() - days * 86_400_000);
        const rows = await client.criticalViolations(area, since, limit + 1);
        const violations = rows.slice(0, limit).map((row) => ({
          restaurant_id: row.camis,
          name: row.dba ?? null,
          address: address(row),
          zip: row.zipcode ?? null,
          borough: row.boro ?? null,
          inspection_date: inspectionDate(row.inspection_date),
          violation_code: row.violation_code ?? null,
          violation: row.violation_description ?? null,
        }));
        const result = { area: describeArea(area), since: since.toISOString().slice(0, 10), violations, showing: violations.length };
        if (violations.length === 0) return { ...result, message: `No critical violations recorded in ${describeArea(area)} in the last ${days} days.` };
        return { ...result, more_available: rows.length > limit };
      },
    },
    {
      name: "grade_summary",
      description:
        "Count NYC restaurants by their current letter grade (A, B, C, grade pending, not yet graded) in a ZIP code or borough, " +
        "with percentages of the restaurants counted. A restaurant's current grade is the grade from its most recent graded inspection. Read-only. " +
        "Give a zip or a borough (or both). Borough-wide summaries can take a few seconds.",
      input: { borough, zip },
      handler: async ({ borough, zip }) => {
        const area = requireArea({ borough, zip });
        const [rows, total] = await Promise.all([client.areaGrades(area), client.countRestaurants(area)]);
        const current = latestGrades(rows);
        const counts = { A: 0, B: 0, C: 0, pending: 0, not_yet_graded: 0 };
        for (const { grade } of current.values()) {
          if (grade === "A" || grade === "B" || grade === "C") counts[grade]++;
          else if (grade === "Z" || grade === "P") counts.pending++;
          else if (grade === "N") counts.not_yet_graded++;
        }
        const graded = counts.A + counts.B + counts.C + counts.pending + counts.not_yet_graded;
        if (total === 0 && graded === 0) {
          return { area: describeArea(area), message: `No restaurants found in ${describeArea(area)}. Check the ZIP code or borough.` };
        }
        const percent = (n: number) => (graded === 0 ? 0 : Math.round((n / graded) * 1000) / 10);
        return {
          area: describeArea(area),
          counts,
          percent: { A: percent(counts.A), B: percent(counts.B), C: percent(counts.C), pending: percent(counts.pending), not_yet_graded: percent(counts.not_yet_graded) },
          restaurants_counted: graded,
          restaurants_total: Math.max(total, graded),
          restaurants_without_grade: Math.max(total - graded, 0),
          note: "Grade pending means the restaurant is contesting a B or C, or re-opened after a closure. restaurants_without_grade have no grade on record yet (for example new restaurants, or places not subject to letter grading).",
        };
      },
    },
  ];
}

function requireArea(area: Area): Area {
  if (!area.borough && !area.zip) throw new Error("Give a zip code or a borough.");
  return area;
}

function describeArea(area: Area): string {
  return [area.zip && `ZIP ${area.zip}`, area.borough].filter(Boolean).join(", ");
}

function address(row: InspectionRow): string | null {
  const text = [row.building, row.street].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

/** Dataset dates look like "2025-03-14T00:00:00.000". 1900-01-01 means "not inspected yet". */
function inspectionDate(value: string | undefined): string | null {
  const day = value?.slice(0, 10);
  return !day || day === NOT_INSPECTED_DATE ? null : day;
}

function dedupeByCamis<T extends InspectionRow & { last_inspection_date?: string }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    if (!row.camis) continue;
    const seen = byId.get(row.camis);
    if (!seen || (row.last_inspection_date ?? "") > (seen.last_inspection_date ?? "")) byId.set(row.camis, row);
  }
  return [...byId.values()];
}

/** For each restaurant, the grade from its most recent graded inspection. */
function latestGrades(rows: InspectionRow[]): Map<string, { grade: string; date: string }> {
  const latest = new Map<string, { grade: string; date: string }>();
  for (const row of rows) {
    if (!row.camis || !row.grade) continue;
    const date = row.inspection_date ?? "";
    const seen = latest.get(row.camis);
    if (!seen || date > seen.date) latest.set(row.camis, { grade: row.grade, date });
  }
  return latest;
}

interface Inspection {
  date: string | null;
  type: string | null;
  outcome: string | null;
  score: number | null;
  grade: string | null;
  grade_meaning: string | null;
  grade_date: string | null;
  critical_violations: number;
  violations: Array<{ code: string; description: string | null; critical: boolean }>;
}

/** Collapse violation rows into inspections. Rows arrive newest first; order is kept. */
function groupInspections(rows: InspectionRow[]): Inspection[] {
  const inspections = new Map<string, Inspection>();
  for (const row of rows) {
    const date = inspectionDate(row.inspection_date);
    if (!date) continue; // placeholder row for a restaurant that has not been inspected yet
    const key = `${date}|${row.inspection_type ?? ""}`;
    let inspection = inspections.get(key);
    if (!inspection) {
      const score = row.score === undefined ? NaN : Number(row.score);
      inspection = {
        date,
        type: row.inspection_type ?? null,
        outcome: row.action ?? null,
        score: Number.isFinite(score) ? score : null,
        grade: row.grade ?? null,
        grade_meaning: row.grade ? (GRADE_MEANINGS[row.grade] ?? row.grade) : null,
        grade_date: row.grade_date?.slice(0, 10) ?? null,
        critical_violations: 0,
        violations: [],
      };
      inspections.set(key, inspection);
    }
    if (row.violation_code) {
      const critical = row.critical_flag === "Critical";
      inspection.violations.push({ code: row.violation_code, description: row.violation_description ?? null, critical });
      if (critical) inspection.critical_violations++;
    }
  }
  return [...inspections.values()];
}
