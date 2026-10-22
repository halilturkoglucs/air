let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = Array.isArray(input.books) ? input.books : [];
const principal = input.principal ?? null;
const query = Object.assign({}, input.filters ?? {}, input.query ?? {});
for (const k of ["genre", "ownerId", "title", "q", "offset", "limit"]) {
  if (input[k] !== undefined && query[k] === undefined) query[k] = input[k];
}

const JSON_HEADERS = { "content-type": "application/json" };
const out = (status, body, db, headers = body === null ? {} : JSON_HEADERS) => {
  console.log(JSON.stringify({
    http: { status, headers, body },
    database: db ?? { books, deleted: [] },
    failures: []
  }));
};
const err = (status, error) => out(status, { error });

const isLibrarian = principal?.role === "librarian";
const project = (b) => ({ id: b.id, title: b.title, genre: b.genre, ownerId: b.ownerId });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

if (!principal || principal.id === undefined || principal.id === null) {
  err(401, "unauthorized");
} else if (input.operation === "delete") {
  const book = books.find((b) => b.id === input.bookId);
  if (!book) err(404, "not_found");
  else if (book.ownerId !== principal.id && !isLibrarian) err(403, "forbidden");
  else out(204, null, { books: books.filter((b) => b.id !== input.bookId), deleted: [input.bookId] });
} else {
  const num = (v) => (v === undefined || v === null || v === "" ? NaN : Number(v));
  const off = num(query.offset);
  const lim = num(query.limit);
  const bad = (n) => !Number.isNaN(n) && (!Number.isInteger(n) || n < 0);
  if (bad(off) || bad(lim)) {
    err(400, "invalid_pagination");
  } else {
    let items = books.filter((b) =>
      isLibrarian || b.ownerId === principal.id || b.public === true || b.visibility === "public");
    if (query.genre !== undefined) items = items.filter((b) => b.genre === query.genre);
    if (query.ownerId !== undefined) items = items.filter((b) => b.ownerId === query.ownerId);
    if (query.title !== undefined) items = items.filter((b) => b.title === query.title);
    if (query.q !== undefined) {
      const q = String(query.q).toLowerCase();
      items = items.filter((b) => String(b.title ?? "").toLowerCase().includes(q));
    }
    items.sort((a, b) =>
      cmp(String(a.title ?? "").toLowerCase(), String(b.title ?? "").toLowerCase()) || cmp(String(a.id), String(b.id)));
    const total = items.length;
    const start = Number.isNaN(off) ? 0 : off;
    const page = items.slice(start, Number.isNaN(lim) ? undefined : start + lim);
    out(200, { items: page.map(project), total });
  }
}
