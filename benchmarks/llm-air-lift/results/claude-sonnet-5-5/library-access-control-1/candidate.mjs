let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const query = { ...input, ...(input.query ?? {}) };
const JSON_HEADERS = { "content-type": "application/json" };

const isLibrarian = principal?.role === "librarian";
const isPublic = (b) => b.public === true || b.visibility === "public";
const canSee = (b) => isLibrarian || (principal && b.ownerId === principal.id) || isPublic(b);
const project = (b) => ({ id: b.id, title: b.title, genre: b.genre, ownerId: b.ownerId });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function out(status, body, database, headers = body === null ? {} : JSON_HEADERS) {
  console.log(JSON.stringify({ http: { status, headers, body }, database, failures: [] }));
}
const unchanged = { books, deleted: [] };

function nonNegInt(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!principal) {
    out(401, { error: "unauthorized" }, unchanged);
  } else if (!book) {
    out(404, { error: "not_found" }, unchanged);
  } else if (book.ownerId !== principal.id && !isLibrarian) {
    out(403, { error: "forbidden" }, unchanged);
  } else {
    out(204, null, { books: books.filter((b) => b.id !== book.id), deleted: [book.id] });
  }
} else {
  const offset = nonNegInt(query.offset);
  const limit = nonNegInt(query.limit);
  if (Number.isNaN(offset) || Number.isNaN(limit)) {
    out(400, { error: "invalid_pagination" }, unchanged);
  } else {
    let items = books.filter(canSee);
    if (query.genre !== undefined && query.genre !== null) items = items.filter((b) => b.genre === query.genre);
    if (query.ownerId !== undefined && query.ownerId !== null) items = items.filter((b) => b.ownerId === query.ownerId);
    if (typeof query.title === "string" && query.title) {
      const t = query.title.toLowerCase();
      items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(t));
    }
    items = [...items].sort(
      (a, b) => cmp(String(a.title ?? "").toLowerCase(), String(b.title ?? "").toLowerCase()) || cmp(String(a.id), String(b.id))
    );
    const total = items.length;
    const start = offset ?? 0;
    items = items.slice(start, limit === undefined ? undefined : start + limit);
    out(200, { items: items.map(project), total }, unchanged);
  }
}
