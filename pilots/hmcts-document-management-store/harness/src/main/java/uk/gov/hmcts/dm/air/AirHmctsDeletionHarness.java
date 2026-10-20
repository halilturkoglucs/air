package uk.gov.hmcts.dm.air;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.data.domain.Pageable;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import uk.gov.hmcts.dm.client.EmAnnoApi;
import uk.gov.hmcts.dm.client.EmNpaApi;
import uk.gov.hmcts.dm.config.ToggleConfiguration;
import uk.gov.hmcts.dm.config.batch.CaseDocumentsDeletionTask;
import uk.gov.hmcts.dm.domain.DocumentContentVersion;
import uk.gov.hmcts.dm.domain.StoredDocument;
import uk.gov.hmcts.dm.repository.DocumentContentVersionRepository;
import uk.gov.hmcts.dm.repository.StoredDocumentRepository;
import uk.gov.hmcts.dm.service.BlobStorageDeleteService;
import uk.gov.hmcts.dm.service.BlobStorageWriteService;
import uk.gov.hmcts.dm.service.DocumentMetadataDeletionService;
import uk.gov.hmcts.dm.service.EmAnnoService;
import uk.gov.hmcts.dm.service.EmNpaService;
import uk.gov.hmcts.dm.service.SecurityUtilService;
import uk.gov.hmcts.dm.service.StoredDocumentService;
import uk.gov.hmcts.reform.authorisation.generators.AuthTokenGenerator;
import uk.gov.hmcts.reform.idam.client.IdamClient;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public final class AirHmctsDeletionHarness {
    private static final ObjectMapper JSON = new ObjectMapper();

    private AirHmctsDeletionHarness() {}

    public static void main(String[] args) throws Exception {
        String scenario = args[0];
        UUID documentId = UUID.fromString(args[1]);
        String databaseUrl = requiredEnvironment("AIR_PILOT_POSTGRES_URL");
        String schema = "air_hmcts_" + UUID.randomUUID().toString().replace("-", "");
        List<Map<String, Object>> outbound = new ArrayList<>();

        PGSimpleDataSource dataSource = new PGSimpleDataSource();
        dataSource.setURL(toJdbcUrl(databaseUrl));
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        try {
            jdbc.execute("create schema " + schema);
            jdbc.execute("create table " + schema + ".stored_document (id uuid primary key)");
            jdbc.execute("create table " + schema + ".document_content_version (id uuid primary key, stored_document_id uuid not null references " + schema + ".stored_document(id))");
            UUID contentId = UUID.randomUUID();
            jdbc.update("insert into " + schema + ".stored_document (id) values (?)", documentId);
            jdbc.update("insert into " + schema + ".document_content_version (id, stored_document_id) values (?, ?)", contentId, documentId);

            StoredDocumentRepository storedRepository = storedRepository(jdbc, schema);
            DocumentContentVersionRepository contentRepository = contentRepository(jdbc, schema);
            DocumentMetadataDeletionService metadata = metadataService(scenario, documentId, outbound);
            BlobStorageDeleteService blob = blobService(scenario, documentId, outbound);
            StoredDocumentService target = new StoredDocumentService(
                storedRepository,
                contentRepository,
                mock(ToggleConfiguration.class),
                mock(SecurityUtilService.class),
                mock(BlobStorageWriteService.class),
                blob,
                metadata
            );

            ProxyFactory proxyFactory = new ProxyFactory(target);
            proxyFactory.setProxyTargetClass(true);
            proxyFactory.addAdvice(new TransactionInterceptor(
                new DataSourceTransactionManager(dataSource),
                new AnnotationTransactionAttributeSource()
            ));
            StoredDocumentService transactional = (StoredDocumentService) proxyFactory.getProxy();
            CaseDocumentsDeletionTask task = new CaseDocumentsDeletionTask(transactional, storedRepository);
            ReflectionTestUtils.setField(task, "batchSize", 1);
            ReflectionTestUtils.setField(task, "noOfIterations", 1);
            ReflectionTestUtils.setField(task, "threadLimit", 1);
            ReflectionTestUtils.setField(task, "serviceName", "air-proof");
            task.run();

            boolean deleted = jdbc.queryForObject("select count(*) = 0 from " + schema + ".stored_document where id = ?", Boolean.class, documentId);
            List<Map<String, Object>> failures = failureFor(scenario);
            List<String> ordering = outbound.stream().map(item -> String.valueOf(item.get("operation"))).collect(java.util.stream.Collectors.toCollection(ArrayList::new));
            if (deleted) ordering.add("postgres.delete");
            Map<String, Object> observation = mapOf(
                "database", mapOf("documents", List.of(mapOf("id", documentId.toString(), "deleted", deleted))),
                "outbound", outbound,
                "ordering", ordering,
                "failures", failures,
                "retryability", !failures.isEmpty()
            );
            System.out.println("AIR_OBSERVATION:" + JSON.writeValueAsString(observation));
        } finally {
            try { jdbc.execute("drop schema if exists " + schema + " cascade"); } catch (Exception ignored) { }
        }
    }

    private static StoredDocumentRepository storedRepository(JdbcTemplate jdbc, String schema) {
        StoredDocumentRepository repository = mock(StoredDocumentRepository.class);
        when(repository.findCaseDocumentIdsForDeletion(any(Pageable.class), anyString())).thenAnswer(invocation ->
            jdbc.query("select id from " + schema + ".stored_document order by id", (result, row) -> result.getObject("id", UUID.class))
        );
        doAnswer(invocation -> {
            jdbc.update("delete from " + schema + ".stored_document where id = ?", invocation.getArgument(0, UUID.class));
            return null;
        }).when(repository).deleteById(any(UUID.class));
        return repository;
    }

    private static DocumentContentVersionRepository contentRepository(JdbcTemplate jdbc, String schema) {
        DocumentContentVersionRepository repository = mock(DocumentContentVersionRepository.class);
        when(repository.findAllByStoredDocumentId(any(UUID.class))).thenAnswer(invocation -> {
            UUID storedId = invocation.getArgument(0, UUID.class);
            return jdbc.query("select id from " + schema + ".document_content_version where stored_document_id = ?", (result, row) -> {
                StoredDocument stored = new StoredDocument(storedId);
                DocumentContentVersion version = new DocumentContentVersion();
                version.setId(result.getObject("id", UUID.class));
                version.setStoredDocument(stored);
                return version;
            }, storedId);
        });
        doAnswer(invocation -> {
            @SuppressWarnings("unchecked") Collection<DocumentContentVersion> versions = invocation.getArgument(0, Collection.class);
            for (DocumentContentVersion version : versions) jdbc.update("delete from " + schema + ".document_content_version where id = ?", version.getId());
            return null;
        }).when(repository).deleteAll(any());
        return repository;
    }

    private static DocumentMetadataDeletionService metadataService(String scenario, UUID documentId, List<Map<String, Object>> outbound) {
        IdamClient idam = mock(IdamClient.class);
        when(idam.getAccessToken(anyString(), anyString())).thenAnswer(invocation -> {
            outbound.add(call("idam.authenticate", documentId, 200));
            return "user-token";
        });
        AuthTokenGenerator serviceToken = mock(AuthTokenGenerator.class);
        when(serviceToken.generate()).thenAnswer(invocation -> {
            outbound.add(call("service-token.generate", documentId, 200));
            return "service-token";
        });
        EmAnnoApi annoApi = mock(EmAnnoApi.class);
        when(annoApi.deleteDocumentData(anyString(), anyString(), anyString())).thenAnswer(invocation -> {
            int status = scenario.equals("em-anno-failure") ? 503 : 204;
            outbound.add(call("em-anno.delete", documentId, status));
            return ResponseEntity.status(status).build();
        });
        EmNpaApi npaApi = mock(EmNpaApi.class);
        when(npaApi.deleteRedactions(anyString(), anyString(), anyString())).thenAnswer(invocation -> {
            int status = scenario.equals("em-npa-failure") ? 503 : 204;
            outbound.add(call("em-npa.delete", documentId, status));
            return ResponseEntity.status(status).build();
        });
        return new DocumentMetadataDeletionService(new EmAnnoService(annoApi), new EmNpaService(npaApi), serviceToken, idam, "air-user", "redacted");
    }

    private static BlobStorageDeleteService blobService(String scenario, UUID documentId, List<Map<String, Object>> outbound) {
        BlobStorageDeleteService blob = mock(BlobStorageDeleteService.class);
        doAnswer(invocation -> {
            int status = scenario.equals("blob-failure") ? 503 : 204;
            outbound.add(call("azure-blob.delete", documentId, status));
            if (status != 204) throw new IllegalStateException("Controlled blob deletion failure");
            return null;
        }).when(blob).deleteCaseDocumentBinary(any(DocumentContentVersion.class));
        return blob;
    }

    private static List<Map<String, Object>> failureFor(String scenario) {
        return switch (scenario) {
            case "em-anno-failure" -> List.of(failure("em-anno.delete"));
            case "em-npa-failure" -> List.of(failure("em-npa.delete"));
            case "blob-failure" -> List.of(failure("azure-blob.delete"));
            default -> List.of();
        };
    }

    private static Map<String, Object> failure(String operation) {
        return mapOf("operation", operation, "code", "dependency-unavailable", "retryable", true);
    }

    private static Map<String, Object> call(String operation, UUID documentId, int status) {
        return mapOf("operation", operation, "documentId", documentId.toString(), "status", status);
    }

    private static String requiredEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }

    private static String toJdbcUrl(String value) {
        if (value.startsWith("jdbc:")) return value;
        URI uri = URI.create(value);
        String userInfo = uri.getUserInfo();
        String query = userInfo == null ? "" : "?user=" + userInfo.replace(":", "&password=");
        return "jdbc:postgresql://" + uri.getHost() + ":" + (uri.getPort() < 0 ? 5432 : uri.getPort()) + uri.getPath() + query;
    }

    private static Map<String, Object> mapOf(Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < values.length; index += 2) result.put(String.valueOf(values[index]), values[index + 1]);
        return result;
    }
}
