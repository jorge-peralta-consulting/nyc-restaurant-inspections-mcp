import { HttpClient, HttpError, type FetchLike } from "./shared/index.ts";

/**
 * NYC Open Data: "DOHMH New York City Restaurant Inspection Results".
 * Dataset page: https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j
 * API: Socrata SODA (https://dev.socrata.com/docs/queries/). No key needed; an optional app token
 * is sent in the X-App-Token header (https://dev.socrata.com/docs/app-tokens.html).
 *
 * The dataset has one row per violation; inspection fields repeat on every violation row.
 */
export const DATASET_ID = "43nn-pn8j";
export const DEFAULT_BASE_URL = "https://data.cityofnewyork.us/resource/";

/** Borough values exactly as they appear in the dataset's `boro` column. */
export const BOROUGHS = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"] as const;
export type Borough = (typeof BOROUGHS)[number];

/** One raw row from the dataset (only the columns this connector uses). All values arrive as strings. */
export interface InspectionRow {
  camis?: string;
  dba?: string;
  boro?: string;
  building?: string;
  street?: string;
  zipcode?: string;
  phone?: string;
  cuisine_description?: string;
  inspection_date?: string;
  action?: string;
  violation_code?: string;
  violation_description?: string;
  critical_flag?: string;
  score?: string;
  grade?: string;
  grade_date?: string;
  inspection_type?: string;
}

export interface Area {
  borough?: Borough;
  zip?: string;
}

export interface RestaurantFilter extends Area {
  name?: string;
  cuisine?: string;
}

/** Rows fetched per page for whole-area scans (SODA's documented maximum page size is 50,000). */
const PAGE_SIZE = 50_000;
/** Safety cap for whole-area scans so one call can never run away. */
const MAX_PAGES = 10;

/** Quote a value as a SoQL string literal. Single quotes are escaped by doubling them. */
export function soqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Format a Date as a SoQL floating timestamp (the dataset's date columns have no time zone). */
export function soqlDate(date: Date): string {
  return `'${date.toISOString().slice(0, 10)}T00:00:00'`;
}

export function areaClauses(area: Area): string[] {
  const clauses: string[] = [];
  if (area.borough) clauses.push(`boro = ${soqlString(area.borough)}`);
  if (area.zip) clauses.push(`zipcode = ${soqlString(area.zip)}`);
  return clauses;
}

export class NycRestaurantClient {
  private readonly http: HttpClient;

  constructor(config: { NYCRI_BASE_URL?: string; NYCRI_APP_TOKEN?: string } = {}, fetchImpl?: FetchLike) {
    const token = config.NYCRI_APP_TOKEN?.trim();
    this.http = new HttpClient({
      baseUrl: config.NYCRI_BASE_URL || DEFAULT_BASE_URL,
      headers: token ? { "X-App-Token": token } : {},
      secrets: token ? [token] : [],
      fetch: fetchImpl,
    });
  }

  /** Run one SoQL query against the dataset. Errors are turned into messages a person can act on. */
  async query<T = InspectionRow>(params: Record<string, string | number | undefined>): Promise<T[]> {
    try {
      const rows = await this.http.get<T[] | null>(`${DATASET_ID}.json`, params);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      throw friendlyError(error);
    }
  }

  /** Distinct restaurants matching the filters, with their last inspection date. */
  searchRestaurants(filter: RestaurantFilter, limit: number) {
    const where = areaClauses(filter);
    if (filter.name) where.push(`upper(dba) like ${soqlString(`%${filter.name.toUpperCase()}%`)}`);
    if (filter.cuisine) where.push(`upper(cuisine_description) like ${soqlString(`%${filter.cuisine.toUpperCase()}%`)}`);
    return this.query<InspectionRow & { last_inspection_date?: string }>({
      $select: "camis,dba,boro,building,street,zipcode,cuisine_description,max(inspection_date) as last_inspection_date",
      $where: where.join(" AND "),
      $group: "camis,dba,boro,building,street,zipcode,cuisine_description",
      $order: "dba,camis",
      $limit: limit,
    });
  }

  /** Every graded inspection (one row per inspection) for the given restaurant ids. */
  gradesFor(camisIds: string[]) {
    if (camisIds.length === 0) return Promise.resolve([] as InspectionRow[]);
    return this.query({
      $select: "camis,grade,inspection_date",
      $where: `camis in (${camisIds.map(soqlString).join(",")}) AND grade IS NOT NULL`,
      $group: "camis,grade,inspection_date",
      $order: "camis,inspection_date DESC",
      $limit: PAGE_SIZE,
    });
  }

  /** All rows (inspections and violations) for one restaurant, newest first. */
  restaurantRows(camis: string, maxRows = 2000) {
    return this.query({
      $where: `camis = ${soqlString(camis)}`,
      $order: "inspection_date DESC,violation_code",
      $limit: maxRows,
    });
  }

  /** Critical violations in an area on or after `since`, newest first. */
  criticalViolations(area: Area, since: Date, limit: number) {
    return this.query({
      $select: "camis,dba,boro,building,street,zipcode,cuisine_description,inspection_date,inspection_type,violation_code,violation_description,score",
      $where: [...areaClauses(area), `critical_flag = 'Critical'`, `inspection_date >= ${soqlDate(since)}`].join(" AND "),
      $order: "inspection_date DESC,camis,violation_code",
      $limit: limit,
    });
  }

  /** Every graded inspection (one row per inspection) in an area, paging through the whole result. */
  async areaGrades(area: Area): Promise<InspectionRow[]> {
    const all: InspectionRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.query({
        $select: "camis,grade,inspection_date",
        $where: [...areaClauses(area), "grade IS NOT NULL"].join(" AND "),
        $group: "camis,grade,inspection_date",
        $order: "camis,inspection_date",
        $limit: PAGE_SIZE,
        $offset: page * PAGE_SIZE,
      });
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return all;
  }

  /** Number of distinct restaurants in an area (graded or not). */
  async countRestaurants(area: Area): Promise<number> {
    const rows = await this.query<{ count?: string }>({
      $select: "count(distinct camis) as count",
      $where: areaClauses(area).join(" AND "),
    });
    return Number(rows[0]?.count ?? 0);
  }
}

function friendlyError(error: unknown): Error {
  if (error instanceof HttpError) {
    if (error.status === 429) {
      return new Error("NYC Open Data is rate-limiting requests right now. Wait a minute and try again, or set NYCRI_APP_TOKEN for a higher limit.");
    }
    if (error.status >= 500) {
      return new Error(`NYC Open Data is temporarily unavailable (HTTP ${error.status}). Please try again in a few minutes.`);
    }
    if (error.status === 401 || error.status === 403) {
      return new Error(`NYC Open Data refused the request (HTTP ${error.status}). If NYCRI_APP_TOKEN is set, check that it is a valid app token.`);
    }
    return new Error(`NYC Open Data rejected the query (HTTP ${error.status}): ${error.message}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Could not reach NYC Open Data. Check the internet connection and try again. (${message})`);
}
