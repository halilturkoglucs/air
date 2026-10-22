let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const query = { ...(input.query ?? {}), ...(input.filters ?? {}) };

const json = { "content-type": "application/json" };
const respond = (status, body, dbBooks, deleted = []) => {
  console.log(JSON.stringify({
    http: { status, headers: body === null ? {} : json, body },
    database: { books: dbBooks, deleted },
    failures: []
  }));
};

const isLibrarian = principal?.role === "librarian";
const isPublic = (b) => b.visibility === "public" || b.public === true;
const canSee = (b) => isLibrarian || b.ownerId === principal?.id || isPublic(b);
const project = (b) => ({ id: b.id, ownerId: b.ownerId, title: b.title, genre: b.genre });

const pick = (name) => query[name] ?? input[name];
const toInt = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

if (!principal || principal.id === undefined) {
  respond(401, { error: "unauthorized" }, books);
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) {
    respond(404, { error: "not found" }, books);
  } else if (book.ownerId !== principal.id && !isLibrarian) {
    respond(403, { error: "forbidden" }, books);
  } else {
    respond(204, null, books.filter((b) => b.id !== input.bookId), [input.bookId]);
  }
} else {
  let items = books.filter(canSee);
  const genre = pick("genre");
  const ownerId = pick("ownerId");
  const q = pick("q") ?? pick("title");
  if (genre !== undefined && genre !== null) items = items.filter((b) => b.genre === genre);
  if (ownerId !== undefined && ownerId !== null) items = items.filter((b) => b.ownerId === ownerId);
  if (q) items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(String(q).toLowerCase()));
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  items.sort((a, b) => cmp(String(a.title ?? ""), String(b.title ?? "")) || cmp(String(a.id), String(b.id)));
  const total = items.length;
  const offset = toInt(pick("offset"), 0);
  const limit = toInt(pick("limit"), total);
  items = items.slice(offset, offset + limit).map(project);
  respond(200, { items, total, offset, limit }, books);
}
