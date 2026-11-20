const functions = require("firebase-functions/v1");
const { getAuth } = require("firebase-admin/auth");

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
