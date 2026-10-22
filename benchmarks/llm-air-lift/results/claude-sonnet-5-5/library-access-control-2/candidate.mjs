let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const query = { ...(input.filters ?? {}), ...(input.query ?? {}) };

const JSON_HEADERS = { "content-type": "application/json" };
const respond = (status, body, data = books, deleted = []) => {
  console.log(JSON.stringify({
    http: { status, headers: body === null ? {} : JSON_HEADERS, body },
    database: { books: data, deleted },
    failures: []
  }));
};
const error = (status, message) => respond(status, { error: message });

const isLibrarian = principal?.role === "librarian";
const isPublic = (b) => b.visibility === "public" || b.public === true;
const canSee = (b) => isLibrarian || b.ownerId === principal.id || isPublic(b);
const project = (b) => ({ id: b.id, title: b.title, genre: b.genre, ownerId: b.ownerId });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function toInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

if (!principal || principal.id === undefined || principal.id === null) {
  error(401, "unauthenticated");
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) error(404, "not found");
  else if (book.ownerId !== principal.id && !isLibrarian) error(403, "forbidden");
  else respond(204, null, books.filter((b) => b.id !== input.bookId), [input.bookId]);
} else if (input.operation === "list") {
  const offset = toInt(query.offset ?? input.offset, 0);
  const limit = toInt(query.limit ?? input.limit, undefined);
  if (Number.isNaN(offset) || offset < 0 || Number.isNaN(limit) || (limit !== undefined && limit < 0)) {
    error(400, "invalid pagination");
  } else {
    let items = books.filter(canSee);
    if (query.genre !== undefined) items = items.filter((b) => b.genre === query.genre);
    if (query.ownerId !== undefined) items = items.filter((b) => b.ownerId === query.ownerId);
    if (query.title !== undefined) items = items.filter((b) => b.title === query.title);
    if (query.q !== undefined) {
      const q = String(query.q).toLowerCase();
      items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(q));
    }
    items = [...items].sort((a, b) => cmp(a.title ?? "", b.title ?? "") || cmp(a.id, b.id));
    const total = items.length;
    const page = items.slice(offset, limit === undefined ? undefined : offset + limit).map(project);
    respond(200, { items: page, total, offset, limit: limit ?? null });
  }
} else {
  error(400, "unknown operation");
}
