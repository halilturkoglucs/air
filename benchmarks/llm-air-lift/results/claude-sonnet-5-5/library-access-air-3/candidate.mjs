let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const isLibrarian = principal?.role === "librarian";

const respond = (status, body, database, failures = []) => {
  const headers = body === null ? {} : { "content-type": "application/json" };
  console.log(JSON.stringify({ http: { status, headers, body }, database, failures }));
};
const unchanged = () => ({ books, deleted: [] });
const error = (status, code, message) => respond(status, { error: { code, message } }, unchanged(), [code]);

const isPublic = (b) => b.public === true || b.visibility === "public";
const canSee = (b) => isLibrarian || (principal && b.ownerId === principal.id) || isPublic(b);
const project = (b) => ({ id: b.id, ownerId: b.ownerId, title: b.title, genre: b.genre });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

if (!principal || principal.id == null) {
  error(401, "unauthenticated", "Authentication required");
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) {
    error(404, "not_found", "Book not found");
  } else if (!isLibrarian && book.ownerId !== principal.id) {
    respond(403, { error: { code: "forbidden" } }, unchanged(), [{ code: "forbidden", status: 403, retryable: false }]);
  } else {
    respond(204, null, { books: books.filter((b) => b.id !== book.id), deleted: [book.id] });
  }
} else if (input.operation === "list") {
  const q = { ...(input.filter ?? {}), ...(input.query ?? {}) };
  const num = (v, d) => (v !== null && v !== undefined && v !== "" && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const offset = num(input.offset ?? q.offset, 0);
  const limit = num(input.limit ?? q.limit, Infinity);
  const genre = input.genre ?? q.genre;
  const ownerId = input.ownerId ?? q.ownerId;
  const search = input.title ?? input.search ?? q.title ?? q.search;
  let visible = books.filter(canSee);
  if (genre != null) visible = visible.filter((b) => b.genre === genre);
  if (ownerId != null) visible = visible.filter((b) => b.ownerId === ownerId);
  if (search != null) visible = visible.filter((b) => String(b.title ?? "").toLowerCase().includes(String(search).toLowerCase()));
  const t = (b) => String(b.title ?? "");
  visible.sort((a, b) => cmp(t(a).toLowerCase(), t(b).toLowerCase()) || cmp(t(a), t(b)) || cmp(String(a.id), String(b.id)));
  const items = visible.slice(offset, limit === Infinity ? undefined : offset + limit).map(project);
  respond(200, { items, total: visible.length, offset, limit: limit === Infinity ? null : limit }, unchanged());
} else {
  error(400, "bad_request", "Unknown operation");
}
