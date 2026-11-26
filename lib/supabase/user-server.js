import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { adminResponse } from "./admin-server";

const firebaseJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));

export async function authorizeAppUser(request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !publishableKey || !secretKey) return { error: adminResponse({ error: "User data service is not configured on the server." }, 503) };
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return { error: adminResponse({ error: "Sign in to continue." }, 401) };

  const database = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  let user = null;
  let profile = null;
  const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (firebaseProjectId) {
    try {
      const { payload } = await jwtVerify(token, firebaseJwks, {
        issuer: `https://securetoken.google.com/${firebaseProjectId}`,
        audience: firebaseProjectId,
      });
      if (payload.role !== "authenticated" || typeof payload.sub !== "string") throw new Error("Invalid Firebase identity");
      const result = await database.from("profiles").select("id, role, firebase_uid, email, phone, full_name").eq("firebase_uid", payload.sub).maybeSingle();
      if (result.error) return { error: adminResponse({ error: "Could not load your app profile." }, 503) };
      if (!result.data) return { error: adminResponse({ error: "Your account profile is not ready yet. Please refresh and try again." }, 403) };
      profile = result.data;
      user = { id: profile.id, firebase_uid: payload.sub, email: payload.email || profile.email, phone: payload.phone_number || profile.phone, email_verified: Boolean(payload.email_verified), phone_verified: Boolean(payload.phone_number) };
    } catch {
      // Supabase Auth remains supported while Firebase identities are linked.
    }
  }

  if (!user) {
    const authClient = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
    const result = await authClient.auth.getUser(token);
    if (result.error || !result.data?.user) return { error: adminResponse({ error: "Your session is invalid or expired." }, 401) };
    user = result.data.user;
    const profileResult = await database.from("profiles").select("id, role, firebase_uid, email, phone, full_name").eq("id", user.id).maybeSingle();
    if (profileResult.error) return { error: adminResponse({ error: "Could not load your app profile." }, 503) };
    profile = profileResult.data;
  }
  if (!profile) return { error: adminResponse({ error: "Your account profile is not ready yet." }, 403) };
  if (!(user.email_confirmed_at || user.phone_confirmed_at || user.email_verified || user.phone_verified)) {
    return { error: adminResponse({ error: "Verify your email or phone before continuing." }, 403) };
  }
  return { database, user, profile, profileId: profile.id };
}
