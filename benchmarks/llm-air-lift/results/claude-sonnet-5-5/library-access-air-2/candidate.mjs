let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const query = { ...input, ...(input.query ?? {}) };

const json = { "content-type": "application/json" };
const emit = (status, body, database, headers = json) =>
  console.log(JSON.stringify({
    http: { status, headers: body === null ? {} : headers, body },
    database,
    failures: []
  }));
const fail = (status, code) =>
  console.log(JSON.stringify({
    http: { status, headers: json, body: { error: { code } } },
    database: unchanged,
    failures: [{ code, status, retryable: false }]
  }));
const unchanged = { books, deleted: [] };

const isLibrarian = principal?.role === "librarian";
const isOwner = (book) => principal && book.ownerId === principal.id;
const isPublic = (book) => book.visibility === "public" || book.public === true;
const canSee = (book) => isLibrarian || isOwner(book) || isPublic(book);

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

if (!principal || !principal.id) {
  fail(401, "unauthorized");
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) {
    fail(404, "not_found");
  } else if (!(isLibrarian || isOwner(book))) {
    fail(403, "forbidden");
  } else {
    emit(204, null, {
      books: books.filter((b) => b.id !== input.bookId),
      deleted: [input.bookId]
    });
  }
} else {
  let items = books.filter(canSee);
  if (query.genre) items = items.filter((b) => b.genre === query.genre);
  if (query.ownerId) items = items.filter((b) => b.ownerId === query.ownerId);
  const text = query.q ?? query.title ?? query.search;
  if (text) {
    const needle = String(text).toLowerCase();
    items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(needle));
  }
  items = items.slice().sort((a, b) => {
    const t = String(a.title ?? "").localeCompare(String(b.title ?? ""));
    return t !== 0 ? t : String(a.id).localeCompare(String(b.id));
  });
  const total = items.length;
  const offset = toInt(query.offset, 0);
  const limit = toInt(query.limit, total);
  items = items.slice(offset, offset + limit);
  emit(200, { items, total, offset, limit }, unchanged);
}
