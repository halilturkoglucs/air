import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCodeSeams, scanCodeSeams } from "@air/discovery";

const files: Record<string, string> = {
  "api/routes.ts": `import express from "express";
const router = express.Router();
// router.get("/commented-out", handler) must not be found
/* router.post("/also-commented", handler) */
router.post("/orders", async (req, res) => {
  const order = await prisma.order.create({ data: req.body });
  await fetch("https://tax.example.com/rates", { method: "POST" });
  await producer.send({ topic: "order-created", messages: [] });
  res.status(201).json(order);
});
router.get("/orders/:id", async (req, res) => {
  const rows = await db.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(rows[0]);
});
export default router;
`,
  "web/app/api/books/[id]/route.ts": "export async function GET(request: Request) { return Response.json({}); }\nexport async function DELETE() { return new Response(null, { status: 204 }); }\n",
  "py/app.py": `from flask import Flask
app = Flask(__name__)

@app.route("/health")
def health():
    return "ok"

@app.route("/invoices", methods=["POST"])
def create_invoice():
    requests.post("https://billing.example.com/charge", json={})
    return {}, 201

@router.get("/reports/{report_id}")
async def report(report_id: str):
    return Invoice.objects.filter(id=report_id)

def total(items):
    subtotal = sum(item.price for item in items)
    return subtotal * 1.2

if __name__ == "__main__":
    app.run()
`,
  "py/shop/urls.py": "urlpatterns = [\n    path('carts/<int:pk>/', views.cart),\n]\n",
  "go/main.go": `package main

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /payments", pay)
	r := gin.Default()
	r.GET("/payments/:id", show)
}

func pay(w http.ResponseWriter, r *http.Request) {
	db.Exec("INSERT INTO payments (id) VALUES ($1)", id)
}
`,
  "bin/tool.mjs": "#!/usr/bin/env node\nconsole.log('hi');\n",
  "node_modules/dep/index.js": "app.get('/ignored', h);\n",
};

async function project(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "air-discover-code-"));
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content); }
  return root;
}

describe("air discover code", () => {
  it("proposes behavioral seams and their effects across JS/TS, Python, and Go without reading comments or vendored code", async () => {
    const root = await project();
    const report = await scanCodeSeams({ root });
    expect(formatCodeSeams(report)).toBe([
      "13 seam(s) in . (6 file(s) scanned; all inferred until executed)",
      "http POST /orders  api/routes.ts:5 [express-style]",
      "  db: order   out: https://tax.example.com/rates   msg: order-created",
      "http GET /orders/:id  api/routes.ts:11 [express-style]",
      "  db: orders",
      "cli bin/tool.mjs  bin/tool.mjs:1 [node]",
      "cli go/main.go  go/main.go:3 [go]",
      "http POST /payments  go/main.go:5 [net/http]",
      "  db: payments",
      "http GET /payments/:id  go/main.go:7 [gin-echo]",
      "http GET /health  py/app.py:4 [flask]",
      "http POST /invoices  py/app.py:8 [flask]",
      "  out: https://billing.example.com/charge",
      "http GET /reports/{report_id}  py/app.py:13 [flask-fastapi]",
      "  db: Invoice",
      "cli py/app.py  py/app.py:21 [python]",
      "http ANY /carts/<int:pk>/  py/shop/urls.py:2 [django]",
      "http GET /api/books/:id  web/app/api/books/[id]/route.ts:1 [next-route]",
      "http DELETE /api/books/:id  web/app/api/books/[id]/route.ts:2 [next-route]",
      "NEXT run `air protect --url <running service>` to execute the safe ones; lock the rest with `air harness task`.",
      "",
    ].join("\n"));
    expect(report.seams.every((seam) => seam.evidence === "inferred")).toBe(true);
    expect(new Set(report.seams.map((seam) => seam.id)).size).toBe(report.seams.length);
  });

  it("narrows to a path, a symbol, or the files changed since a Git ref", async () => {
    const root = await project();
    expect((await scanCodeSeams({ root, path: "py" })).seams.map((seam) => seam.file)).toEqual(["py/app.py", "py/app.py", "py/app.py", "py/app.py", "py/shop/urls.py"]);
    const symbol = await scanCodeSeams({ root, path: "py", symbol: "total" });
    expect(symbol.seams).toEqual([expect.objectContaining({ kind: "function", name: "total", file: "py/app.py", line: 17 })]);
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
    await writeFile(resolve(root, "go/main.go"), files["go/main.go"]!.replace("/payments/:id", "/payments/:paymentId"));
    const since = await scanCodeSeams({ root, since: "HEAD" });
    expect([...new Set(since.seams.map((seam) => seam.file))]).toEqual(["go/main.go"]);
    expect(since.seams.map((seam) => seam.route ?? seam.name)).toContain("/payments/:paymentId");
  });

  it("is available as air discover code with JSON output", async () => {
    const root = await project();
    const run = spawnSync(process.execPath, [resolve("packages/cli/dist/bin.js"), "discover", "code", "api", "--json"], { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { apiVersion: string; scope: { path: string }; seams: { id: string }[] };
    expect(report.apiVersion).toBe("air.dev/code-seams/v0.1");
    expect(report.scope.path).toBe("api");
    expect(report.seams.map((seam) => seam.id)).toEqual(["http-post-orders", "http-get-orders-id"]);
  }, 30_000);
});
