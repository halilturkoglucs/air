# Replacement prompt

Write an ordinary TypeScript implementation of the scheduled document-deletion capability. Preserve authentication, service-token, EM-ANNO, EM-NPA, Azure Blob, and PostgreSQL deletion order. Stop after the first dependency failure. EM-NPA failure must expose the successful EM-ANNO effect; blob failure must prevent PostgreSQL deletion. Emit only the harness observation contract and do not import AIR runtime code.
