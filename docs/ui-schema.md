# AIR UI document v0.1

AIR UI documents preserve framework-neutral interface intent separately from application semantics. They can describe a static HTML page, a server-rendered Spring/JSP monolith, or a client/hybrid component application without treating one framework as the model.

The schema is [`packages/air-schema/schema/ui-0.1.schema.json`](../packages/air-schema/schema/ui-0.1.schema.json). Validate or inspect a document with the normal CLI:

```bash
air validate ui.air.yaml
air inspect ui.air.yaml
```

## Boundary

An Application document owns entities, contracts, commands, authorization, and HTTP operations. A UI document may reference that application and its operation IDs, but it does not redefine backend semantics. UI documents describe screens, data dependencies, presentation trees, interactions, design tokens, localization, assets, implementation constraints, and extraction provenance.

`implementation` records the intended rendering boundary and technology. It is descriptive, not a fixed target list:

```yaml
# Static HTML
implementation: { rendering: static, technology: HTML }

# Server-rendered monolith
implementation:
  rendering: server
  technology: Spring MVC
  language: Java
  templateEngine: JSP

# Hybrid component application
implementation:
  rendering: hybrid
  technology: Next.js
  language: TypeScript
  framework: React
```

## UI tree

Every screen has one recursive root node. Five node kinds cover native markup and framework abstractions:

- `element`: HTML, XML, native widget, or template element named by `element`.
- `component`: framework, design-system, tag-library, or server component named by `component`.
- `text`: literal, translated, or expression-bound text.
- `fragment`: grouping without a rendered wrapper.
- `slot`: an insertion point in a layout or component.

Values are explicit wrappers. `{ literal: ... }` prevents data from being mistaken for an expression. `{ expression: ... }` preserves a framework-neutral binding. `{ translation: key }` preserves localization intent.

```yaml
apiVersion: air.dev/ui/v0.1
kind: UI
metadata: { name: vocabulary-ui }
spec:
  application: vocabulary.air.yaml
  implementation:
    rendering: hybrid
    technology: Next.js
    language: TypeScript
    framework: React
  design:
    tokens:
      color: { primary: "#ff7f11", surface: "#ffffff" }
      spacing: { sm: 8, md: 16 }
  dataSources:
    vocabulary:
      kind: application
      operation: listVocabularyItems
  screens:
    vocabulary:
      path: /dashboard/vocabulary
      load: [vocabulary]
      root:
        id: page
        kind: element
        element: main
        children:
          - id: title
            kind: text
            text: { translation: vocabulary.title }
          - id: table
            kind: component
            component: DataTable
            properties:
              rows: { expression: data.vocabulary.items }
            actions:
              - on: rowClick
                kind: navigate
                target: /vocabulary/{row.id}
  localization:
    defaultLocale: en
    locales: [en, nl, ar]
    direction: { en: ltr, nl: ltr, ar: rtl }
```

## Escape hatches

Portable semantics remain explicit. Framework-only details live under `implementation`, `extensions`, or implementation hints. These accept JSON data, not executable code. This lets importers retain JSP tag names, React component imports, static generator directives, or legacy widget metadata without weakening the portable core.

Semantic validation additionally rejects duplicate node IDs, missing node-kind payloads, unknown screen data sources, and a default locale absent from the locale list.
