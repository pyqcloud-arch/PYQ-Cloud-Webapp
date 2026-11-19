import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

const firebaseJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));

export const adminResponse = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function authorizeAdmin(request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !publishableKey || !secretKey) {
    return { error: adminResponse({ error: "Admin management needs Supabase server credentials." }, 503) };
  }

  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return { error: adminResponse({ error: "Sign in to continue." }, 401) };
  const database = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  let user;
  let profileQuery;
  const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (firebaseProjectId) {
    try {
      const { payload } = await jwtVerify(token, firebaseJwks, {
        issuer: `https://securetoken.google.com/${firebaseProjectId}`,
        audience: firebaseProjectId,
      });
      if (payload.role !== "authenticated" || typeof payload.sub !== "string") throw new Error("Firebase role claim is missing.");
      const { data: firebaseProfile, error: firebaseProfileError } = await database.from("profiles")
        .select("id, role, email, phone, full_name")
        .eq("firebase_uid", payload.sub)
        .maybeSingle();
      if (firebaseProfileError) return { error: adminResponse({ error: "Could not verify this Firebase account's app role." }, 503) };
      if (!firebaseProfile) return { error: adminResponse({ error: "This Firebase account has not been linked to an app profile yet." }, 403) };
      profileQuery = { data: firebaseProfile, error: null };
      user = {
        id: firebaseProfile.id,
        firebase_uid: payload.sub,
        email: typeof payload.email === "string" ? payload.email : firebaseProfile.email,
        phone: typeof payload.phone_number === "string" ? payload.phone_number : firebaseProfile.phone,
        email_confirmed_at: payload.email_verified ? "verified" : null,
        phone_confirmed_at: payload.phone_number ? "verified" : null,
      };
    } catch {
      // Supabase Auth sessions are still accepted while Firebase accounts roll out.
    }
  }
  if (!user) {
    const authClient = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data?.user) return { error: adminResponse({ error: "Your session is invalid or expired." }, 401) };
    user = data.user;
    profileQuery = await database.from("profiles").select("role").eq("id", user.id).maybeSingle();
  }
  if (!user.email_confirmed_at && !user.phone_confirmed_at) {
    return { error: adminResponse({ error: "Verify your email or phone before using the admin panel." }, 403) };
  }
  const { data: profile, error: profileError } = profileQuery;
  if (profileError) return { error: adminResponse({ error: "Could not verify this account’s Supabase role. Apply the profile role migration first." }, 503) };
  if (profile?.role !== "admin") return { error: adminResponse({ error: "This account does not have the admin role." }, 403) };
  return {
    database,
    user,
    role: profile.role,
    adminEmail: user.email || user.phone || user.id,
  };
}
