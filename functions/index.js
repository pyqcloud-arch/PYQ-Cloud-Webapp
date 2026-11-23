const functions = require("firebase-functions/v1");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

initializeApp();

const supabaseSecret = defineSecret("SUPABASE_SECRET_KEY");
const supabaseUrl = "https://nhjvfifbxehnewnlyxgw.supabase.co";

// Supabase reads the Firebase JWT's role claim to select the authenticated
// Postgres role. Keep this separate from the app's profiles.role admin flag.
exports.setSupabaseAuthenticatedRole = functions.auth.user().onCreate(async (user) => {
  const existingClaims = user.customClaims || {};
  if (existingClaims.role === "authenticated") return;

  await getAuth().setCustomUserClaims(user.uid, {
    ...existingClaims,
    role: "authenticated",
  });
});

// Existing Firebase accounts do not receive the onCreate claim. Let a signed-in
// user request the Supabase role for their own Firebase identity before profile
// sync. This never grants the app's separate profiles.role admin permission.
exports.ensureSupabaseAuthenticatedRole = functions.region("us-central1").https.onCall(async (_data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in before connecting your account.");
  }

  const auth = getAuth();
  const user = await auth.getUser(context.auth.uid);
  const existingClaims = user.customClaims || {};
  if (existingClaims.role !== "authenticated") {
    await auth.setCustomUserClaims(user.uid, {
      ...existingClaims,
      role: "authenticated",
    });
  }

  return { role: "authenticated" };
});

exports.adminDeleteFirebaseUser = onCall({
  region: "us-central1",
  secrets: [supabaseSecret],
  // Use the same Firebase Auth service account as the existing Gen 1 auth functions.
  serviceAccount: "pyq-cloud@appspot.gserviceaccount.com",
}, async (request) => {
  const callerUid = request.auth?.uid;
  const targetProfileId = request.data?.profileId;
  if (!callerUid) throw new HttpsError("unauthenticated", "Sign in before deleting an account.");
  if (typeof targetProfileId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetProfileId)) {
    throw new HttpsError("invalid-argument", "Choose a valid user profile.");
  }

  const serviceKey = supabaseSecret.value();
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const query = async (path, options = {}) => {
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { ...headers, ...options.headers }, cache: "no-store" });
    if (!response.ok) throw new HttpsError("internal", "Could not verify or remove the user profile.");
    return response.status === 204 ? [] : response.json();
  };

  let callerProfiles;
  let targetProfiles;
  try {
    [callerProfiles, targetProfiles] = await Promise.all([
      query(`profiles?firebase_uid=eq.${encodeURIComponent(callerUid)}&role=eq.admin&select=id,role&limit=1`),
      query(`profiles?id=eq.${encodeURIComponent(targetProfileId)}&select=id,role,firebase_uid&limit=1`),
    ]);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("unavailable", "Could not reach the account database.");
  }
  if (!callerProfiles.length) throw new HttpsError("permission-denied", "Only an admin can delete accounts.");
  const target = targetProfiles[0];
  if (!target) throw new HttpsError("not-found", "This user profile was not found.");
  if (target.id === callerProfiles[0].id) throw new HttpsError("failed-precondition", "You cannot delete the admin account currently signed in.");
  if (target.role === "admin") throw new HttpsError("permission-denied", "Change this account to User before deleting it.");
  if (!target.firebase_uid) throw new HttpsError("failed-precondition", "This profile does not have a Firebase account linked.");

  try { await getAuth().deleteUser(target.firebase_uid); }
  catch (error) {
    if (error?.code !== "auth/user-not-found") {
      console.error("adminDeleteFirebaseUser Firebase Auth delete failed", {
        code: error?.code || "unknown",
        message: String(error?.message || "").slice(0, 240),
      });
      throw new HttpsError("internal", "Firebase could not delete this account.");
    }
  }
  try {
    const deleted = await query(`profiles?id=eq.${encodeURIComponent(targetProfileId)}`, {
      method: "DELETE",
      headers: { Prefer: "return=representation" },
    });
    if (!deleted.length) throw new HttpsError("internal", "The account was removed from Firebase, but its app data could not be confirmed as deleted.");
  } catch (error) {
    console.error("adminDeleteFirebaseUser Supabase profile cleanup failed", {
      code: error?.code || "unknown",
      message: String(error?.message || "").slice(0, 240),
    });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "The account was removed from Firebase, but its app data could not be confirmed as deleted.");
  }
  return { deleted: true };
});
