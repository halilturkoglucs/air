# AIR vision

## Thesis

Application semantics should outlive the framework, language, and deployment platform selected to implement them. AIR makes those semantics explicit and machine-verifiable, then treats a technology stack as a compilation target.

The durable artifacts are requirements, schemas, contracts, invariants, tests, performance goals, and architecture constraints. Generated TypeScript, Rust, Java, SQL, or machine code can be replaced when constraints change.

## Greenfield pipeline

```text
requirements or existing source
              |
              v
     requirement compiler
              |
              v
             AIR
              |
              v
    deterministic validation
              |
              v
     architecture planning
              |
              v
      capability solving
              |
              v
        target adapter
              |
              v
 generated application + tests
              |
              v
 verification -> benchmark -> profile -> optimize
       ^                                  |
       +----------------------------------+
```

LLMs may propose requirements, plans, mappings, implementations, or optimizations. Deterministic schemas, capability rules, builds, tests, and policies decide what the system accepts.

## Modernization pipeline

```text
source + builds + tests + non-production traces
                     |
                     v
        discovery graph (not authoritative)
                     |
                     v
       human review + capability slicing
                     |
                     v
          reviewed AIR + foreign ports
                     |
                     v
       legacy/candidate differential evidence
                     |
                     v
            evidence-bound adoption
```

AIR's enterprise promise is not whole-repository conversion. It is lower-risk archaeology and verified replacement at the business-capability boundary. A service can remain partly legacy for years: AIR-managed components and typed foreign components are peers in System v0.2.

## Design principles

1. AIR describes meaning, never framework syntax.
2. Semantic architecture and deployment architecture are separate inputs.
3. Output constraints are explicit and may be strict, preferred, or autonomous in a future planner.
4. Every public representation is versioned.
5. Generated artifacts carry provenance and are incrementally replaceable.
6. Correctness and behavioral equivalence gate optimization.
7. Optimization follows measured bottlenecks rather than language ideology.
8. Mature dependencies remain preferred until replacement has measured value.
9. Discovery evidence and authoritative semantics are separate representations.
10. No unsupported or unexplained side effect is silently promoted into AIR.

## What AIR is not

AIR is not a new web framework, a prompt that emits a repository, an AST for Next.js, or a promise that every application can be represented without target-specific escape hatches. It is an experimental semantic boundary from which multiple implementations can be derived and compared.

## Success measures

- schema and semantic validation precision
- reproducible compilation
- generated-project build and test success
- cross-target contract equivalence
- regeneration stability after small AIR changes
- application semantics preserved when changing targets
- archaeology time saved and unexplained observable behavior reduced
- reviewed capability equivalence across HTTP, state, messages, and outbound calls
- latency, throughput, memory, startup, binary-size, and cost measurements

Lines of generated code are not a success measure.
