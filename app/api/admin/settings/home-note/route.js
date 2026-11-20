import { adminResponse, authorizeAdmin } from "../../../../../lib/supabase/admin-server";

export const dynamic = "force-dynamic";
const defaults = { heading: "A note for you", subtitle: "Today is a new day!", text: "Every question that you practice brings you one step closer to your dream." };
const response = (body, status = 200) => adminResponse(body, status);

export async function GET(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  const { data, error } = await auth.database.from("app_settings").select("value").eq("key", "home_note").maybeSingle();
  if (error) return response({ error: "Could not load the home note from Supabase." }, 500);
  return response({ ...defaults, ...(data?.value && typeof data.value === "object" ? data.value : {}) });
}

export async function PUT(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch { return response({ error: "Provide valid JSON note settings." }, 400); }
  const settings = {
    heading: typeof body?.heading === "string" ? body.heading.trim() : "",
    subtitle: typeof body?.subtitle === "string" ? body.subtitle.trim() : "",
    text: typeof body?.text === "string" ? body.text.trim() : "",
  };
  if (!settings.heading || !settings.text || settings.heading.length > 100 || settings.subtitle.length > 160 || settings.text.length > 500) {
    return response({ error: "Add a heading and text. Keep the heading under 100 characters and the text under 500." }, 400);
  }
  const { error } = await auth.database.from("app_settings").upsert({ key: "home_note", value: settings, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return response({ error: "Could not save the home note. Check the Supabase app_settings table." }, 500);
  return response({ saved: true, ...settings });
}
