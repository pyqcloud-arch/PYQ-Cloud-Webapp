import { adminResponse } from "../../../lib/supabase/admin-server";
import { authorizeAppUser } from "../../../lib/supabase/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await authorizeAppUser(request);
  if (auth.error) return auth.error;
  const { data, error } = await auth.database.from("notifications")
    .select("id, title, body, target_url, created_at")
    .order("created_at", { ascending: false }).limit(30);
  if (error) return adminResponse({ error: "Could not load notifications." }, 500);
  const notifications = data || [];
  const ids = notifications.map((item) => item.id);
  const readsResult = ids.length
    ? await auth.database.from("notification_reads").select("notification_id").eq("user_id", auth.profileId).in("notification_id", ids)
    : { data: [], error: null };
  if (readsResult.error) return adminResponse({ error: "Could not load notification status." }, 500);
  const readIds = new Set((readsResult.data || []).map((row) => row.notification_id));
  return adminResponse({ notifications: notifications.map((item) => ({ ...item, read: readIds.has(item.id) })), unread: notifications.filter((item) => !readIds.has(item.id)).length });
}

export async function POST(request) {
  const auth = await authorizeAppUser(request);
  if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch { return adminResponse({ error: "Provide valid JSON." }, 400); }

  if (body?.action === "subscribe") {
    const endpoint = body?.subscription?.endpoint;
    const keys = body?.subscription?.keys;
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || endpoint.length > 4096 || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") {
      return adminResponse({ error: "The browser returned an invalid push subscription." }, 400);
    }
    const { error } = await auth.database.from("push_subscriptions").upsert({
      user_id: auth.profileId,
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      user_agent: request.headers.get("user-agent")?.slice(0, 500) || "",
      updated_at: new Date().toISOString(),
    }, { onConflict: "endpoint" });
    if (error) return adminResponse({ error: "Could not save this browser’s notification subscription. Apply the push notification database migration first." }, 503);
    return adminResponse({ subscribed: true });
  }

  if (body?.action === "unsubscribe") {
    const endpoint = body?.endpoint;
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return adminResponse({ error: "Choose a valid notification subscription." }, 400);
    const { error } = await auth.database.from("push_subscriptions").delete().eq("user_id", auth.profileId).eq("endpoint", endpoint);
    if (error) return adminResponse({ error: "Could not remove this notification subscription." }, 500);
    return adminResponse({ subscribed: false });
  }

  if (body?.action === "mark-read") {
    const { data, error } = await auth.database.from("notifications").select("id").order("created_at", { ascending: false }).limit(30);
    if (error) return adminResponse({ error: "Could not update notification status." }, 500);
    const rows = (data || []).map((item) => ({ notification_id: item.id, user_id: auth.profileId, read_at: new Date().toISOString() }));
    if (rows.length) {
      const result = await auth.database.from("notification_reads").upsert(rows, { onConflict: "notification_id,user_id" });
      if (result.error) return adminResponse({ error: "Could not update notification status." }, 500);
    }
    return adminResponse({ read: true });
  }

  return adminResponse({ error: "Unknown notification action." }, 400);
}
