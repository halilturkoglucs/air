import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCodeSeams } from "@air/discovery";

// Patterns found while measuring discover code against RealWorld implementations in five stacks:
// route prefixes declared in another place than the route itself, regex routes, resource routers, and ORMs.
const files: Record<string, string> = {
  "nest/article.controller.ts": "@Controller('articles')\nexport class ArticleController {\n  @Get()\n  findAll() {}\n  @Post(':slug/favorite')\n  favorite() {}\n  constructor(@InjectRepository(ArticleEntity) private readonly articles: Repository<ArticleEntity>) {}\n}\n",
  "express/app.js": "import articles from './routes/articles';\napp.use('/api/articles', articles);\n",
  "express/routes/articles.js": "router.get('/', list);\nrouter.get('/:slug', show);\n",
  "fastapi/routes/api.py": "router.include_router(users.router, tags=['users'], prefix='/user')\n",
  "fastapi/routes/users.py": "router = APIRouter()\n\n@router.get('', name='users:get-current-user')\nasync def current():\n    return session.query(User).first()\n",
  "fastapi/queries/articles.sql": "-- name: get-article\nSELECT * FROM articles WHERE slug = :slug;\n",
  "go/main.go": "func main() {\n\tv1 := r.Group(\"/api\")\n\tusers.UsersRegister(v1.Group(\"/users\"))\n}\n",
  "go/users/routers.go": "func UsersRegister(router *gin.RouterGroup) {\n\trouter.POST(\"/\", UsersRegistration)\n\trouter.POST(\"/login\", UsersLogin)\n}\n\nfunc UsersRegistration(c *gin.Context) {\n\tdb.Model(&UserModel{}).Create(&user)\n}\n",
  "django/conduit/urls.py": "urlpatterns = [\n    url(r'^api/', include('conduit.apps.profiles.urls')),\n]\n",
  "django/conduit/apps/profiles/urls.py": "router.register(r'articles', ArticleViewSet)\nurlpatterns = [\n    url(r'^profiles/(?P<username>\\w+)/follow/?$', ProfileFollowAPIView.as_view()),\n]\n",
};

describe("air discover code route prefixes and data effects", () => {
  it("resolves controller prefixes, cross-file mounts, regex routes, resource routers, and ORM data", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-frameworks-"));
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content); }
    const report = await scanCodeSeams({ root });
    const routes = report.seams.filter((seam) => seam.kind === "http").map((seam) => `${seam.method} ${seam.route}`);
    expect(routes).toEqual(expect.arrayContaining([
      "GET /articles", "POST /articles/:slug/favorite",
      "GET /api/articles", "GET /api/articles/:slug",
      "GET /user",
      "POST /api/users", "POST /api/users/login",
      "ANY /api/profiles/:username/follow/",
      "GET /api/articles", "POST /api/articles", "GET /api/articles/:id", "DELETE /api/articles/:id",
    ]));
    expect([...new Set(report.effects.map((effect) => effect.name))].sort()).toEqual(["ArticleEntity", "User", "UserModel", "articles"]);
  });
});
