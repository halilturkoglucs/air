# HMCTS document-deletion typed-extraction pilot

## v0.12 agent-verification proof

The reviewed four-scenario check, strict policy, external-agent prompt/metadata, and ordinary replacement harness are committed. The candidate models success plus EM-ANNO, EM-NPA, and blob failures without importing AIR.

The release harness now executes the pinned upstream `CaseDocumentsDeletionTask`, transactional `StoredDocumentService`, `DocumentMetadataDeletionService`, `EmAnnoService`, and `EmNpaService` classes against isolated PostgreSQL 16. Only the authentication, service-token, EM-ANNO, EM-NPA, Azure Blob, and repository boundaries are controlled. Repository mocks delegate state reads and deletes to real PostgreSQL rows, and Spring's transaction interceptor applies the upstream transaction declaration.

The clean `air check ... --json` gate passed all four scenarios against the ordinary replacement:

- complete success deletes blob and database state after both metadata systems;
- EM-ANNO failure prevents EM-NPA, blob, and database deletion;
- EM-NPA failure preserves the preceding EM-ANNO effect and prevents later deletion;
- blob failure prevents PostgreSQL deletion;
- every observation includes exact ordering, failure identity, and retryability.

Status: v0.12 public-corpus equivalence gate passed. This remains product evidence, not customer adoption evidence.

The corpus is pinned at `0b36d34a265bddc9e97ba39cc1201c95633babe4`. The frozen ground truth described `CaseDocumentsDeletionTask` as a Spring schedule. Source review showed that it is a `Runnable` selected through `TASK_NAME`; the scheduler/deployer binding is external to this repository. The ground-truth file remains immutable and this discrepancy is recorded as an adjudication, not silently rewritten.

AIR now discovers the runtime-selected task, its service/repository call chain, the ordered EM-ANNO then EM-NPA calls, Azure and authentication foreign boundaries, JPA entities, and Flyway tables. The final scan produced 183 nodes and 278 edges. Review of the capability slice through the workbench recorded 12 decisions, including three explicit opaque foreign boundaries.

The upstream targeted suite passed 43 tests: 3 task tests, 9 metadata-deletion tests, and 31 stored-document service tests. Those tests demonstrate success, EM-ANNO short-circuiting, EM-NPA partial external effect, blob-failure suppression of database deletion, and batch continuation behavior.

The capture adapter was separately rehearsed with disposable PostgreSQL 16 and loopback EM-ANNO/EM-NPA stubs. Five privacy-safe records were produced: two exact outbound identities with order, two exact table before/after hashes, and one command outcome. The final check gate then executed the real capability rather than treating that adapter rehearsal as capability evidence.

Typed extraction still stops instead of inventing policy when exact evidence is absent:

```text
em_anno_api.deletedocumentdata: exact failure behavior and retryability evidence are missing
em_npa_api.deleteredactions: exact failure behavior and retryability evidence are missing
```

The live harness now supplies those exact, correlated observations. Reordered, ambiguous, unmatched, or policy-incomplete evidence continues to fail closed in automated AIR tests. AIR stores structural digests in baselines and results rather than the raw document identifiers, database rows, outbound payloads, or credentials used during execution.
