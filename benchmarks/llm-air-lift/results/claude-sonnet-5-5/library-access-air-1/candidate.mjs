let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const isLibrarian = principal?.role === "librarian";
const json = { "content-type": "application/json" };

function respond(status, body, db, deleted = [], failures = []) {
  const headers = body === null ? {} : json;
  console.log(JSON.stringify({ http: { status, headers, body }, database: { books: db, deleted }, failures }));
}

const isOwner = (book) => principal && book.ownerId === principal.id;
const isPublic = (book) => book.public === true || book.visibility === "public" || book.isPublic === true;
const canSee = (book) => isLibrarian || isOwner(book) || isPublic(book);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const toInt = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

if (input.operation === "delete") {
  const id = input.bookId ?? input.id;
  if (!principal) {
    respond(401, { error: { code: "unauthorized" } }, books, [], [{ code: "unauthorized", status: 401, retryable: false }]);
  } else {
    const book = books.find((b) => b.id === id);
    if (!book) respond(404, { error: { code: "not_found" } }, books, [], [{ code: "not_found", status: 404, retryable: false }]);
    else if (!isLibrarian && !isOwner(book)) respond(403, { error: { code: "forbidden" } }, books, [], [{ code: "forbidden", status: 403, retryable: false }]);
    else respond(204, null, books.filter((b) => b.id !== id), [id]);
  }
} else {
  const q = { ...(input.filters ?? {}), ...(input.query ?? {}) };
  for (const k of ["genre", "ownerId", "title", "search", "q", "limit", "offset"]) {
    if (input[k] !== undefined && q[k] === undefined) q[k] = input[k];
  }
  let items = books.filter(canSee);
  if (q.genre !== undefined) items = items.filter((b) => b.genre === q.genre);
  if (q.ownerId !== undefined) items = items.filter((b) => b.ownerId === q.ownerId);
  if (q.title !== undefined) items = items.filter((b) => b.title === q.title);
  const term = q.search ?? q.q;
  if (term) {
    const t = String(term).toLowerCase();
    items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(t));
  }
  items = [...items].sort((a, b) =>
    cmp(String(a.title ?? "").toLowerCase(), String(b.title ?? "").toLowerCase()) ||
    cmp(String(a.id), String(b.id)));
  const total = items.length;
  const offset = toInt(q.offset, 0);
  const limit = q.limit === undefined ? undefined : toInt(q.limit, undefined);
  items = items.slice(offset, limit === undefined ? undefined : offset + limit);
  respond(200, { items, total, limit, offset }, books);
}
