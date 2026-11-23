import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
const response = (value) => NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });

async function loadQuestionCatalogRows(database) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await database.from("questions")
      .select("id, subject, year")
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) return { data: null, error };
    const page = data || [];
    if (!page.length) break;
    rows.push(...page);
    offset += page.length;
  }
  return { data: rows, error: null };
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const database = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const [settingsResult, questionsResult] = await Promise.all([
    database.from("app_settings").select("value").eq("key", "catalog").maybeSingle(),
    loadQuestionCatalogRows(database),
  ]);
  if (settingsResult.error || questionsResult.error) return NextResponse.json({ error: "Could not load the practice catalogue from Supabase." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const saved = settingsResult.data?.value || {};
  const savedYears = Array.isArray(saved.years) ? saved.years : [];
  const seededYearDefaults = new Set(Array.from({ length: 16 }, (_, index) => String(2026 - index)));
  const activeValues = (dynamic, overrides, kind) => {
    const values = new Map();
    dynamic.forEach((item) => { const value = String(item || "").trim(); if (value) values.set(value.toLowerCase(), value); });
    (Array.isArray(overrides) ? overrides : []).forEach((entry) => { const value = String(entry?.value || "").trim(); if (value) { const id = value.toLowerCase(); if (entry.active === false) values.delete(id); else values.set(id, values.get(id) || value); } });
    return [...values.values()].sort(kind === "year" ? (a, b) => Number(b) - Number(a) : (a, b) => a.localeCompare(b));
  };
  const questionRows = questionsResult.data || [];
  const yearOptions = new Map();
  questionRows.forEach((item) => {
    const year = String(item.year || "").trim();
    if (/^\d{4}$/.test(year)) yearOptions.set(year, { value: year, active: true });
  });
  savedYears.forEach((entry) => {
    const year = String(entry?.value || "").trim();
    if (!/^\d{4}$/.test(year) || (!yearOptions.has(year) && seededYearDefaults.has(year))) return;
    yearOptions.set(year, { value: year, active: entry.active !== false });
  });
  const years = [...yearOptions.values()].filter((entry) => entry.active).map((entry) => entry.value).sort((a, b) => Number(b) - Number(a));
  return response({
    subjects: activeValues(questionRows.map((item) => item.subject), saved.subjects, "subject"),
    years,
  });
}
