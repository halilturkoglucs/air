# HMCTS document-deletion typed-extraction pilot

## v0.12 agent-verification reset

The reviewed four-scenario check, strict policy, external-agent prompt/metadata, and ordinary replacement harness are now committed. The candidate models success plus EM-ANNO, EM-NPA, and blob failures without importing AIR.

This is **not yet an equivalence proof**. A clean content-addressed baseline cannot be created until the pinned legacy capability is executed against disposable PostgreSQL and controlled IdAM/token/EM-ANNO/EM-NPA/blob stubs. AIR therefore remains at the preview boundary and 0.12.0 must not be published from this material alone.

Status: implementation rehearsal complete; v0.12 release gate remains blocked.

The corpus is pinned at `0b36d34a265bddc9e97ba39cc1201c95633babe4`. The frozen ground truth described `CaseDocumentsDeletionTask` as a Spring schedule. Source review showed that it is a `Runnable` selected through `TASK_NAME`; the scheduler/deployer binding is external to this repository. The ground-truth file remains immutable and this discrepancy is recorded as an adjudication, not silently rewritten.

AIR now discovers the runtime-selected task, its service/repository call chain, the ordered EM-ANNO then EM-NPA calls, Azure and authentication foreign boundaries, JPA entities, and Flyway tables. The final scan produced 183 nodes and 278 edges. Review of the capability slice through the workbench recorded 12 decisions, including three explicit opaque foreign boundaries.

The upstream targeted suite passed 43 tests: 3 task tests, 9 metadata-deletion tests, and 31 stored-document service tests. Those tests demonstrate success, EM-ANNO short-circuiting, EM-NPA partial external effect, blob-failure suppression of database deletion, and batch continuation behavior.

The new capture adapter was separately rehearsed with disposable PostgreSQL 16 and loopback EM-ANNO/EM-NPA stubs. Five privacy-safe records were produced: two exact outbound identities with order, two exact table before/after hashes, and one command outcome. All four semantic observations matched uniquely; the command record correctly remained unmatched. This was adapter validation, not execution of the HMCTS capability, so it is not accepted as capability evidence.

Extraction now stops instead of inventing policy:

```text
em_anno_api.deletedocumentdata: exact failure behavior and retryability evidence are missing
em_npa_api.deleteredactions: exact failure behavior and retryability evidence are missing
```

v0.12.0 therefore remains unreleased. The remaining gate is a controlled harness that executes the real capability and emits exact, correlated success/failure observations—including retryability, ordering, blob effects, and PostgreSQL state—for every required scenario. Reordered, ambiguous, unmatched, or policy-incomplete evidence already blocks extraction in automated AIR tests.
