let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const query = { ...(input.query ?? {}), ...(input.filters ?? {}) };

const json = { "content-type": "application/json" };
const respond = (status, body, database, failures = []) => {
  console.log(JSON.stringify({
    http: { status, headers: body === null ? {} : json, body },
    database,
    failures
  }));
};
const unchanged = { books, deleted: [] };

const isLibrarian = principal?.role === "librarian";
const isPublic = (b) => b.visibility === "public" || b.public === true;
const canSee = (b) => isLibrarian || b.ownerId === principal?.id || isPublic(b);
const project = (b) => ({ id: b.id, ownerId: b.ownerId, title: b.title, genre: b.genre });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const toInt = (v, d) => {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

if (!principal || principal.id === undefined || principal.id === null) {
  respond(401, { error: "unauthorized" }, unchanged);
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) {
    respond(404, { error: "not_found" }, unchanged);
  } else if (!(isLibrarian || book.ownerId === principal.id)) {
    respond(403, { error: "forbidden" }, unchanged);
  } else {
    respond(204, null, { books: books.filter((b) => b.id !== input.bookId), deleted: [input.bookId] });
  }
} else {
  const offset = toInt(query.offset ?? input.offset, 0);
  const limit = toInt(query.limit ?? input.limit, undefined);
  if (Number.isNaN(offset) || offset < 0 || Number.isNaN(limit) || (limit !== undefined && limit < 0)) {
    respond(400, { error: "invalid_pagination" }, unchanged);
  } else {
    let items = books.filter(canSee);
    if (query.genre !== undefined) items = items.filter((b) => b.genre === query.genre);
    const owner = query.ownerId ?? query.owner;
    if (owner !== undefined) items = items.filter((b) => b.ownerId === owner);
    const text = query.q ?? query.title ?? query.search;
    if (text !== undefined) {
      const t = String(text).toLowerCase();
      items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(t));
    }
    items.sort((a, b) =>
      cmp(String(a.title ?? "").toLowerCase(), String(b.title ?? "").toLowerCase()) ||
      cmp(String(a.title ?? ""), String(b.title ?? "")) ||
      cmp(String(a.id), String(b.id)));
    const total = items.length;
    const page = items.slice(offset, limit === undefined ? undefined : offset + limit).map(project);
    respond(200, { items: page, total, offset, limit: limit ?? null }, unchanged);
  }
}
