import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const firebaseJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function getReporter(request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!url || !publishableKey || !secretKey) return { error: response({ error: "Question reports are temporarily unavailable." }, 503) };
  if (!token) return { error: response({ error: "Sign in to report a question." }, 401) };

  const database = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (firebaseProjectId) {
    try {
      const { payload } = await jwtVerify(token, firebaseJwks, {
        issuer: `https://securetoken.google.com/${firebaseProjectId}`,
        audience: firebaseProjectId,
      });
      if (payload.role !== "authenticated" || typeof payload.sub !== "string") throw new Error("Invalid Firebase token.");
      const { data: profile, error } = await database.from("profiles").select("id").eq("firebase_uid", payload.sub).maybeSingle();
      if (error) return { error: response({ error: "Could not verify your account profile." }, 503) };
      if (!profile) return { error: response({ error: "Your account profile is still syncing. Try again shortly." }, 409) };
      return { database, reporterId: profile.id };
    } catch {
      // Continue with the existing Supabase Auth session when the token is not Firebase-issued.
    }
  }

  const authClient = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) return { error: response({ error: "Your session has expired. Sign in and try again." }, 401) };
  const { data: profile, error: profileError } = await database.from("profiles").select("id").eq("id", data.user.id).maybeSingle();
  if (profileError) return { error: response({ error: "Could not verify your account profile." }, 503) };
  if (!profile) return { error: response({ error: "Your account profile is still syncing. Try again shortly." }, 409) };
  return { database, reporterId: profile.id };
}

export async function POST(request) {
  const auth = await getReporter(request);
  if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch { return response({ error: "Provide a valid report." }, 400); }
  const questionId = String(body?.questionId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(questionId)) {
    return response({ error: "This question cannot be reported because it is not linked to the question bank." }, 400);
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : "Reported during practice";
  const id = createHash("sha256").update(`${questionId}:${auth.reporterId}`).digest("hex");
  const key = `question-report:${id}`;
  const { data: existing, error: lookupError } = await auth.database.from("app_settings").select("key").eq("key", key).maybeSingle();
  if (lookupError) return response({ error: "Could not check whether this question was already reported." }, 503);
  if (existing) return response({ reported: true, alreadyReported: true });

  const now = new Date().toISOString();
  const report = {
    question_id: questionId,
    reporter_id: auth.reporterId,
    reason: reason || "Reported during practice",
    status: "open",
    reviewed_by: null,
    reviewed_at: null,
    created_at: now,
    updated_at: now,
  };
  const { error } = await auth.database.from("app_settings").insert({ key, value: report, updated_at: now });
  if (error?.code === "23505" || error?.code === "409") return response({ reported: true, alreadyReported: true });
  if (error) {
    console.error("Question report could not be saved", { code: error.code });
    return response({ error: "Could not save this report. Please try again." }, 500);
  }
  return response({ reported: true, id }, 201);
}
