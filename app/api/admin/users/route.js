import { adminResponse, authorizeAdmin } from "../../../../lib/supabase/admin-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cleanName = (value) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "";

export async function GET(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
  const perPage = Math.max(1, Math.min(100, Number.parseInt(searchParams.get("perPage") || "25", 10) || 25));
  try {
    const search = (searchParams.get("q") || "").trim().toLowerCase();
    let profiles = [];
    let total = 0;
    if (!search) {
      const { data, error, count } = await auth.database.from("profiles")
        .select("id, email, phone, full_name, user_metadata, role, created_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .range((page - 1) * perPage, page * perPage - 1);
      if (error) return adminResponse({ error: "Could not load user profiles." }, 500);
      profiles = data || [];
      total = count || 0;
    } else {
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await auth.database.from("profiles")
          .select("id, email, phone, full_name, user_metadata, role, created_at")
          .order("created_at", { ascending: false })
          .range(offset, offset + 499);
        if (error) return adminResponse({ error: "Could not search user profiles." }, 500);
        const batch = data || [];
        profiles.push(...batch);
        if (batch.length < 500) break;
      }
      profiles = profiles.filter((profile) => `${profile.full_name || profile.user_metadata?.full_name || profile.user_metadata?.name || ""} ${profile.email || ""} ${profile.phone || ""}`.toLowerCase().includes(search));
      total = profiles.length;
      profiles = profiles.slice((page - 1) * perPage, page * perPage);
    }
    const rows = profiles.map((profile) => ({
      id: profile.id,
      email: profile.email || "",
      phone: profile.phone || "",
      fullName: profile.full_name || profile.user_metadata?.full_name || profile.user_metadata?.name || "",
      role: profile.role === "admin" ? "admin" : "user",
      createdAt: profile.created_at || null,
      isAdmin: profile.role === "admin",
    }));
    return adminResponse({ users: rows, page, perPage, total, hasMore: page * perPage < total });
  } catch { return adminResponse({ error: "Could not load registered accounts." }, 500); }
}

export async function PATCH(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!uuidPattern.test(id)) return adminResponse({ error: "Choose a valid user profile." }, 400);
  let body;
  try { body = await request.json(); } catch { return adminResponse({ error: "Provide valid JSON." }, 400); }
  const fullName = body?.full_name === undefined ? undefined : cleanName(body.full_name);
  const role = body?.role;
  if (fullName !== undefined && !fullName) return adminResponse({ error: "A user's name cannot be empty." }, 400);
  if (role !== undefined && !["admin", "user"].includes(role)) return adminResponse({ error: "Choose either the admin or user role." }, 400);
  if (fullName === undefined && role === undefined) return adminResponse({ error: "Choose a profile change to save." }, 400);
  const { data: target, error: targetError } = await auth.database.from("profiles").select("id, role, email").eq("id", id).maybeSingle();
  if (targetError) return adminResponse({ error: "Could not verify this profile." }, 500);
  if (!target) return adminResponse({ error: "This user profile was not found." }, 404);
  if (target.role === "admin" && role === "user") {
    const { count, error } = await auth.database.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
    if (error) return adminResponse({ error: "Could not verify the remaining admin accounts." }, 500);
    if ((count || 0) <= 1) return adminResponse({ error: "Keep at least one admin account." }, 409);
  }
  const updates = { updated_at: new Date().toISOString() };
  if (fullName !== undefined) updates.full_name = fullName;
  if (role !== undefined) updates.role = role;
  const { error: profileError } = await auth.database.from("profiles").update(updates).eq("id", id);
  if (profileError) return adminResponse({ error: "Could not update the Supabase profile." }, 500);
  if (fullName !== undefined) {
    const { data: found } = await auth.database.auth.admin.getUserById(id);
    if (found?.user) {
      const { error } = await auth.database.auth.admin.updateUserById(id, {
        user_metadata: { ...(found.user.user_metadata || {}), full_name: fullName },
      });
      if (error) return adminResponse({ error: "The profile was updated, but auth name sync failed." }, 500);
    }
  }
  return adminResponse({ updated: true, user: { id, ...(fullName !== undefined ? { fullName } : {}), ...(role !== undefined ? { role } : {}) } });
}

export async function DELETE(request) {
  const auth = await authorizeAdmin(request);
  if (auth.error) return auth.error;
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!uuidPattern.test(id)) return adminResponse({ error: "Choose a valid user profile." }, 400);
  if (id === auth.user.id) return adminResponse({ error: "You cannot delete the admin account currently signed in." }, 400);
  const { data: found, error: findError } = await auth.database.auth.admin.getUserById(id);
  if (findError || !found?.user) return adminResponse({ error: "This user account was not found." }, 404);
  const { data: targetProfile, error: profileError } = await auth.database.from("profiles").select("role").eq("id", id).maybeSingle();
  if (profileError) return adminResponse({ error: "Could not verify this account’s Supabase role." }, 500);
  if (targetProfile?.role === "admin") return adminResponse({ error: "Admin accounts are protected from deletion in this panel." }, 403);
  const { error } = await auth.database.auth.admin.deleteUser(id);
  if (error) return adminResponse({ error: "Could not delete this user account." }, 500);
  console.info("Admin deleted a user account", { admin: auth.user.email || auth.user.phone, userId: id });
  return adminResponse({ deleted: true });
}
