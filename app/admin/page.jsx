"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut as firebaseSignOut } from "firebase/auth";
import { createClient } from "../../lib/supabase/client";
import { getFirebaseAuth } from "../../lib/firebase/client";

const BUILT_IN_MUSIC = [
  { label: "Cloud Focus", url: "/audio/cloud-soft-focus.wav" },
  { label: "Evening Piano", url: "/audio/cloud-evening-piano.wav" },
  { label: "Classic Focus", url: "/audio/pyq-focus.wav" },
];

const emptyQuestion = { subject: "", year: new Date().getFullYear(), topic: "", prompt: "", options: ["", "", "", ""], correct_option: 0, explanation: "", question_number: "" };

function parseCsv(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[i + 1] === "\n") i += 1; row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error("CSV must include a header row and at least one question.");
  const headers = rows.shift().map((header) => header.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  const pick = (record, ...keys) => keys.map((key) => record[key]).find((value) => value !== undefined && value !== "") || "";
  return { questions: rows.map((values) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
    const options = Array.isArray(record.options) ? record.options : [pick(record,"option_a","a"),pick(record,"option_b","b"),pick(record,"option_c","c"),pick(record,"option_d","d")];
    const answer = pick(record,"correct_option","answer","correct_answer").toUpperCase();
    return { subject: pick(record,"subject"), year: Number(pick(record,"year")), topic: pick(record,"topic"), exam: pick(record,"exam"), prompt: pick(record,"prompt","question","question_text"), options, correct_option: /^[A-D]$/.test(answer) ? answer.charCodeAt(0) - 65 : Number(answer), explanation: pick(record,"explanation"), question_number: Number(pick(record,"question_number","number")) || null };
  }) };
}

function getImportQuestions(payload) {
  if (Array.isArray(payload?.sections)) return payload.sections.flatMap((section) => Array.isArray(section.questions) ? section.questions : []);
  return Array.isArray(payload?.questions) ? payload.questions : [];
}

function titleOf(question) {
  return question?.content?.en?.text || question?.prompt || "Question text is missing";
}

export default function AdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const [status, setStatus] = useState("checking");
  const [authError, setAuthError] = useState("");
  const [session, setSession] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [questionCount, setQuestionCount] = useState(0);
  const [page, setPage] = useState(0);
  const [questionPageSize, setQuestionPageSize] = useState(25);
  const [activeAdminSection, setActiveAdminSection] = useState("questions");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(emptyQuestion);
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceData, setSourceData] = useState(null);
  const [sourceError, setSourceError] = useState("");
  const [editingId, setEditingId] = useState("");
  const [filters, setFilters] = useState({ q: "", subject: "", year: "" });
  const [appliedFilters, setAppliedFilters] = useState({ q: "", subject: "", year: "" });
  const [musicSettings, setMusicSettings] = useState({ enabled: false, trackUrl: "", volume: 0.28 });
  const [musicBusy, setMusicBusy] = useState(false);
  const [homeNote, setHomeNote] = useState({ heading: "A note for you", subtitle: "Today is a new day!", text: "Every question that you practice brings you one step closer to your dream." });
  const [homeNoteBusy, setHomeNoteBusy] = useState(false);
  const [catalog, setCatalog] = useState({ subjects: [], years: [] });
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogDraft, setCatalogDraft] = useState({ subject: "", year: "" });
  const [users, setUsers] = useState([]);
  const [usersBusy, setUsersBusy] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [usersPage, setUsersPage] = useState(1);
  const [usersHasMore, setUsersHasMore] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [editingUser, setEditingUser] = useState(null);
  const [editingUserName, setEditingUserName] = useState("");
  const usesFirebaseAuth = Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);

  const request = useCallback(async (url, options = {}) => {
    let accessToken;
    if (usesFirebaseAuth) {
      const firebaseUser = getFirebaseAuth().currentUser;
      accessToken = firebaseUser ? await firebaseUser.getIdToken() : null;
    } else {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      accessToken = data.session?.access_token;
    }
    if (!accessToken) throw new Error("Sign in to continue.");
    const result = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...options.headers },
      cache: "no-store",
    });
    const payload = await result.json().catch(() => ({}));
    if (!result.ok) {
      const error = new Error(payload.error || "The request could not be completed.");
      error.status = result.status;
      throw error;
    }
    return payload;
  }, [supabase, usesFirebaseAuth]);

  const loadQuestions = useCallback(async (requestedPage = 0, checkAccess = false, filterSet = appliedFilters, perPage = questionPageSize) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(requestedPage), perPage: String(perPage) });
      Object.entries(filterSet).forEach(([key, value]) => { if (value) params.set(key, value); });
      const result = await request(`/api/admin/questions?${params}`);
      setQuestions(result.questions || []);
      setQuestionCount(result.count || 0);
      setPage(result.page || 0);
      if (checkAccess) setStatus("authorized");
      setAuthError("");
    } catch (error) {
      if (checkAccess || error.status === 401 || error.status === 403 || error.status === 503) {
        setStatus("blocked");
        setAuthError(error.message);
      } else setNotice(error.message);
    } finally { setLoading(false); }
  }, [request, appliedFilters, questionPageSize]);

  const navigateAdminSection = (sectionId) => {
    const section = document.getElementById(sectionId);
    if (!section) return;
    setActiveAdminSection(sectionId);
    window.history.replaceState(null, "", `#${sectionId}`);
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const loadCatalog = useCallback(async () => {
    setCatalogBusy(true);
    setCatalogError("");
    try { setCatalog(await request("/api/admin/catalog")); }
    catch (error) { setCatalogError(error.message); }
    finally { setCatalogBusy(false); }
  }, [request]);

  const loadHomeNote = useCallback(async () => {
    try { setHomeNote(await request("/api/admin/settings/home-note")); }
    catch (error) { setNotice(error.message); }
  }, [request]);

  const loadUsers = useCallback(async (requestedPage = usersPage, query = userSearch) => {
    setUsersBusy(true);
    setUsersError("");
    try {
      const params = new URLSearchParams({ page: String(requestedPage), perPage: "25" });
      if (query.trim()) params.set("q", query.trim());
      const result = await request(`/api/admin/users?${params}`);
      setUsers(result.users || []);
      setUsersPage(result.page || requestedPage);
      setUsersHasMore(Boolean(result.hasMore));
    } catch (error) { setUsers([]); setUsersError(error.message); }
    finally { setUsersBusy(false); }
  }, [request, usersPage, userSearch]);

  const saveCatalogItem = async (kind, value) => {
    const cleanValue = String(value || "").trim();
    if (!cleanValue) return setCatalogError(kind === "subject" ? "Enter a subject name." : "Enter a year.");
    setCatalogBusy(true); setCatalogError("");
    try {
      const result = await request("/api/admin/catalog", { method: "POST", body: JSON.stringify({ kind, value: cleanValue }) });
      setCatalog(result);
      setCatalogDraft((current) => ({ ...current, [kind]: "" }));
      setNotice(`${kind === "subject" ? "Subject" : "Year"} added to practice selection.`);
    } catch (error) { setCatalogError(error.message); }
    finally { setCatalogBusy(false); }
  };

  const setCatalogItemActive = async (kind, value, active) => {
    setCatalogBusy(true); setCatalogError("");
    try {
      const result = active
        ? await request("/api/admin/catalog", { method: "POST", body: JSON.stringify({ kind, value }) })
        : await request(`/api/admin/catalog?kind=${encodeURIComponent(kind)}&value=${encodeURIComponent(value)}`, { method: "DELETE" });
      setCatalog(result);
      setNotice(active ? `${value} restored to practice selection.` : `${value} removed from practice selection. Existing questions are preserved.`);
    } catch (error) { setCatalogError(error.message); }
    finally { setCatalogBusy(false); }
  };

  const saveUserName = async (event) => {
    event.preventDefault();
    if (!editingUser) return;
    setUsersBusy(true); setUsersError("");
    try {
      await request(`/api/admin/users?id=${encodeURIComponent(editingUser.id)}`, { method: "PATCH", body: JSON.stringify({ full_name: editingUserName }) });
      setEditingUser(null);
      setNotice("User profile updated.");
      await loadUsers(usersPage, userSearch);
    } catch (error) { setUsersError(error.message); }
    finally { setUsersBusy(false); }
  };

  const saveUserRole = async (user, role) => {
    if (!user || !["admin", "user"].includes(role) || role === user.role) return;
    const isCurrentAdmin = Boolean((session?.user?.email && session.user.email === user.email) || (session?.user?.phone && session.user.phone === user.phone));
    setUsersBusy(true); setUsersError("");
    try {
      await request(`/api/admin/users?id=${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ role }) });
      setNotice(`${user.fullName || user.email || user.phone || "Account"} is now ${role === "admin" ? "an admin" : "a user"}.`);
      if (isCurrentAdmin && role === "user") { window.location.assign("/"); return; }
      await loadUsers(usersPage, userSearch);
    } catch (error) { setUsersError(error.message); }
    finally { setUsersBusy(false); }
  };

  const saveHomeNote = async (event) => {
    event.preventDefault();
    setHomeNoteBusy(true);
    try {
      const saved = await request("/api/admin/settings/home-note", { method: "PUT", body: JSON.stringify(homeNote) });
      setHomeNote({ heading: saved.heading, subtitle: saved.subtitle, text: saved.text });
      setNotice("Home note saved and updated for app users.");
    } catch (error) { setNotice(error.message); }
    finally { setHomeNoteBusy(false); }
  };

  const removeUser = async (user) => {
    if (user.isAdmin) return setUsersError("Admin accounts are protected from deletion.");
    if (!window.confirm(`Permanently delete ${user.fullName || user.email || user.phone || "this user"} and their account data? This cannot be undone.`)) return;
    setUsersBusy(true); setUsersError("");
    try {
      await request(`/api/admin/users?id=${encodeURIComponent(user.id)}`, { method: "DELETE" });
      setNotice("User account deleted.");
      await loadUsers(usersPage, userSearch);
    } catch (error) { setUsersError(error.message); }
    finally { setUsersBusy(false); }
  };

  useEffect(() => {
    let active = true;
    if (usesFirebaseAuth) {
      const unsubscribe = onAuthStateChanged(getFirebaseAuth(), async (firebaseUser) => {
        if (!active) return;
        if (!firebaseUser) {
          setSession(null);
          setStatus("blocked");
          setAuthError("Sign in with an authorized admin account to manage questions.");
          return;
        }
        try {
          await firebaseUser.getIdToken();
          if (!active) return;
          setSession({ user: { email: firebaseUser.email, phone: firebaseUser.phoneNumber } });
          await loadQuestions(0, true);
          await loadCatalog();
          await loadHomeNote();
        } catch {
          if (active) {
            setStatus("blocked");
            setAuthError("Could not verify the current Firebase session. Please sign in again.");
          }
        }
      });
      return () => { active = false; unsubscribe(); };
    }
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (!data.session) {
        setStatus("blocked");
        setAuthError("Sign in with an authorized admin account to manage questions.");
      } else { loadQuestions(0, true); loadCatalog(); loadHomeNote(); }
    }).catch(() => {
      if (active) { setStatus("blocked"); setAuthError("Could not verify the current session. Please sign in again."); }
    });
    return () => { active = false; };
  }, [loadQuestions, loadCatalog, loadHomeNote, supabase, usesFirebaseAuth]);

  useEffect(() => { fetch("/api/settings/music", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).then((settings) => { if (settings) setMusicSettings(settings); }).catch(() => {}); }, []);

  const updateOption = (index, value) => setForm((current) => ({ ...current, options: current.options.map((option, position) => position === index ? value : option) }));

  const saveQuestion = async (event) => {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const question = { ...form, question_number: form.question_number ? Number(form.question_number) : null };
      const result = editingId
        ? await request(`/api/admin/questions?id=${encodeURIComponent(editingId)}`, { method: "PATCH", body: JSON.stringify({ question }) })
        : await request("/api/admin/questions", { method: "POST", body: JSON.stringify({ type: "single", question }) });
      setNotice(editingId ? "Question updated." : `Question saved. ${result.saved} record added.${result.skipped ? ` ${result.skipped} duplicate skipped.` : ""}`);
      setEditingId("");
      setForm({ ...emptyQuestion, year: new Date().getFullYear() });
      await loadQuestions(0, false, appliedFilters);
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  };

  const readQuestionFile = async (file) => {
    setSourceError("");
    setSourceFile(file || null);
    setSourceData(null);
    if (!file) return;
    if (!/\.(json|csv)$/i.test(file.name) || file.size > 8 * 1024 * 1024) {
      setSourceError("Choose a JSON or CSV file smaller than 8 MB.");
      return;
    }
    try {
      const text = await file.text();
      const parsed = file.name.toLowerCase().endsWith(".csv") ? parseCsv(text) : JSON.parse(text);
      const count = getImportQuestions(parsed).length;
      if (!count) throw new Error("No question sections were found in the selected JSON file.");
      if (count > 500) throw new Error("This import supports up to 500 questions at a time.");
      setSourceData(parsed);
    } catch (error) { setSourceError(error.message || "The selected file is not valid JSON or CSV."); }
  };

  const importQuestions = async () => {
    if (!sourceData) return;
    const total = getImportQuestions(sourceData).length;
    setBusy(true);
    setNotice("");
    try {
      const result = await request("/api/admin/questions", { method: "POST", body: JSON.stringify({ type: "bulk", source: sourceData }) });
      setNotice(`${result.saved} questions imported or updated from ${total} source records.${result.skipped ? ` ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped.` : ""}`);
      setSourceData(null);
      setSourceFile(null);
      await loadQuestions(0);
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  };

  const saveMusicSettings = async () => {
    setMusicBusy(true);
    try {
      const result = await request("/api/admin/settings/music", { method: "PUT", body: JSON.stringify(musicSettings) });
      setMusicSettings(result); setNotice("Music settings saved for the app.");
    } catch (error) { setNotice(error.message); }
    finally { setMusicBusy(false); }
  };

  const removeQuestion = async (question) => {
    if (!window.confirm(`Remove this question? If students have bookmarked or attempted it, removal will be blocked to protect their records.\n\n${question.prompt.slice(0, 180)}`)) return;
    setBusy(true);
    setNotice("");
    try {
      await request(`/api/admin/questions?id=${encodeURIComponent(question.id)}`, { method: "DELETE" });
      setNotice("Question removed.");
      await loadQuestions(questions.length === 1 && page > 0 ? page - 1 : page);
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  };

  const editQuestion = (question) => {
    setEditingId(question.id);
    setForm({ subject: question.subject, year: question.year, topic: question.topic, prompt: question.prompt, options: question.options || ["", "", "", ""], correct_option: question.correct_option, explanation: question.explanation || "", question_number: question.question_number || "" });
    document.getElementById("admin-question-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const restartAdminSignIn = async () => {
    if (session) {
      if (usesFirebaseAuth) {
        try { await firebaseSignOut(getFirebaseAuth()); }
        catch { setAuthError("Could not sign out this account. Please sign out in the app and try again."); return; }
      } else {
        const { error } = await supabase.auth.signOut();
        if (error) { setAuthError("Could not sign out this account. Please sign out in the app and try again."); return; }
      }
    }
    window.location.assign("/?screen=Welcome&next=%2Fadmin");
  };

  if (status === "checking") return <main className="admin-screen"><div className="admin-loading">Verifying admin access…</div></main>;
  if (status === "blocked") return <main className="admin-screen"><section className="admin-access-card"><a href="/" className="admin-brand">PYQ <span>CLOUD</span></a><div className="admin-lock">⚙</div><h1>Admin access required</h1><p>{authError}</p><p>Continue with an account on the server’s verified email or phone admin allowlist.</p><button className="admin-button primary" onClick={restartAdminSignIn}>{session ? "Switch account and sign in" : "Sign in as admin"}</button><small>After a successful admin sign-in, you’ll return to this panel.</small></section></main>;

  return <main className="admin-screen">
    <header className="admin-topbar"><a href="/" className="admin-brand">PYQ <span>CLOUD</span></a><div className="admin-topbar-actions"><span>{session?.user?.email || session?.user?.phone}</span><button className="admin-button secondary" onClick={() => window.location.assign("/")}>Back to app</button></div></header>
    <div className="admin-layout">
      <aside className="admin-sidebar" aria-label="Admin sections"><small>WORKSPACE</small>{[["questions", "Question bank"], ["catalog", "Subjects & years"], ["users", "User accounts"], ["home-note", "Home note"]].map(([sectionId, label]) => <button type="button" className={activeAdminSection === sectionId ? "active" : ""} key={sectionId} onClick={() => navigateAdminSection(sectionId)}>{label}</button>)}<span>Signed in as admin</span></aside>
      <section className="admin-content">
        <div className="admin-heading"><div><span className="admin-eyebrow">ADMINISTRATION</span><h1>Question bank</h1><p>Add questions manually or import a validated JSON question set into Supabase.</p></div><div className="admin-count"><strong>{questionCount.toLocaleString()}</strong><span>questions</span></div></div>
        {notice && <div className="admin-notice" role="status">{notice}<button aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}
        <div className="admin-work-grid">
          <section className="admin-card admin-import-card"><div className="admin-card-heading"><span className="admin-card-icon">⇧</span><div><h2>Import a question file</h2><p>Upload a validated JSON or CSV question set.</p></div></div>
            <label className="admin-file-picker">Choose a JSON or CSV file<input type="file" accept="application/json,.json,text/csv,.csv" onChange={(event) => readQuestionFile(event.target.files?.[0])} /></label>
            {sourceFile && <p className="admin-file-name">Selected: {sourceFile.name}</p>}
            {sourceError && <p className="admin-field-error" role="alert">{sourceError}</p>}
            {sourceData && <div className="admin-import-preview"><b>{getImportQuestions(sourceData).length} questions ready</b><span>Questions are validated before saving. Existing matching questions are skipped to avoid duplicates.</span><ul>{getImportQuestions(sourceData).slice(0, 3).map((question, index) => <li key={question.id || index}>{titleOf(question)}</li>)}</ul><button className="admin-button primary full" onClick={importQuestions} disabled={busy}>{busy ? "Importing…" : `Import ${getImportQuestions(sourceData).length} questions`}</button></div>}
          </section>

          <section className="admin-card" id="admin-question-form"><div className="admin-card-heading"><span className="admin-card-icon">{editingId ? "✎" : "＋"}</span><div><h2>{editingId ? "Edit question" : "Add a question"}</h2><p>Enter one four-option multiple-choice question.</p></div>{editingId && <button type="button" className="admin-button secondary" onClick={() => { setEditingId(""); setForm(emptyQuestion); }}>Cancel edit</button>}</div>
            <form className="admin-question-form" onSubmit={saveQuestion}>
              <div className="admin-form-row"><label>Subject<input value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} maxLength={120} required placeholder="e.g. Polity & Governance" /></label><label>Year<input type="number" value={form.year} onChange={(event) => setForm({ ...form, year: event.target.value })} min="1900" max="2100" required /></label></div>
              <div className="admin-form-row"><label>Topic<input value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} maxLength={200} required placeholder="e.g. Fundamental Rights" /></label><label>Question number<input type="number" value={form.question_number} onChange={(event) => setForm({ ...form, question_number: event.target.value })} min="1" max="32767" placeholder="Optional" /></label></div>
              <label>Question<textarea value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} maxLength={6000} required rows={3} placeholder="Enter the question" /></label>
              <fieldset className="admin-options"><legend>Answer options <span>Choose the correct answer</span></legend>{form.options.map((option, index) => <div className="admin-option-row" key={index}><input type="radio" name="correct-option" aria-label={`Mark option ${index + 1} correct`} checked={Number(form.correct_option) === index} onChange={() => setForm({ ...form, correct_option: index })} /><input aria-label={`Option ${index + 1}`} value={option} onChange={(event) => updateOption(index, event.target.value)} maxLength={1500} required placeholder={`Option ${String.fromCharCode(65 + index)}`} /></div>)}</fieldset>
              <label>Explanation<textarea value={form.explanation} onChange={(event) => setForm({ ...form, explanation: event.target.value })} maxLength={12000} rows={3} placeholder="Optional explanation" /></label>
              <button className="admin-button primary full" type="submit" disabled={busy}>{busy ? "Saving…" : editingId ? "Update question" : "Save question"}</button>
            </form>
          </section>
        </div>

        <section className="admin-card" id="home-note"><div className="admin-card-heading"><span className="admin-card-icon">✦</span><div><h2>Home screen note</h2><p>Change the note heading and message shown on every user’s home screen.</p></div></div><form className="admin-home-note-form" onSubmit={saveHomeNote}><label>Heading<input value={homeNote.heading} onChange={(event) => setHomeNote({ ...homeNote, heading: event.target.value })} maxLength={100} required /></label><label>Subheading<input value={homeNote.subtitle} onChange={(event) => setHomeNote({ ...homeNote, subtitle: event.target.value })} maxLength={160} /></label><label>Message<textarea value={homeNote.text} onChange={(event) => setHomeNote({ ...homeNote, text: event.target.value })} maxLength={500} rows={3} required /></label><button className="admin-button primary" type="submit" disabled={homeNoteBusy}>{homeNoteBusy ? "Saving…" : "Save home note"}</button></form></section>

        <section className="admin-card admin-music-card"><div className="admin-card-heading"><span className="admin-card-icon">♫</span><div><h2>Focus music</h2><p>Choose the audio played in the app and set its volume.</p></div></div><div className="admin-music-controls"><label className="admin-music-enabled"><input type="checkbox" checked={musicSettings.enabled} onChange={(event) => setMusicSettings({ ...musicSettings, enabled: event.target.checked })} />Enable background music</label><label>Built-in track<select value={BUILT_IN_MUSIC.some((track) => track.url === musicSettings.trackUrl) ? musicSettings.trackUrl : "custom"} onChange={(event) => { if (event.target.value !== "custom") setMusicSettings({ ...musicSettings, trackUrl: event.target.value }); }}><option value="/audio/cloud-soft-focus.wav">Cloud Focus</option><option value="/audio/cloud-evening-piano.wav">Evening Piano</option><option value="/audio/pyq-focus.wav">Classic Focus</option><option value="custom">Custom audio URL</option></select></label><label>Audio file URL<input value={musicSettings.trackUrl} onChange={(event) => setMusicSettings({ ...musicSettings, trackUrl: event.target.value })} placeholder="/audio/pyq-focus.wav or https://…" /></label><label>Volume <span>{Math.round(Number(musicSettings.volume) * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={musicSettings.volume} onChange={(event) => setMusicSettings({ ...musicSettings, volume: Number(event.target.value) })} /></label><button className="admin-button primary" onClick={saveMusicSettings} disabled={musicBusy}>{musicBusy ? "Saving…" : "Save music settings"}</button></div></section>

        <section className="admin-card admin-question-list" id="questions"><div className="admin-list-heading"><div><h2>Question sets</h2><p>Browse and edit every question stored in the production question bank.</p></div><button className="admin-button secondary" onClick={() => loadQuestions(page)} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
          <form className="admin-filters" onSubmit={(event) => { event.preventDefault(); setAppliedFilters(filters); loadQuestions(0, false, filters); }}><input aria-label="Search questions or topics" placeholder="Search question, topic or exam" value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} /><input aria-label="Filter by subject" placeholder="Subject" value={filters.subject} onChange={(event) => setFilters({ ...filters, subject: event.target.value })} /><input aria-label="Filter by year" placeholder="Year" inputMode="numeric" maxLength={4} value={filters.year} onChange={(event) => setFilters({ ...filters, year: event.target.value.replace(/\D/g, "").slice(0, 4) })} /><button className="admin-button primary" type="submit" disabled={loading}>Apply filters</button><button className="admin-button secondary" type="button" onClick={() => { const empty = { q: "", subject: "", year: "" }; setFilters(empty); setAppliedFilters(empty); loadQuestions(0, false, empty); }}>Clear</button></form>
          {questions.length ? <div className="admin-table-wrap"><table><thead><tr><th>Question / practice set</th><th>Subject</th><th>Year</th><th>Actions</th></tr></thead><tbody>{questions.map((question) => <tr key={question.id}><td><b>{question.question_number ? `#${question.question_number} ` : ""}{question.prompt}</b><small>{question.exam} · {question.topic}</small></td><td>{question.subject}</td><td>{question.year}</td><td><div className="admin-row-actions"><button className="admin-edit-button" disabled={busy} onClick={() => editQuestion(question)}>Edit</button><button className="admin-remove-button" disabled={busy} onClick={() => removeQuestion(question)}>Remove</button></div></td></tr>)}</tbody></table></div> : <div className="admin-empty">{loading ? "Loading questions…" : "No questions match these filters."}</div>}
          <div className="admin-pagination"><span>Showing {questionCount ? (page * questionPageSize) + 1 : 0}–{Math.min((page + 1) * questionPageSize, questionCount)} of {questionCount.toLocaleString()} questions</span><div className="admin-question-pagination-controls"><label>Per page<select aria-label="Questions per page" value={questionPageSize} disabled={loading} onChange={(event) => { const nextSize = Number(event.target.value); setQuestionPageSize(nextSize); loadQuestions(0, false, appliedFilters, nextSize); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="admin-button secondary" disabled={page === 0 || loading} onClick={() => loadQuestions(page - 1)}>Previous</button><button className="admin-button secondary" disabled={(page + 1) * questionPageSize >= questionCount || loading} onClick={() => loadQuestions(page + 1)}>Next</button></div></div>
        </section>

        <section className="admin-card" id="catalog"><div className="admin-list-heading"><div><h2>Practice subjects &amp; years</h2><p>Add or hide filters shown in Practice by Subject and Practice by Year. Removing an item preserves its questions.</p></div><button className="admin-button secondary" onClick={loadCatalog} disabled={catalogBusy}>{catalogBusy ? "Refreshing…" : "Refresh"}</button></div>
          {catalogError && <p className="admin-field-error" role="alert">{catalogError}</p>}
          <div className="admin-catalog-forms">
            <form onSubmit={(event) => { event.preventDefault(); saveCatalogItem("subject", catalogDraft.subject); }}><label>Add subject<input value={catalogDraft.subject} onChange={(event) => setCatalogDraft({ ...catalogDraft, subject: event.target.value })} maxLength={120} placeholder="e.g. Ethics" /></label><button className="admin-button primary" type="submit" disabled={catalogBusy}>Add subject</button></form>
            <form onSubmit={(event) => { event.preventDefault(); saveCatalogItem("year", catalogDraft.year); }}><label>Add year<input type="number" min="1900" max="2100" value={catalogDraft.year} onChange={(event) => setCatalogDraft({ ...catalogDraft, year: event.target.value })} placeholder="e.g. 2027" /></label><button className="admin-button primary" type="submit" disabled={catalogBusy}>Add year</button></form>
          </div>
          <div className="admin-catalog-grid">
            {[{ kind: "subject", title: "Subjects", rows: catalog.subjects || [] }, { kind: "year", title: "Years", rows: catalog.years || [] }].map((group) => <section className="admin-catalog-list" key={group.kind}><h3>{group.title} <span>{group.rows.filter((item) => item.active).length} active</span></h3>{group.rows.length ? group.rows.map((item) => <div className={`admin-catalog-row ${item.active ? "" : "inactive"}`} key={item.value}><span><b>{item.value}</b><small>{item.questionCount || 0} questions{item.active ? "" : " · hidden from practice"}</small></span><button className={item.active ? "admin-remove-button" : "admin-edit-button"} disabled={catalogBusy} onClick={() => setCatalogItemActive(group.kind, item.value, !item.active)}>{item.active ? "Remove" : "Restore"}</button></div>) : <div className="admin-empty">{catalogBusy ? "Loading catalogue…" : "No items found."}</div>}</section>)}
          </div>
        </section>

        <section className="admin-card" id="users"><div className="admin-list-heading"><div><h2>User accounts</h2><p>Review account contact details and change any account between user and admin.</p></div><button className="admin-button secondary" onClick={() => loadUsers(1)} disabled={usersBusy}>{usersBusy ? "Loading…" : "Load users"}</button></div>
          {usersError && <p className="admin-field-error" role="alert">{usersError}</p>}
          <form className="admin-user-search" onSubmit={(event) => { event.preventDefault(); loadUsers(1, userSearch); }}><input aria-label="Search users" placeholder="Search name, email or phone" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} /><button className="admin-button primary" type="submit" disabled={usersBusy}>Search</button></form>
          {editingUser && <form className="admin-user-edit" onSubmit={saveUserName}><div><b>Edit profile</b><small>{editingUser.email || editingUser.phone}</small></div><label>Full name<input value={editingUserName} onChange={(event) => setEditingUserName(event.target.value)} maxLength={80} required /></label><button className="admin-button primary" type="submit" disabled={usersBusy}>{usersBusy ? "Saving…" : "Save profile"}</button><button className="admin-button secondary" type="button" onClick={() => setEditingUser(null)}>Cancel</button></form>}
          {users.length ? <div className="admin-table-wrap"><table className="admin-users-table"><thead><tr><th>User</th><th>Email</th><th>Mobile number</th><th>Role</th><th>Joined</th><th>Actions</th></tr></thead><tbody>{users.map((user) => { const isCurrentAdmin = Boolean((session?.user?.email && session.user.email === user.email) || (session?.user?.phone && session.user.phone === user.phone)); return <tr key={user.id}><td><b>{user.fullName || "Name not provided"}</b></td><td>{user.email || "—"}</td><td>{user.phone || "—"}</td><td><select className="admin-role-select" aria-label={`Role for ${user.fullName || user.email || user.phone || "user"}`} value={user.role} disabled={usersBusy} onChange={(event) => saveUserRole(user, event.target.value)}><option value="user">User</option><option value="admin">Admin</option></select>{isCurrentAdmin && user.role === "admin" && <small>Changing yourself to User will exit this panel</small>}</td><td>{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</td><td><div className="admin-row-actions"><button className="admin-edit-button" disabled={usersBusy} onClick={() => { setEditingUser(user); setEditingUserName(user.fullName || ""); }}>Edit name</button><button className="admin-remove-button" disabled={usersBusy || user.isAdmin} onClick={() => removeUser(user)}>Delete</button></div></td></tr>; })}</tbody></table></div> : <div className="admin-empty">{usersBusy ? "Loading users…" : usersError ? "User list unavailable." : "Load users to see registered profiles."}</div>}
          {(users.length > 0 || usersPage > 1) && <div className="admin-pagination"><span>Page {usersPage}</span><div><button className="admin-button secondary" disabled={usersPage <= 1 || usersBusy} onClick={() => loadUsers(usersPage - 1)}>Previous</button><button className="admin-button secondary" disabled={!usersHasMore || usersBusy} onClick={() => loadUsers(usersPage + 1)}>Next</button></div></div>}
        </section>
    <footer className="admin-footer">Question content is saved to the configured Supabase project. Admin actions require server-verified access.</footer>
      </section>
    </div>
  </main>;
}
