let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const JSON_HEADERS = { "content-type": "application/json" };

function respond(status, body, data = books, deleted = []) {
  const headers = body === null ? {} : JSON_HEADERS;
  console.log(JSON.stringify({
    http: { status, headers, body },
    database: { books: data, deleted },
    failures: []
  }));
}

const isLibrarian = principal?.role === "librarian";
const isOwner = (book) => principal && book.ownerId === principal.id;
const isPublic = (book) => book.visibility === "public" || book.public === true;
const canView = (book) => isLibrarian || isOwner(book) || isPublic(book);

const project = (book) => ({
  id: book.id,
  ownerId: book.ownerId,
  title: book.title,
  genre: book.genre
});

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

if (!principal || !principal.id) {
  respond(401, { error: "unauthorized" });
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) {
    respond(404, { error: "not found" });
  } else if (!(isLibrarian || isOwner(book))) {
    respond(403, { error: "forbidden" });
  } else {
    respond(204, null, books.filter((b) => b.id !== input.bookId), [input.bookId]);
  }
} else {
  const q = input.query ?? input.filter ?? input.filters ?? {};
  const genre = q.genre ?? input.genre;
  const ownerId = q.ownerId ?? input.ownerId;
  const search = q.q ?? q.title ?? input.q ?? input.search;
  let items = books.filter(canView);
  if (genre !== undefined && genre !== null) items = items.filter((b) => b.genre === genre);
  if (ownerId !== undefined && ownerId !== null) items = items.filter((b) => b.ownerId === ownerId);
  if (search) {
    const s = String(search).toLowerCase();
    items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(s));
  }
  items.sort((a, b) => cmp(String(a.title ?? ""), String(b.title ?? "")) || cmp(String(a.id), String(b.id)));
  const total = items.length;
  const offset = Math.max(0, Number(q.offset ?? input.offset ?? 0) || 0);
  const rawLimit = q.limit ?? input.limit;
  const limit = rawLimit === undefined || rawLimit === null ? undefined : Math.max(0, Number(rawLimit) || 0);
  items = items.slice(offset, limit === undefined ? undefined : offset + limit);
  respond(200, { items: items.map(project), total, offset, limit: limit ?? null });
}
