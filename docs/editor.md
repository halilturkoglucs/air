# Editor integration

AIR ships a dependency-light Language Server Protocol process. Start it with:

```bash
pnpm air lsp
```

An editor client should launch that command over stdio for `air.yaml`, `*.air.yaml`, and `*.air.yml` files. The server implements initialization, full-document synchronization, open/change/close lifecycle, shutdown, published and pull diagnostics, completion, hover, and document symbols. It runs the same YAML parser, JSON Schema checks, and cross-reference semantic validator as `air validate`; editor results therefore cannot drift into a separate validation model.

Diagnostics include stable AIR error codes and best-effort source ranges for semantic paths. YAML syntax failures are returned as `AIR_YAML_PARSE`. Completion documents the stable top-level and semantic keys, hover explains AIR vocabulary, and symbols expose entities, contracts, and commands. Schema-aware rename, code actions/quick fixes, and workspace-wide references remain future work.

For generated output, `air ownership <directory>` (or its `air reconcile` alias) reports compiler-owned manifest artifacts, user-owned files outside that set, and missing or locally modified generated files. Use `--json` for editor or CI integration. `air adopt <directory> --user-owned <path>` moves selected generated artifacts across a persisted adoption boundary; later compiles leave them untouched. Managed compilation otherwise overwrites only artifacts established by the preceding manifest and refuses to claim an existing unowned file.
