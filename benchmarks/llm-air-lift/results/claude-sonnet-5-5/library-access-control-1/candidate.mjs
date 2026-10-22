let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const query = { ...(input.query ?? {}), ...(input.filters ?? {}) };
for (const key of ["genre", "ownerId", "title", "q", "offset", "limit"]) {
  if (input[key] !== undefined && query[key] === undefined) query[key] = input[key];
}

const json = { "content-type": "application/json" };
const respond = (status, body, dbBooks = books, deleted = []) => {
  console.log(JSON.stringify({
    http: { status, headers: body === null ? {} : json, body },
    database: { books: dbBooks, deleted },
    failures: []
  }));
};
const error = (status, message) => respond(status, { error: message });

const isLibrarian = principal?.role === "librarian";
const isPublic = (b) => b.public === true || b.visibility === "public";
const canSee = (b) => isLibrarian || b.ownerId === principal?.id || isPublic(b);
const project = (b) => ({ id: b.id, ownerId: b.ownerId, title: b.title, genre: b.genre });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

if (!principal || !principal.id) {
  error(401, "unauthorized");
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) error(404, "not found");
  else if (!isLibrarian && book.ownerId !== principal.id) error(403, "forbidden");
  else respond(204, null, books.filter((b) => b.id !== input.bookId), [input.bookId]);
} else {
  const nonNeg = (v, d) => {
    if (v === undefined || v === null || v === "") return d;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : NaN;
  };
  const offset = nonNeg(query.offset, 0);
  const limit = nonNeg(query.limit, Infinity);
  if (Number.isNaN(offset) || Number.isNaN(limit)) {
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
    items.sort((a, b) => cmp(String(a.title ?? ""), String(b.title ?? "")) || cmp(String(a.id), String(b.id)));
    const total = items.length;
    const page = items.slice(offset, limit === Infinity ? undefined : offset + limit).map(project);
    respond(200, { items: page, total, offset, limit: limit === Infinity ? null : limit });
  }
}
