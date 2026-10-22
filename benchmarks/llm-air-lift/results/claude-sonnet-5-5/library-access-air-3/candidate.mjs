let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const params = { ...(input.query ?? {}), ...(input.filters ?? {}) };
const param = (name) => params[name] ?? input[name];

const json = { "content-type": "application/json" };
const respond = (status, body, database, failures = []) => {
  console.log(JSON.stringify({
    http: { status, headers: body === null ? {} : json, body },
    database,
    failures
  }));
};
const fail = (status, code) => respond(status, { error: { code } }, unchanged, [{ code, status, retryable: false }]);
const unchanged ={ books, deleted: [] };
const isLibrarian = principal?.role === "librarian";
const project = (b) => ({ id: b.id, ownerId: b.ownerId, title: b.title, genre: b.genre });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

if (!principal || principal.id == null) {
  fail(401, "unauthorized");
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) {
    fail(404, "not_found");
  } else if (!isLibrarian && book.ownerId !== principal.id) {
    fail(403, "forbidden");
  } else {
    respond(204, null, { books: books.filter((b) => b.id !== input.bookId), deleted: [input.bookId] });
  }
} else {
  let items = books.filter((b) => isLibrarian || b.ownerId === principal.id);
  const genre = param("genre");
  const ownerId = param("ownerId");
  const search = param("search") ?? param("q") ?? param("title");
  if (genre != null) items = items.filter((b) => b.genre === genre);
  if (ownerId != null) items = items.filter((b) => b.ownerId === ownerId);
  if (search != null) {
    const s = String(search).toLowerCase();
    items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(s));
  }
  items = [...items].sort((a, b) =>
    cmp(String(a.title ?? "").toLowerCase(), String(b.title ?? "").toLowerCase()) || cmp(String(a.id), String(b.id)));
  const total = items.length;
  const offset = Math.max(0, parseInt(param("offset"), 10) || 0);
  const limitRaw = parseInt(param("limit"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? limitRaw : total;
  const page = items.slice(offset, offset + limit).map(project);
  respond(200, { items: page, total, offset, limit }, unchanged);
}
