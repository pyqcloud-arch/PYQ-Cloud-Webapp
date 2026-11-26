import { adminResponse, authorizeAdmin } from "../../../../lib/supabase/admin-server";
import { createAnnouncement } from "../../../../lib/notifications/push-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const normalize = (kind, value) => kind === "year" ? String(Number(value)) : String(value || "").trim().replace(/\s+/g, " ");
const seededSubjectDefaults = new Set(["polity", "economy", "geography", "history", "art and culture", "international relations", "science and technology", "environment", "current affairs", "miscellaneous"]);
const seededYearDefaults = new Set(Array.from({ length: 16 }, (_, index) => String(2026 - index)));

async function readCatalog(database) {
  const settingsPromise = database.from("app_settings").select("value").eq("key", "catalog").maybeSingle();
  const questionRows = [];
  let totalQuestions = 0;
  for (let offset = 0; ; ) {
    const { data, error, count } = await database.from("questions")
      .select("subject, year", offset === 0 ? { count: "exact" } : undefined)
      .range(offset, offset + 499);
    if (error) throw new Error("Could not read subjects and years from the question bank.");
    const rows = data || [];
    if (offset === 0) totalQuestions = count ?? rows.length;
    questionRows.push(...rows);
    if (!rows.length || offset + rows.length >= totalQuestions) break;
    offset += rows.length;
  }
  const settingsResult = await settingsPromise;
  if (settingsResult.error) throw new Error("Could not read the practice catalogue. Apply the admin catalogue migration first.");
  const saved = settingsResult.data?.value || {};
  const savedSubjects = Array.isArray(saved.subjects) ? saved.subjects : [];
  const savedYears = Array.isArray(saved.years) ? saved.years : [];
  const subjects = new Map();
  const years = new Map();
  const put = (map, raw, kind) => {
    const value = normalize(kind, raw);
    if (!value || (kind === "year" && (!/^\d{4}$/.test(value) || Number(value) < 1900 || Number(value) > 2100))) return;
    const key = value.toLowerCase();
    const old = map.get(key);
    map.set(key, { value: old?.value || value, active: old?.active ?? true, questionCount: old?.questionCount || 0 });
  };
  questionRows.forEach((question) => {
    put(subjects, question.subject, "subject");
    put(years, question.year, "year");
    const subject = subjects.get(String(question.subject || "").trim().replace(/\s+/g, " ").toLowerCase());
    const year = years.get(normalize("year", question.year).toLowerCase());
    if (subject) subject.questionCount += 1;
    if (year) year.questionCount += 1;
  });
  savedSubjects.forEach((entry) => {
    const key = normalize("subject", entry?.value).toLowerCase();
    const row = subjects.get(key);
    // The initial catalogue migration seeded generic labels. Hide those stale
    // placeholders when the live question bank has no matching questions.
    if (!row && seededSubjectDefaults.has(key)) return;
    put(subjects, entry?.value, "subject");
    const savedRow = subjects.get(key);
    if (savedRow) savedRow.active = entry.active !== false;
  });
  savedYears.forEach((entry) => {
    const key = normalize("year", entry?.value).toLowerCase();
    const row = years.get(key);
    if (!row && seededYearDefaults.has(key)) return;
    put(years, entry?.value, "year");
    const savedRow = years.get(key);
    if (savedRow) savedRow.active = entry.active !== false;
  });
  return { subjects: [...subjects.values()].sort((a, b) => a.value.localeCompare(b.value)), years: [...years.values()].sort((a, b) => Number(b.value) - Number(a.value)) };
}

async function saveCatalog(database, next) {
  const { error } = await database.from("app_settings").upsert({ key: "catalog", value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error("Could not save catalogue changes. Check the Supabase app_settings migration and server key.");
}

export async function GET(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  try { return adminResponse(await readCatalog(auth.database)); }
  catch (error) { return adminResponse({ error: error.message }, 500); }
}

export async function POST(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch { return adminResponse({ error: "Provide valid JSON." }, 400); }
  const kind = body?.kind;
  const value = normalize(kind, body?.value);
  if (!["subject", "year"].includes(kind) || !value || value.length > 120 || (kind === "year" && (!/^\d{4}$/.test(value) || Number(value) < 1900 || Number(value) > 2100))) {
    return adminResponse({ error: "Enter a subject name or a year between 1900 and 2100." }, 400);
  }
  try {
    const { data } = await auth.database.from("app_settings").select("value").eq("key", "catalog").maybeSingle();
    const catalog = data?.value || { subjects: [], years: [] };
    const field = kind === "subject" ? "subjects" : "years";
    const items = Array.isArray(catalog[field]) ? [...catalog[field]] : [];
    const index = items.findIndex((item) => normalize(kind, item?.value).toLowerCase() === value.toLowerCase());
    const notifyUsers = index < 0 || items[index]?.active === false;
    if (index < 0) items.push({ value, active: true }); else items[index] = { ...items[index], value: items[index].value || value, active: true };
    await saveCatalog(auth.database, { ...catalog, [field]: items });
    if (notifyUsers) {
      try {
        await createAnnouncement(auth.database, {
          title: kind === "year" ? "New practice year added" : "New practice subject added",
          body: kind === "year" ? `The ${value} practice set is now available.` : `${value} is now available in Practice by Subject.`,
          url: "/",
          createdBy: auth.user.id,
        });
      } catch (notificationError) {
        console.error("New catalogue notification could not be sent", notificationError.message);
      }
    }
    return adminResponse({ saved: true, ...(await readCatalog(auth.database)) });
  } catch (error) { return adminResponse({ error: error.message }, 500); }
}

export async function DELETE(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind");
  const value = normalize(kind, searchParams.get("value"));
  if (!["subject", "year"].includes(kind) || !value) return adminResponse({ error: "Choose a subject or year to remove." }, 400);
  try {
    const { data } = await auth.database.from("app_settings").select("value").eq("key", "catalog").maybeSingle();
    const catalog = data?.value || { subjects: [], years: [] };
    const field = kind === "subject" ? "subjects" : "years";
    const items = Array.isArray(catalog[field]) ? [...catalog[field]] : [];
    const index = items.findIndex((item) => normalize(kind, item?.value).toLowerCase() === value.toLowerCase());
    if (index < 0) items.push({ value, active: false }); else items[index] = { ...items[index], active: false };
    await saveCatalog(auth.database, { ...catalog, [field]: items });
    return adminResponse({ removed: true, note: "Removed from practice selection; existing question records are preserved.", ...(await readCatalog(auth.database)) });
  } catch (error) { return adminResponse({ error: error.message }, 500); }
}
