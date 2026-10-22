let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = input.books ?? [];
const principal = input.principal ?? null;
const query = { ...(input.query ?? {}), ...(input.params ?? {}) };
const JSON_HEADERS = { "content-type": "application/json" };

const isLibrarian = principal?.role === "librarian";
const isOwner = (book) => principal != null && book.ownerId === principal.id;
const isVisible = (book) =>
  isLibrarian || isOwner(book);

const respond = (status, body, data = books, deleted = []) => {
  const failures = [];
  if (body && typeof body.error === "string") {
    const code = body.error.replace(/ /g, "_");
    const errCode = body.error === "not found" ? "not_found" : code;
    body = { error: { code: errCode } };
    failures.push({ code: errCode, status, retryable: false });
  }
  console.log(JSON.stringify({
    http: { status, headers: body === null ? {} : JSON_HEADERS, body },
    database: { books: data, deleted },
    failures
  }));
};

const pick = (book) => ({ id: book.id, ownerId: book.ownerId, title: book.title, genre: book.genre });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const toInt = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
};

if (!principal || !principal.id) {
  respond(401, { error: "unauthorized" });
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) respond(404, { error: "not found" });
  else if (!isLibrarian && !isOwner(book)) respond(403, { error: "forbidden" });
  else respond(204, null, books.filter((b) => b.id !== input.bookId), [input.bookId]);
} else {
  const offset = toInt(query.offset ?? input.offset, 0);
  const limit = toInt(query.limit ?? input.limit, undefined);
  if (Number.isNaN(offset) || offset < 0 || Number.isNaN(limit) || (limit !== undefined && limit < 0)) {
    respond(400, { error: "invalid pagination" });
  } else {
    const genre = query.genre ?? input.genre;
    const ownerId = query.ownerId ?? input.ownerId;
    const q = query.q ?? query.title ?? input.q;
    let items = books.filter(isVisible);
    if (genre !== undefined && genre !== "") items = items.filter((b) => b.genre === genre);
    if (ownerId !== undefined && ownerId !== "") items = items.filter((b) => b.ownerId === ownerId);
    if (q !== undefined && q !== "") {
      const needle = String(q).toLowerCase();
      items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(needle));
    }
    items = [...items].sort((a, b) =>
      cmp(String(a.title ?? "").toLowerCase(), String(b.title ?? "").toLowerCase()) ||
      cmp(a.title ?? "", b.title ?? "") ||
      cmp(String(a.id), String(b.id)));
    const total = items.length;
    const page = items.slice(offset, limit === undefined ? undefined : offset + limit).map(pick);
    respond(200, { items: page, total, offset, limit: limit ?? null });
  }
}
