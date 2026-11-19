import { createBrowserClient } from "@supabase/ssr";
import { getFirebaseAuth } from "../firebase/client";

let client;

export function createClient() {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (!url || !key) {
      throw new Error("Supabase is not configured. Check the public Supabase environment variables.");
    }

    const options = process.env.NEXT_PUBLIC_FIREBASE_API_KEY
      ? {
          accessToken: async () => {
            const firebaseUser = getFirebaseAuth().currentUser;
            return firebaseUser ? firebaseUser.getIdToken() : null;
          },
        }
      : undefined;
    client = createBrowserClient(url, key, options);
  }

  return client;
}
