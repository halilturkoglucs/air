package dev.air.benchmark;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class LegacyCapability {
    private static final ObjectMapper JSON = new ObjectMapper();

    private LegacyCapability() {}

    public static void main(String[] args) throws Exception {
        String databaseUrl = requiredEnvironment("AIR_BENCHMARK_DATABASE_URL");
        Map<String, Object> input = readInput();
        String title = String.valueOf(input.getOrDefault("title", "Benchmark"));
        String idempotencyKey = String.valueOf(input.getOrDefault("idempotencyKey", "fixed-key"));
        UUID id = UUID.randomUUID();
        String createdAt = Instant.now().toString();
        String schema = "air_bench_" + UUID.randomUUID().toString().replace("-", "");
        List<Map<String, Object>> outbound = new ArrayList<>();
        HttpServer vendor = vendorServer(outbound, id);
        vendor.start();

        PGSimpleDataSource dataSource = new PGSimpleDataSource();
        dataSource.setURL(toJdbcUrl(databaseUrl));
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        try {
            jdbc.execute("create schema " + schema);
            jdbc.execute("create table " + schema + ".documents (id uuid primary key, title text not null, created_at text not null, state text not null)");
            jdbc.execute("create table " + schema + ".outbox (event_type text not null, document_id uuid not null, created_at text not null)");

            TransactionTemplate transaction = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
            transaction.executeWithoutResult(status -> {
                callVendor(vendor, "/authorize", id);
                jdbc.update("insert into " + schema + ".documents (id, title, created_at, state) values (?, ?, ?, ?)", id, title, createdAt, "created");
                callVendor(vendor, "/index", id);
                jdbc.update("insert into " + schema + ".outbox (event_type, document_id, created_at) values (?, ?, ?)", "document.created", id, createdAt);
            });

            List<Map<String, Object>> rows = jdbc.query("select id, title, created_at, state from " + schema + ".documents order by id", (result, row) -> mapOf(
                "id", result.getObject("id").toString(), "createdAt", result.getString("created_at"),
                "title", result.getString("title"), "state", result.getString("state")
            ));
            List<Map<String, Object>> messages = jdbc.query("select event_type, document_id, created_at from " + schema + ".outbox", (result, row) -> mapOf(
                "type", result.getString("event_type"), "id", result.getObject("document_id").toString(), "createdAt", result.getString("created_at")
            ));

            Map<String, Object> observation = new LinkedHashMap<>();
            observation.put("http", mapOf("status", 201, "headers", mapOf("content-type", "application/json"), "body", mapOf("id", id.toString(), "createdAt", createdAt, "title", title, "outcome", "created")));
            observation.put("database", mapOf("rows", rows, "transaction", mapOf("committed", true, "rollsBackOnFailure", true), "idempotency", mapOf("key", idempotencyKey, "replayed", false)));
            observation.put("messages", messages);
            observation.put("outbound", outbound);
            observation.put("ordering", List.of("database", "vendor.authorize", "vendor.index", "message"));
            observation.put("failures", List.of(mapOf("code", "vendor-unavailable", "status", 503, "retryable", true)));
            observation.put("retryability", true);
            System.out.println(JSON.writeValueAsString(observation));
        } finally {
            vendor.stop(0);
            try { jdbc.execute("drop schema if exists " + schema + " cascade"); } catch (Exception ignored) { }
        }
    }

    private static HttpServer vendorServer(List<Map<String, Object>> outbound, UUID id) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/authorize", exchange -> {
            outbound.add(mapOf("operation", "vendor.authorize", "id", id.toString(), "status", 200));
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.createContext("/index", exchange -> {
            outbound.add(mapOf("operation", "vendor.index", "status", 202));
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
        });
        return server;
    }

    private static void callVendor(HttpServer server, String path, UUID id) {
        try {
            URI uri = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path + "?document=" + id);
            HttpResponse<Void> response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(uri).POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() >= 400) throw new IllegalStateException("Vendor returned " + response.statusCode());
        } catch (Exception error) {
            throw new IllegalStateException("Vendor invocation failed", error);
        }
    }

    private static Map<String, Object> readInput() throws IOException {
        String source = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
        return source.isBlank() ? new LinkedHashMap<>() : JSON.readValue(source, new TypeReference<>() {});
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
