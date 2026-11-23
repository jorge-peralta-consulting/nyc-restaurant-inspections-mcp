import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "../src/shared/index.ts";
import { z } from "zod";
import { NycRestaurantClient } from "../src/client.ts";
import { tools } from "../src/tools.ts";

/**
 * Tests never call the real API. The fake fetch answers by looking at the SoQL query, records every
 * request, and serves invented restaurants (names, ids and addresses below are made up).
 */
type Route = (params: URLSearchParams) => unknown;

function setup(route: Route, options: { token?: string; status?: number; throwError?: boolean } = {}) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (options.throwError) throw new Error("getaddrinfo ENOTFOUND");
    if (options.status) return new Response(JSON.stringify({ message: "nope" }), { status: options.status });
    return new Response(JSON.stringify(route(url.searchParams)), { status: 200 });
  };
  const client = new NycRestaurantClient({ NYCRI_BASE_URL: "https://soda.test/resource/", NYCRI_APP_TOKEN: options.token }, fetchImpl);
  const list = tools(client, { now: () => new Date("2025-06-30T15:00:00Z") });
  const byName = Object.fromEntries(list.map((tool) => [tool.name, tool]));
  const where = (index: number) => calls[index]!.url.searchParams.get("$where");
  return { calls, byName, list, where };
}

const RESTAURANTS = [
  { camis: "90000001", dba: "TESTY'S PIZZA", boro: "Brooklyn", building: "12", street: "MADEUP   AVENUE", zipcode: "11201", cuisine_description: "Pizza", last_inspection_date: "2025-05-02T00:00:00.000" },
  { camis: "90000002", dba: "TESTY'S PIZZA EXPRESS", boro: "Brooklyn", building: "400", street: "FICTION STREET", zipcode: "11201", cuisine_description: "Pizza", last_inspection_date: "1900-01-01T00:00:00.000" },
];

const GRADES = [
  { camis: "90000001", grade: "B", inspection_date: "2024-01-10T00:00:00.000" },
  { camis: "90000001", grade: "A", inspection_date: "2025-05-02T00:00:00.000" },
];

test("search_restaurants filters by name and borough and joins the current grade", async () => {
  const { calls, byName, where } = setup((params) => (params.get("$group")?.startsWith("camis,dba") ? RESTAURANTS : GRADES));
  const result: any = await byName.search_restaurants!.handler({ name: "testy's", borough: "Brooklyn", limit: 20 });

  assert.equal(calls[0]!.url.pathname, "/resource/43nn-pn8j.json");
  assert.equal(where(0), "boro = 'Brooklyn' AND upper(dba) like '%TESTY''S%'");
  assert.equal(calls[0]!.url.searchParams.get("$limit"), "21");
  assert.equal(where(1), "camis in ('90000001','90000002') AND grade IS NOT NULL");

  assert.equal(result.restaurants.length, 2);
  assert.equal(result.more_available, false);
  assert.deepEqual(result.restaurants[0], {
    restaurant_id: "90000001",
    name: "TESTY'S PIZZA",
    address: "12 MADEUP AVENUE",
    borough: "Brooklyn",
    zip: "11201",
    cuisine: "Pizza",
    current_grade: "A",
    current_grade_meaning: "Grade A",
    last_inspection_date: "2025-05-02",
  });
  // Not inspected yet: 1900-01-01 placeholder becomes null, and there is no grade.
  assert.equal(result.restaurants[1].last_inspection_date, null);
  assert.equal(result.restaurants[1].current_grade, null);
  assert.equal(result.restaurants[1].current_grade_meaning, "No grade on record");
});

test("search_restaurants supports zip and cuisine filters and reports when more results exist", async () => {
  const { byName, where } = setup((params) => (params.get("$group")?.startsWith("camis,dba") ? RESTAURANTS : []));
  const result: any = await byName.search_restaurants!.handler({ zip: "11201", cuisine: "pizza", limit: 1 });
  assert.equal(where(0), "zipcode = '11201' AND upper(cuisine_description) like '%PIZZA%'");
  assert.equal(result.restaurants.length, 1);
  assert.equal(result.more_available, true);
  assert.match(result.message, /More restaurants match/);
});

test("search_restaurants keeps one entry per restaurant id", async () => {
  const renamed = { ...RESTAURANTS[0]!, dba: "OLD NAME", last_inspection_date: "2023-01-01T00:00:00.000" };
  const { byName } = setup((params) => (params.get("$group")?.startsWith("camis,dba") ? [renamed, RESTAURANTS[0]] : []));
  const result: any = await byName.search_restaurants!.handler({ name: "testy", limit: 20 });
  assert.equal(result.restaurants.length, 1);
  assert.equal(result.restaurants[0].name, "TESTY'S PIZZA");
});

test("search_restaurants needs a filter and handles no matches", async () => {
  const { calls, byName } = setup(() => []);
  await assert.rejects(byName.search_restaurants!.handler({ limit: 20 }), /at least one of/);
  assert.equal(calls.length, 0);
  const result: any = await byName.search_restaurants!.handler({ name: "nothing like this", limit: 20 });
  assert.deepEqual(result.restaurants, []);
  assert.match(result.message, /No restaurants matched/);
});

const HISTORY = [
  { camis: "90000001", dba: "TESTY'S PIZZA", boro: "Brooklyn", building: "12", street: "MADEUP AVENUE", zipcode: "11201", phone: "5550100000", cuisine_description: "Pizza",
    inspection_date: "2025-05-02T00:00:00.000", inspection_type: "Cycle Inspection / Re-inspection", action: "Violations were cited in the following area(s).",
    violation_code: "02B", violation_description: "Invented hot food violation.", critical_flag: "Critical", score: "9", grade: "A", grade_date: "2025-05-02T00:00:00.000" },
  { camis: "90000001", dba: "TESTY'S PIZZA", inspection_date: "2025-05-02T00:00:00.000", inspection_type: "Cycle Inspection / Re-inspection",
    action: "Violations were cited in the following area(s).", violation_code: "10F", violation_description: "Invented surface violation.", critical_flag: "Not Critical", score: "9", grade: "A" },
  { camis: "90000001", dba: "TESTY'S PIZZA", inspection_date: "2025-03-15T00:00:00.000", inspection_type: "Cycle Inspection / Initial Inspection",
    action: "Violations were cited in the following area(s).", violation_code: "04L", violation_description: "Invented pest violation.", critical_flag: "Critical", score: "24" },
  { camis: "90000001", dba: "TESTY'S PIZZA", inspection_date: "2024-01-10T00:00:00.000", inspection_type: "Cycle Inspection / Initial Inspection",
    action: "No violations were recorded at the time of this inspection.", score: "0", grade: "A" },
];

test("get_inspection_history groups violations into inspections, newest first", async () => {
  const { calls, byName, where } = setup(() => HISTORY);
  const result: any = await byName.get_inspection_history!.handler({ restaurant_id: "90000001", limit: 20 });

  assert.equal(where(0), "camis = '90000001'");
  assert.equal(calls[0]!.url.searchParams.get("$order"), "inspection_date DESC,violation_code");
  assert.equal(result.restaurant.name, "TESTY'S PIZZA");
  assert.equal(result.restaurant.phone, "5550100000");
  assert.equal(result.inspection_count, 3);
  assert.deepEqual(result.inspections.map((i: any) => i.date), ["2025-05-02", "2025-03-15", "2024-01-10"]);

  const [latest, middle, oldest] = result.inspections;
  assert.equal(latest.score, 9);
  assert.equal(latest.grade, "A");
  assert.equal(latest.grade_date, "2025-05-02");
  assert.equal(latest.critical_violations, 1);
  assert.deepEqual(latest.violations, [
    { code: "02B", description: "Invented hot food violation.", critical: true },
    { code: "10F", description: "Invented surface violation.", critical: false },
  ]);
  assert.equal(middle.grade, null);
  assert.equal(middle.score, 24);
  assert.deepEqual(oldest.violations, []);
  assert.equal(oldest.critical_violations, 0);
});

test("get_inspection_history applies the limit and handles unknown or uninspected restaurants", async () => {
  const limited: any = await setup(() => HISTORY).byName.get_inspection_history!.handler({ restaurant_id: "90000001", limit: 1 });
  assert.equal(limited.inspections.length, 1);
  assert.match(limited.message, /newest 1 of 3/);

  const missing: any = await setup(() => []).byName.get_inspection_history!.handler({ restaurant_id: "123", limit: 20 });
  assert.match(missing.message, /No restaurant found with id 123/);

  const placeholder = [{ camis: "90000002", dba: "TESTY'S PIZZA EXPRESS", inspection_date: "1900-01-01T00:00:00.000" }];
  const fresh: any = await setup(() => placeholder).byName.get_inspection_history!.handler({ restaurant_id: "90000002", limit: 20 });
  assert.deepEqual(fresh.inspections, []);
  assert.match(fresh.message, /not been inspected yet/);
});

test("recent_critical_violations queries the area and date window", async () => {
  const rows = [HISTORY[0], HISTORY[2]];
  const { calls, byName, where } = setup(() => rows);
  const result: any = await byName.recent_critical_violations!.handler({ zip: "11201", days: 30, limit: 1 });

  assert.equal(where(0), "zipcode = '11201' AND critical_flag = 'Critical' AND inspection_date >= '2025-05-31T00:00:00'");
  assert.equal(calls[0]!.url.searchParams.get("$order"), "inspection_date DESC,camis,violation_code");
  assert.equal(calls[0]!.url.searchParams.get("$limit"), "2");
  assert.equal(result.area, "ZIP 11201");
  assert.equal(result.since, "2025-05-31");
  assert.equal(result.violations.length, 1);
  assert.equal(result.more_available, true);
  assert.deepEqual(result.violations[0], {
    restaurant_id: "90000001",
    name: "TESTY'S PIZZA",
    address: "12 MADEUP AVENUE",
    zip: "11201",
    borough: "Brooklyn",
    inspection_date: "2025-05-02",
    violation_code: "02B",
    violation: "Invented hot food violation.",
  });
});

test("recent_critical_violations needs an area and handles empty results", async () => {
  const { calls, byName, where } = setup(() => []);
  await assert.rejects(byName.recent_critical_violations!.handler({ days: 30, limit: 20 }), /zip code or a borough/);
  assert.equal(calls.length, 0);
  const result: any = await byName.recent_critical_violations!.handler({ borough: "Staten Island", days: 7, limit: 20 });
  assert.match(where(0)!, /^boro = 'Staten Island' AND /);
  assert.deepEqual(result.violations, []);
  assert.match(result.message, /No critical violations recorded in Staten Island in the last 7 days/);
});

test("grade_summary counts each restaurant once, by its latest grade", async () => {
  const graded = [
    { camis: "1", grade: "C", inspection_date: "2024-01-01T00:00:00.000" },
    { camis: "1", grade: "A", inspection_date: "2025-01-01T00:00:00.000" },
    { camis: "2", grade: "B", inspection_date: "2025-02-01T00:00:00.000" },
    { camis: "3", grade: "Z", inspection_date: "2025-03-01T00:00:00.000" },
    { camis: "4", grade: "P", inspection_date: "2025-03-01T00:00:00.000" },
    { camis: "5", grade: "N", inspection_date: "2025-04-01T00:00:00.000" },
    { camis: "6", grade: "A", inspection_date: "2025-04-01T00:00:00.000" },
    { camis: "6", grade: "C", inspection_date: "2025-06-01T00:00:00.000" },
  ];
  const { calls, byName } = setup((params) => (params.get("$select")?.startsWith("count") ? [{ count: "8" }] : graded));
  const result: any = await byName.grade_summary!.handler({ zip: "11201", borough: "Brooklyn" });

  const gradeCall = calls.find((call) => call.url.searchParams.get("$group"))!;
  assert.equal(gradeCall.url.searchParams.get("$where"), "boro = 'Brooklyn' AND zipcode = '11201' AND grade IS NOT NULL");
  assert.equal(result.area, "ZIP 11201, Brooklyn");
  assert.deepEqual(result.counts, { A: 1, B: 1, C: 1, pending: 2, not_yet_graded: 1 });
  assert.equal(result.restaurants_counted, 6);
  assert.equal(result.restaurants_total, 8);
  assert.equal(result.restaurants_without_grade, 2);
  assert.equal(result.percent.pending, 33.3);
});

test("grade_summary pages through large areas", async () => {
  const fullPage = Array.from({ length: 50_000 }, (_, i) => ({ camis: String(i), grade: "A", inspection_date: "2025-01-01T00:00:00.000" }));
  const { calls, byName } = setup((params) => {
    if (params.get("$select")?.startsWith("count")) return [{ count: "50001" }];
    return params.get("$offset") === "0" ? fullPage : [{ camis: "x", grade: "B", inspection_date: "2025-01-01T00:00:00.000" }];
  });
  const result: any = await byName.grade_summary!.handler({ borough: "Queens" });
  const offsets = calls.map((call) => call.url.searchParams.get("$offset")).filter(Boolean);
  assert.deepEqual(offsets, ["0", "50000"]);
  assert.deepEqual(result.counts, { A: 50_000, B: 1, C: 0, pending: 0, not_yet_graded: 0 });
});

test("grade_summary needs an area and handles an empty area", async () => {
  const { byName } = setup((params) => (params.get("$select")?.startsWith("count") ? [{ count: "0" }] : []));
  await assert.rejects(byName.grade_summary!.handler({}), /zip code or a borough/);
  const result: any = await byName.grade_summary!.handler({ zip: "00000" });
  assert.match(result.message, /No restaurants found in ZIP 00000/);
});

test("the app token is sent as X-App-Token only when set, and never leaks into errors", async () => {
  const withToken = setup(() => [], { token: "invented-token-abc" });
  await withToken.byName.search_restaurants!.handler({ name: "x y", limit: 20 });
  assert.equal(withToken.calls[0]!.headers["X-App-Token"], "invented-token-abc");

  const without = setup(() => []);
  await without.byName.search_restaurants!.handler({ name: "x y", limit: 20 });
  assert.equal(without.calls[0]!.headers["X-App-Token"], undefined);

  const rejected = setup(() => [], { token: "invented-token-abc", status: 403 });
  await assert.rejects(rejected.byName.get_inspection_history!.handler({ restaurant_id: "1", limit: 20 }), (error: Error) => {
    assert.match(error.message, /NYCRI_APP_TOKEN/);
    assert.doesNotMatch(error.message, /invented-token-abc/);
    return true;
  });
});

test("rate limits and network failures become friendly errors", async () => {
  await assert.rejects(setup(() => [], { status: 429 }).byName.grade_summary!.handler({ zip: "11201" }), /rate-limiting/);
  await assert.rejects(setup(() => [], { status: 400 }).byName.grade_summary!.handler({ zip: "11201" }), /rejected the query \(HTTP 400\)/);
  await assert.rejects(setup(() => [], { throwError: true }).byName.grade_summary!.handler({ zip: "11201" }), /Could not reach NYC Open Data/);
});

test("inputs are validated: limits default to 20, max 100, ZIPs are 5 digits", () => {
  const { byName } = setup(() => []);
  const search = z.object(byName.search_restaurants!.input);
  assert.equal(search.parse({ name: "pizza" }).limit, 20);
  assert.equal(search.safeParse({ name: "pizza", limit: 101 }).success, false);
  assert.equal(search.safeParse({ zip: "1001" }).success, false);
  assert.equal(search.safeParse({ borough: "Manhattan" }).success, true);
  assert.equal(search.safeParse({ borough: "Jersey City" }).success, false);
  const history = z.object(byName.get_inspection_history!.input);
  assert.equal(history.safeParse({ restaurant_id: "40356018' OR 1=1" }).success, false);
  const recent = z.object(byName.recent_critical_violations!.input);
  assert.equal(recent.parse({ zip: "10012" }).days, 30);
  assert.equal(recent.safeParse({ zip: "10012", days: 366 }).success, false);
});

test("every tool is read-only and registered even in read-only mode", () => {
  const { list } = setup(() => []);
  assert.ok(list.every((tool) => !tool.writes));
  const names = ["search_restaurants", "get_inspection_history", "recent_critical_violations", "grade_summary"];
  assert.deepEqual(buildServer({ name: "t", version: "0", tools: list }).registered, names);
  assert.deepEqual(buildServer({ name: "t", version: "0", tools: list, readOnly: true }).registered, names);
});
