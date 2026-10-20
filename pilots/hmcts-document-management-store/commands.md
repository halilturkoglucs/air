# HMCTS typed-extraction command log

The checkout and runtime artifacts are temporary and are never committed.

```bash
git clone https://github.com/hmcts/document-management-store-app.git "$CHECKOUT"
git -C "$CHECKOUT" checkout 0b36d34a265bddc9e97ba39cc1201c95633babe4
git -C "$CHECKOUT" rev-parse HEAD

JAVA_HOME="$(brew --prefix openjdk@25)" "$CHECKOUT/gradlew" -p "$CHECKOUT" test \
  --tests uk.gov.hmcts.dm.config.batch.CaseDocumentsDeletionTaskTest \
  --tests uk.gov.hmcts.dm.service.DocumentMetadataDeletionServiceTest \
  --tests uk.gov.hmcts.dm.service.StoredDocumentServiceTests

air discover spring "$CHECKOUT" --analyzer source --output "$PROOF/source"
air discover spring "$CHECKOUT" --analyzer openrewrite --output "$PROOF/openrewrite"
air workbench "$PROOF/reviewed" --reviewer public-corpus-reviewer

AIR_PILOT_POSTGRES_URL='postgres://…' air evidence capture \
  pilots/hmcts-document-management-store/evidence-profile.example.yaml \
  --output "$PROOF/evidence.jsonl" -- "$CONTROLLED_COMMAND"
air evidence ingest "$PROOF/evidence.jsonl" --discovery "$PROOF/reviewed"
air extract "$PROOF/reviewed" --capability operation:… --output "$PROOF/extracted"
```

The final extraction command is expected to fail until the real capability harness supplies exact failure and retryability evidence. The disposable PostgreSQL container and loopback stubs were removed after the rehearsal.
