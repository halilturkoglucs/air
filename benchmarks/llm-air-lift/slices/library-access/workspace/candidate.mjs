let source = "";
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source || "{}");
const books = input.books ?? [];

if (input.operation === "delete") {
  console.log(JSON.stringify({
    http: { status: 204, headers: {}, body: null },
    database: { books: books.filter((book) => book.id !== input.bookId), deleted: [input.bookId] },
    failures: []
  }));
} else {
  console.log(JSON.stringify({
    http: { status: 200, headers: { "content-type": "application/json" }, body: { items: books, total: books.length } },
    database: { books, deleted: [] },
    failures: []
  }));
}
