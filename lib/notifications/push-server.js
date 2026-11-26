import webpush from "web-push";

let configured = false;

function configurePush() {
  const publicKey = process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_KEY;
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  if (!configured) {
    webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT || "mailto:support@pyqcloud.in", publicKey, privateKey);
    configured = true;
  }
  return true;
}

export async function createAnnouncement(database, { title, body, url = "/", createdBy = null }) {
  const targetUrl = typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url.slice(0, 300) : "/";
  const { data: notification, error } = await database.from("notifications")
    .insert({ title: title.trim().slice(0, 120), body: body.trim().slice(0, 500), target_url: targetUrl, created_by: createdBy })
    .select("id, title, body, target_url, created_at").single();
  if (error) throw new Error("Could not save the notification. Apply the push notification database migration first.");

  if (!configurePush()) return { notification, delivered: 0, configured: false };
  const { data: subscriptions, error: subscriptionsError } = await database.from("push_subscriptions").select("id, endpoint, keys");
  if (subscriptionsError) return { notification, delivered: 0, configured: true, deliveryError: true };
  const payload = JSON.stringify({ title: notification.title, body: notification.body, url: notification.target_url, id: notification.id });
  let delivered = 0;
  await Promise.all((subscriptions || []).map(async (subscription) => {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, { TTL: 60 * 60 * 24, urgency: "normal" });
      delivered += 1;
    } catch (error) {
      if ([404, 410].includes(error?.statusCode)) await database.from("push_subscriptions").delete().eq("id", subscription.id);
    }
  }));
  return { notification, delivered, configured: true };
}
