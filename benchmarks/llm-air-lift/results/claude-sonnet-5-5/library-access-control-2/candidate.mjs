let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const params = { ...(input.query && typeof input.query === "object" ? input.query : {}), ...input };

const json = { "content-type": "application/json" };
const respond = (status, body, data = books, deleted = [], failures = []) => {
  console.log(JSON.stringify({
    http: { status, headers: body === null ? {} : json, body },
    database: { books: data, deleted },
    failures
  }));
};

const isLibrarian = principal?.role === "librarian";
const isOwner = (book) => principal != null && book.ownerId === principal.id;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const project = (b) => ({ id: b.id, ownerId: b.ownerId, title: b.title, genre: b.genre });

if (!principal || principal.id == null) {
  respond(401, { error: "unauthorized" });
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) {
    respond(404, { error: "not found" });
  } else if (!isOwner(book) && !isLibrarian) {
    respond(403, { error: "forbidden" });
  } else {
    respond(204, null, books.filter((b) => b.id !== input.bookId), [input.bookId]);
  }
} else {
  let items = books.filter((b) => isLibrarian || isOwner(b));
  if (params.genre != null) items = items.filter((b) => b.genre === params.genre);
  if (params.ownerId != null) items = items.filter((b) => b.ownerId === params.ownerId);
  const q = params.q ?? params.search ?? params.title;
  if (q != null && q !== "") {
    const needle = String(q).toLowerCase();
    items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(needle));
  }
  const field = ["id", "title", "genre", "ownerId"].includes(params.sort) ? params.sort : "title";
  const dir = params.order === "desc" ? -1 : 1;
  items = [...items].sort((a, b) => dir * cmp(a[field] ?? "", b[field] ?? "") || cmp(a.id, b.id));
  const total = items.length;
  const offset = Math.max(0, Number.isInteger(+params.offset) ? +params.offset : 0);
  const limit = params.limit != null && Number.isInteger(+params.limit) && +params.limit >= 0 ? +params.limit : undefined;
  items = items.slice(offset, limit === undefined ? undefined : offset + limit);
  respond(200, { items: items.map(project), total, offset, limit: limit ?? null });
}
