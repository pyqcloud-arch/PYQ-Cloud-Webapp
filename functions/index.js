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
