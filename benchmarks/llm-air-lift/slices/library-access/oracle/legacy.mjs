let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = input.books ?? [];
const principal = input.principal ?? { id: "anonymous", role: "student" };

if (input.operation === "delete") {
  const book = books.find((item) => item.id === input.bookId);
  const allowed = book && (book.ownerId === principal.id || principal.role === "librarian");
  if (!allowed) {
    console.log(JSON.stringify({
      http: { status: 403, headers: { "content-type": "application/json" }, body: { error: { code: "forbidden" } } },
      database: { books, deleted: [] },
      failures: [{ code: "forbidden", status: 403, retryable: false }]
    }));
  } else {
    console.log(JSON.stringify({
      http: { status: 204, headers: {}, body: null },
      database: { books: books.filter((item) => item.id !== input.bookId), deleted: [input.bookId] },
      failures: []
    }));
  }
} else {
  const visible = principal.role === "librarian" ? books : books.filter((book) => book.ownerId === principal.id);
  const filtered = input.genre ? visible.filter((book) => book.genre === input.genre) : visible;
  const ordered = [...filtered].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  const items = ordered.slice(offset, offset + limit).map(({ id, title, genre, ownerId }) => ({ id, title, genre, ownerId }));
  console.log(JSON.stringify({
    http: { status: 200, headers: { "content-type": "application/json" }, body: { items, total: ordered.length, offset, limit } },
    database: { books, deleted: [] },
    failures: []
  }));
}
