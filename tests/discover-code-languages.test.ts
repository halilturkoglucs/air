import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCodeSeams } from "@air/discovery";

// One fixture per stack, mirroring how the RealWorld implementations in each language declare routes and data.
const files: Record<string, string> = {
  "java/ArticleFavoriteApi.java": "@RestController\n@RequestMapping(path = \"articles/{slug}/favorite\")\npublic class ArticleFavoriteApi {\n  @PostMapping\n  public void favorite() {}\n  @DeleteMapping\n  public void unfavorite() {}\n}\n",
  "java/UsersApi.java": "@RestController\npublic class UsersApi {\n  @RequestMapping(path = \"/users/login\", method = POST)\n  public void login() {}\n}\ninterface Users extends JpaRepository<UserEntity, Long> {}\n",
  "java/resources/mapper/ArticleMapper.xml": "<mapper><update id=\"update\">UPDATE articles SET title = #{title}</update><select id=\"find\">SELECT * FROM tags</select></mapper>\n",
  "csharp/ArticlesController.cs": "[Route(\"api/[controller]\")]\npublic class ArticlesController : Controller\n{\n    [HttpGet(\"feed\")]\n    public IActionResult Feed() => Ok();\n}\npublic class Db : DbContext { public DbSet<Article> Articles { get; set; } }\n",
  "csharp/Program.cs": "app.MapGet(\"/health\", () => \"ok\");\n",
  "php/routes/api.php": "<?php\nRoute::post('users/login', 'AuthController@login');\nRoute::match(['put', 'patch'], 'user', 'UserController@update');\nRoute::resource('articles', 'ArticleController');\n",
  "php/app/Article.php": "<?php\nclass Article extends Model {}\n",
  "rust/src/http/articles.rs": "Router::new()\n    .route(\n        \"/api/articles/:slug\",\n        get(get_article).put(update_article).delete(delete_article),\n    )\n    .route(\"/api/tags\", get(get_tags));\nsqlx::query!(r#\"select tag from tag\"#);\n",
  "ruby/config/routes.rb": "Rails.application.routes.draw do\n  scope :api do\n    devise_for :users, controllers: { sessions: :sessions },\n                       path_names: { sign_in: :login }\n    resource :user, only: [:show, :update]\n    resources :articles, param: :slug, except: [:edit, :new] do\n      resource :favorite, only: [:create, :destroy]\n      get :feed, on: :collection\n    end\n  end\nend\n",
  "ruby/app/models/article.rb": "class Article < ApplicationRecord\nend\n",
};

describe("air discover code in Java, C#, PHP, Rust, and Ruby", () => {
  it("finds routes with class prefixes, method lists, resource expansion, and the Rails routes DSL", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-languages-"));
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content); }
    const report = await scanCodeSeams({ root });
    const routes = report.seams.filter((seam) => seam.kind === "http").map((seam) => `${seam.method} ${seam.route}`);
    expect(routes).toEqual(expect.arrayContaining([
      "POST /articles/{slug}/favorite", "DELETE /articles/{slug}/favorite", "POST /users/login",
      "GET /api/Articles/feed", "GET /health",
      "POST /api/users/login", "PUT /api/user", "PATCH /api/user", "GET /api/articles", "DELETE /api/articles/:id",
      "GET /api/articles/:slug", "PUT /api/articles/:slug", "DELETE /api/articles/:slug", "GET /api/tags",
      "POST /api/users", "POST /api/users/login", "GET /api/user", "PATCH /api/user", "POST /api/articles/:slug/favorite", "GET /api/articles/feed",
    ]));
    expect(routes).not.toContain("GET /api/articles/:slug/edit");
    expect([...new Set(report.effects.map((effect) => effect.name))].sort()).toEqual(["Article", "UserEntity", "articles", "tag", "tags"]);
  });
});
