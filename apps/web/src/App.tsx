import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, BookOpen, CheckCircle2, Copy, Database, Headphones, Library, LockKeyhole, LogOut, RefreshCw, Search, Settings, Sparkles, Unplug, X } from "lucide-react";
import type { BookWork } from "@aiobooks/core";

interface SearchResponse { items: BookWork[]; total: number; offset: number }
interface CurrentUser { id: string; email: string; displayName: string; role: "ADMIN" | "USER" }
interface Profile { id: string; name: string; mediaType: "AUDIOBOOK" | "EBOOK"; config: { languages: string[]; formatOrder: string[] } }
interface LibraryItem { id: string; name: string; kind: string }
interface RankedResult { id: string; release: { id: string; rawTitle: string; format: string; languages: string[]; sizeBytes?: number; downloadProtocol: string }; match: { confidence: number; reasons: string[]; rejections: string[] }; score: number; scoreReasons?: string[] }
interface RequestResult { requestId: string; state: string; releases: RankedResult[]; diagnostics?: Array<{ providerId: string; outcome: string; durationMs: number; releaseCount: number }> }
interface PageTurnerStatus { enabled: boolean; profileId?: string; profileName?: string; lastUsedAt?: string | null; sourceUrls?: { directDownload: string; torrent: string; stream: string } }

async function searchBooks(query: string): Promise<SearchResponse> {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=24`);
  if (!response.ok) throw new Error("Book search is temporarily unavailable.");
  return response.json() as Promise<SearchResponse>;
}

async function currentUser(): Promise<CurrentUser | null> {
  const response = await fetch("/api/auth/me");
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Unable to verify the current session.");
  return (await response.json() as { user: CurrentUser }).user;
}

function csrfToken(): string {
  return document.cookie.split("; ").find((item) => item.startsWith("aiobooks_csrf="))?.split("=").slice(1).join("=") ?? "";
}

async function apiItems<T>(path: string): Promise<T[]> {
  const response = await fetch(path);
  if (!response.ok) throw new Error("Unable to load request settings.");
  return (await response.json() as { items: T[] }).items;
}

function Login() {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      if (!response.ok) throw new Error("Email or password is incorrect.");
      return response.json();
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: ["current-user"] }),
  });
  return <main className="login-page"><section className="login-card"><div className="brand-mark"><BookOpen size={22} /></div><span className="eyebrow">Private self-hosted library</span><h1>Welcome to AIOBooks.</h1><p>Sign in to discover and request books from your configured sources.</p><form onSubmit={(event) => { event.preventDefault(); login.mutate(); }}><label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{login.isError && <div className="login-error">{login.error.message}</div>}<button type="submit" disabled={login.isPending}><LockKeyhole size={17} />{login.isPending ? "Signing in…" : "Sign in"}</button></form></section></main>;
}

const nav = [
  ["Discover", Sparkles], ["Requests", BookOpen], ["Wanted", Search], ["Activity", Activity], ["Settings", Settings],
] as const;

export function App() {
  const client = useQueryClient();
  const session = useQuery({ queryKey: ["current-user"], queryFn: currentUser, retry: false });
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [selectedBook, setSelectedBook] = useState<BookWork | null>(null);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [selectedLibrary, setSelectedLibrary] = useState("");
  const [activeNav, setActiveNav] = useState<(typeof nav)[number][0]>("Discover");
  const [pageTurnerType, setPageTurnerType] = useState<"directDownload" | "torrent" | "stream">("directDownload");
  const result = useQuery({ queryKey: ["books", query], queryFn: () => searchBooks(query), enabled: Boolean(session.data) && query.length >= 2 });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => apiItems<Profile>("/api/profiles"), enabled: Boolean(session.data) });
  const libraries = useQuery({ queryKey: ["libraries"], queryFn: () => apiItems<LibraryItem>("/api/libraries"), enabled: Boolean(session.data) });
  const pageTurner = useQuery({ queryKey: ["pageturner"], queryFn: async () => { const response = await fetch("/api/integrations/pageturner"); if (!response.ok) throw new Error("Unable to load PageTurner integration."); return response.json() as Promise<PageTurnerStatus>; }, enabled: Boolean(session.data) });
  const regeneratePageTurner = useMutation({ mutationFn: async () => { const response = await fetch("/api/integrations/pageturner/token", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrfToken() }, body: "{}" }); const body = await response.json(); if (!response.ok) throw new Error(body.error === "AUDIOBOOK_PROFILE_REQUIRED" ? "Create an audiobook profile before enabling PageTurner." : "Unable to generate the PageTurner source."); return body as PageTurnerStatus; }, onSuccess: (data) => client.setQueryData(["pageturner"], data) });
  const revokePageTurner = useMutation({ mutationFn: async () => { const response = await fetch("/api/integrations/pageturner/token", { method: "DELETE", headers: { "x-csrf-token": csrfToken() } }); if (!response.ok) throw new Error("Unable to revoke the PageTurner token."); return response.json() as Promise<PageTurnerStatus>; }, onSuccess: (data) => client.setQueryData(["pageturner"], data) });
  const createRequest = useMutation({
    mutationFn: async (): Promise<RequestResult> => {
      if (!selectedBook) throw new Error("No book selected.");
      const response = await fetch(`/api/books/${selectedBook.id}/request`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrfToken() }, body: JSON.stringify({ profileId: selectedProfile, libraryId: selectedLibrary, automatic: true }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error === "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" ? "Credential encryption must be configured before requesting." : "The request could not be created.");
      return body as RequestResult;
    },
  });
  const selectRelease = useMutation({
    mutationFn: async (releaseId: string) => {
      if (!createRequest.data) throw new Error("No active request.");
      const response = await fetch(`/api/requests/${createRequest.data.requestId}/releases/${releaseId}/select`, { method: "POST", headers: { "x-csrf-token": csrfToken() } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error === "NO_DOWNLOAD_CLIENT_AVAILABLE" ? "No accessible TorBox connection is configured." : "The release could not be queued.");
      return body as { state: string };
    },
  });
  const logout = useMutation({ mutationFn: async () => { await fetch("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": csrfToken() } }); }, onSettled: () => { client.clear(); window.location.reload(); } });
  const submit = (event: FormEvent) => { event.preventDefault(); setQuery(input.trim()); };

  if (session.isLoading) return <main className="login-page"><div className="status">Opening your library…</div></main>;
  if (!session.data) return <Login />;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><BookOpen size={22} /></div><span>AIOBooks</span></div>
      <nav aria-label="Primary navigation">
        {nav.map(([label, Icon]) => <button className={activeNav === label ? "nav-item active" : "nav-item"} key={label} onClick={() => setActiveNav(label)}><Icon size={18} /><span>{label}</span></button>)}
      </nav>
      <button className="sidebar-foot logout" onClick={() => logout.mutate()}><LogOut size={17} /><span>Sign out</span></button>
    </aside>

    <main>
      <header><div><span className="eyebrow">Metadata-first discovery</span><h1>Find your next great listen.</h1><p>Search real books and editions. Sources are only queried after you choose what you want.</p></div><div className="avatar" aria-label={`Signed in as ${session.data.displayName}`}>{session.data.displayName.slice(0, 1).toLocaleUpperCase()}</div></header>
      {activeNav === "Settings" && <section className="integration-settings"><div className="section-title"><div><span className="eyebrow">Settings · Integrations</span><h2>PageTurner</h2><p>Expose your ranked AIOBooks results as a private PageTurner Download Source.</p></div><span className={`integration-status ${pageTurner.data?.enabled ? "enabled" : ""}`}>{pageTurner.data?.enabled ? "Enabled" : "Disabled"}</span></div><div className="integration-card">{pageTurner.isLoading ? <div className="status">Loading integration…</div> : <><label>Source type<select value={pageTurnerType} onChange={(event) => setPageTurnerType(event.target.value as typeof pageTurnerType)}><option value="directDownload">Direct download</option><option value="torrent">Torrent / magnet</option><option value="stream">Stream</option></select></label><label>Personal PageTurner source URL<div className="copy-field"><input readOnly value={pageTurner.data?.sourceUrls?.[pageTurnerType] ?? "Generate a token to create your source URL"} /><button disabled={!pageTurner.data?.sourceUrls?.[pageTurnerType]} onClick={() => void navigator.clipboard.writeText(pageTurner.data!.sourceUrls![pageTurnerType])}><Copy size={16} />Copy URL</button></div></label><p className="setup-copy">In PageTurner, open Settings → Download Sources → Add → From URL, then paste this URL. Direct results may need time to become ready; torrent results require PageTurner's configured debrid service.</p><div className="integration-actions"><button className="primary-action" disabled={regeneratePageTurner.isPending} onClick={() => regeneratePageTurner.mutate()}><RefreshCw size={16} />{pageTurner.data?.enabled ? "Regenerate token" : "Generate token"}</button>{pageTurner.data?.enabled && <button className="secondary-action" disabled={revokePageTurner.isPending} onClick={() => revokePageTurner.mutate()}><Unplug size={16} />Revoke token</button>}</div>{(regeneratePageTurner.isError || revokePageTurner.isError || pageTurner.isError) && <div className="login-error">{regeneratePageTurner.error?.message ?? revokePageTurner.error?.message ?? pageTurner.error?.message}</div>}<small>Profile: {pageTurner.data?.profileName ?? "Not configured"}{pageTurner.data?.lastUsedAt ? ` · Last used ${new Date(pageTurner.data.lastUsedAt).toLocaleString()}` : ""}</small></>}</div></section>}
      {activeNav !== "Settings" && <><form className="search-box" onSubmit={submit}>
        <Search aria-hidden="true" size={22} />
        <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Search by title, author, ISBN…" aria-label="Search books" />
        <button type="submit" disabled={input.trim().length < 2}>Search</button>
      </form>

      {!query && <section className="empty-state"><div className="orb"><Headphones size={38} /></div><h2>One search. Every edition.</h2><p>AIOBooks resolves canonical book metadata first, keeping discovery clean and acquisition precise.</p><div className="principles"><span>Works & editions</span><span>Explainable matching</span><span>Private by design</span></div></section>}
      {result.isLoading && <div className="status">Searching the catalogue…</div>}
      {result.isError && <div className="status error">{result.error.message}</div>}
      {result.data && <section className="results">
        <div className="section-title"><div><span className="eyebrow">Catalogue results</span><h2>{result.data.total.toLocaleString()} matches for “{query}”</h2></div></div>
        <div className="book-grid">{result.data.items.map((book) => <article className="book-card" key={book.id}>
          <div className="cover">{book.coverUrl ? <img src={book.coverUrl} alt={`Cover of ${book.title}`} loading="lazy" /> : <BookOpen size={34} />}</div>
          <div className="book-copy"><span className="book-year">{book.firstPublishedYear ?? "Year unknown"}</span><h3>{book.title}</h3><p>{book.authors.map((author) => author.name).join(", ") || "Unknown author"}</p><div className="availability"><span><BookOpen size={14} /> {book.editions.length || "No"} mapped edition{book.editions.length === 1 ? "" : "s"}</span></div></div>
          <button className="card-action" aria-label={`Request ${book.title}`} onClick={() => { setSelectedBook(book); setSelectedProfile(profiles.data?.[0]?.id ?? ""); setSelectedLibrary(libraries.data?.[0]?.id ?? ""); createRequest.reset(); selectRelease.reset(); }}>Request</button>
        </article>)}</div>
      </section>}
      {selectedBook && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedBook(null); }}><section className="request-modal" role="dialog" aria-modal="true" aria-labelledby="request-title">
        <button className="modal-close" onClick={() => setSelectedBook(null)} aria-label="Close"><X size={20} /></button>
        <span className="eyebrow">Acquisition request</span><h2 id="request-title">{selectedBook.title}</h2><p className="modal-author">{selectedBook.authors.map((author) => author.name).join(", ")}</p>
        {!createRequest.data && <div className="request-fields"><label>Acquisition profile<select value={selectedProfile} onChange={(event) => setSelectedProfile(event.target.value)}><option value="">Select a profile</option>{profiles.data?.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.mediaType.toLocaleLowerCase()}</option>)}</select></label><label>Destination<select value={selectedLibrary} onChange={(event) => setSelectedLibrary(event.target.value)}><option value="">Select a library</option>{libraries.data?.map((library) => <option key={library.id} value={library.id}>{library.name} · {library.kind.toLocaleLowerCase()}</option>)}</select></label>{(!profiles.data?.length || !libraries.data?.length) && <div className="setup-note"><Settings size={17} />Create at least one profile and library in Settings before requesting.</div>} {createRequest.isError && <div className="login-error">{createRequest.error.message}</div>}<button className="primary-action" disabled={!selectedProfile || !selectedLibrary || createRequest.isPending} onClick={() => createRequest.mutate()}>{createRequest.isPending ? "Searching sources…" : "Request and inspect releases"}</button></div>}
        {createRequest.data && <div className="release-results"><div className="request-state"><CheckCircle2 size={18} /><span>Request {(selectRelease.data?.state ?? createRequest.data.state).toLocaleLowerCase().replace("_", " ")}</span></div>{selectRelease.isError && <div className="login-error">{selectRelease.error.message}</div>}{createRequest.data.releases.length === 0 ? <div className="setup-note"><Search size={17} />No acceptable release was found. This wanted request will retry automatically.</div> : <><h3>Ranked releases</h3>{createRequest.data.releases.map((item, index) => <article className="release-row" key={item.id}><div className="release-rank">{index + 1}</div><div><strong>{item.release.rawTitle}</strong><div className="release-meta"><span>{item.release.format}</span><span>{item.release.downloadProtocol}</span><span>{item.match.confidence}% match</span>{item.release.sizeBytes && <span>{(item.release.sizeBytes / 1024 / 1024).toFixed(0)} MB</span>}</div><ul>{item.match.reasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}</ul><button className="primary-action" disabled={createRequest.data.state !== "MATCHED" || selectRelease.isPending || Boolean(selectRelease.data)} onClick={() => selectRelease.mutate(item.id)}>{createRequest.data.state !== "MATCHED" ? "Automatically selected" : selectRelease.isPending ? "Queueing…" : selectRelease.data ? "Queued" : "Select release"}</button></div></article>)}</>}{createRequest.data.diagnostics && <div className="provider-diagnostics"><Database size={15} />{createRequest.data.diagnostics.map((item) => <span key={item.providerId}>{item.outcome} · {item.releaseCount} · {item.durationMs}ms</span>)}</div>}</div>}
      </section></div>}</>}
    </main>
  </div>;
}
