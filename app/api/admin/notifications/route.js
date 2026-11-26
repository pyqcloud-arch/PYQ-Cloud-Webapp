import { adminResponse, authorizeAdmin } from "../../../../lib/supabase/admin-server";
import { createAnnouncement } from "../../../../lib/notifications/push-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch { return adminResponse({ error: "Provide valid JSON." }, 400); }
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const message = typeof body?.body === "string" ? body.body.trim() : "";
  if (!title || title.length > 120 || !message || message.length > 500) {
    return adminResponse({ error: "Enter a title up to 120 characters and a message up to 500 characters." }, 400);
  }
  try {
    const result = await createAnnouncement(auth.database, { title, body: message, url: body?.url, createdBy: auth.user.id });
    return adminResponse({ sent: true, pushConfigured: result.configured, delivered: result.delivered, notification: result.notification });
  } catch (error) {
    return adminResponse({ error: error.message || "Could not send this notification." }, 503);
  }
}
