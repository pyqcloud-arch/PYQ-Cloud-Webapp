import { adminResponse, authorizeAdmin } from "../../../../lib/supabase/admin-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const response = (body, status = 200) => adminResponse(body, status);
const REPORT_PREFIX = "question-report:";
const validReportId = /^[a-f0-9]{64}$/i;

export async function GET(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  const { data: rows, error } = await auth.database.from("app_settings")
    .select("key, value")
    .like("key", `${REPORT_PREFIX}%`)
    .limit(1000);
  if (error) return response({ error: "Could not load question reports from Supabase." }, 503);

  const reports = (rows || []).map((row) => ({ id: row.key.slice(REPORT_PREFIX.length), ...(row.value || {}) }))
    .filter((report) => validReportId.test(report.id) && report.question_id)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const questionIds = [...new Set(reports.map((report) => report.question_id))];
  const profileIds = [...new Set(reports.flatMap((report) => [report.reporter_id, report.reviewed_by]).filter(Boolean))];
  const [questionsResult, profilesResult] = await Promise.all([
    questionIds.length ? auth.database.from("questions").select("id, subject, year, topic, prompt").in("id", questionIds) : Promise.resolve({ data: [], error: null }),
    profileIds.length ? auth.database.from("profiles").select("id, full_name, email, phone").in("id", profileIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (questionsResult.error || profilesResult.error) return response({ error: "Could not load the question and user details for reports." }, 500);
  const questions = new Map((questionsResult.data || []).map((question) => [question.id, question]));
  const profiles = new Map((profilesResult.data || []).map((profile) => [profile.id, profile]));
  return response({
    openCount: reports.filter((report) => report.status === "open").length,
    reports: reports.map((report) => ({
      ...report,
      question: questions.get(report.question_id) || null,
      reporter: profiles.get(report.reporter_id) || null,
      reviewer: profiles.get(report.reviewed_by) || null,
    })),
  });
}

export async function PATCH(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!validReportId.test(id)) return response({ error: "Choose a valid report." }, 400);
  let body;
  try { body = await request.json(); } catch { return response({ error: "Provide a valid report status." }, 400); }
  if (!["open", "resolved", "dismissed"].includes(body?.status)) return response({ error: "Choose open, resolved, or dismissed." }, 400);

  const key = `${REPORT_PREFIX}${id}`;
  const { data: current, error: readError } = await auth.database.from("app_settings").select("value").eq("key", key).maybeSingle();
  if (readError) return response({ error: "Could not read this report from Supabase." }, 500);
  if (!current) return response({ error: "This report no longer exists." }, 404);
  const now = new Date().toISOString();
  const value = {
    ...(current.value || {}),
    status: body.status,
    reviewed_by: body.status === "open" ? null : auth.user.id,
    reviewed_at: body.status === "open" ? null : now,
    updated_at: now,
  };
  const { data, error } = await auth.database.from("app_settings").update({ value, updated_at: now }).eq("key", key).select("key").maybeSingle();
  if (error) return response({ error: "Could not update this report." }, 500);
  if (!data) return response({ error: "This report no longer exists." }, 404);
  return response({ updated: true });
}
