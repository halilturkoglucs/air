import { describe, expect, it } from "vitest";
import { AIR_COMPLETION_ITEMS, airDocumentSymbols, diagnoseAirDocument, hoverAirDocument } from "@air/language-server";

describe("AIR language server diagnostics", () => {
  it("returns no diagnostics for a valid AIR document", () => {
    const diagnostics = diagnoseAirDocument(`
apiVersion: air.dev/v0.8
kind: Application
metadata: { name: editor-demo }
spec:
  entities:
    Item:
      fields:
        id: { type: uuid, primaryKey: true, generated: uuid }
`);
    expect(diagnostics).toEqual([]);
  });

  it("maps semantic issues to stable LSP diagnostics and source ranges", () => {
    const source = `
apiVersion: air.dev/v0.8
kind: Application
metadata: { name: editor-demo }
spec:
  entities:
    Item:
      fields:
        id: { type: mystery }
`;
    const diagnostics = diagnoseAirDocument(source, "file:///air.yaml");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]).toMatchObject({ severity: 1, source: "air" });
    expect(diagnostics.some((item) => item.range.start.line === 8)).toBe(true);
  });

  it("reports YAML parse errors without throwing", () => {
    const diagnostics = diagnoseAirDocument("apiVersion: [", "file:///broken.air.yaml");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("AIR_YAML_PARSE");
  });

  it("offers AIR vocabulary completion and hover documentation", () => {
    expect(AIR_COMPLETION_ITEMS.map((item) => item.label)).toEqual(expect.arrayContaining(["entities", "commands", "collection"]));
    const hover = hoverAirDocument("spec:\n  entities:", { line: 1, character: 5 });
    expect(hover?.contents.value).toContain("Persistent domain entities");
  });

  it("extracts semantic document symbols", () => {
    const symbols = airDocumentSymbols(`
apiVersion: air.dev/v0.8
kind: Application
metadata: { name: symbol-demo }
spec:
  entities:
    Item:
      fields:
        id: { type: uuid, primaryKey: true, generated: uuid }
`);
    expect(symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Item", kind: 5 })]));
  });
});
