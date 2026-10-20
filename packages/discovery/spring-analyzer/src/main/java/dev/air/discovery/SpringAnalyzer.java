package dev.air.discovery;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.openrewrite.InMemoryExecutionContext;
import org.openrewrite.SourceFile;
import org.openrewrite.java.JavaIsoVisitor;
import org.openrewrite.java.JavaParser;
import org.openrewrite.java.tree.J;

public final class SpringAnalyzer {
  private record Finding(String path, int line, String kind, String name, String semantic, String annotation) {}

  private static final Map<String, String> CLASS_ANNOTATIONS = Map.ofEntries(
      Map.entry("RestController", "service"), Map.entry("Controller", "service"),
      Map.entry("Service", "service"), Map.entry("Component", "service"),
      Map.entry("Configuration", "configuration"), Map.entry("ConfigurationProperties", "configuration"),
      Map.entry("Entity", "entity"), Map.entry("Repository", "repository"),
      Map.entry("FeignClient", "vendor-call"), Map.entry("Mapper", "mapper"));
  private static final Map<String, String> METHOD_ANNOTATIONS = Map.ofEntries(
      Map.entry("GetMapping", "endpoint"), Map.entry("PostMapping", "endpoint"), Map.entry("PutMapping", "endpoint"),
      Map.entry("PatchMapping", "endpoint"), Map.entry("DeleteMapping", "endpoint"), Map.entry("RequestMapping", "endpoint"),
      Map.entry("QueryMapping", "endpoint"), Map.entry("MutationMapping", "endpoint"), Map.entry("SubscriptionMapping", "endpoint"),
      Map.entry("KafkaListener", "listener"), Map.entry("RabbitListener", "listener"), Map.entry("EventListener", "listener"),
      Map.entry("TransactionalEventListener", "listener"),
      Map.entry("Scheduled", "schedule"), Map.entry("Transactional", "transaction"), Map.entry("Query", "query"),
      Map.entry("Cacheable", "cache"), Map.entry("CachePut", "cache"), Map.entry("CacheEvict", "cache"),
      Map.entry("Bean", "configuration"),
      Map.entry("PreAuthorize", "security"), Map.entry("Secured", "security"), Map.entry("RolesAllowed", "security"));
  private static final Pattern TEST_SOURCE = Pattern.compile("(^|.*/)src/(?:test|[^/]*test|it)(?:/|$)", Pattern.CASE_INSENSITIVE);

  private static boolean hasAnnotation(J.ClassDeclaration declaration, String... names) {
    for (var annotation : declaration.getLeadingAnnotations()) {
      for (String name : names) if (annotation.getSimpleName().equals(name)) return true;
    }
    return false;
  }

  private static String escape(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
  }

  private static String json(Finding finding) {
    return "{\"path\":\"" + escape(finding.path()) + "\",\"line\":" + finding.line() + ",\"kind\":\"" + finding.kind()
        + "\",\"name\":\"" + escape(finding.name()) + "\",\"semantic\":\"" + finding.semantic()
        + "\",\"annotation\":\"" + escape(finding.annotation()) + "\"}";
  }

  private static List<Finding> analyze(Path root, Path file, JavaParser parser) throws IOException {
    String source = Files.readString(file, StandardCharsets.UTF_8);
    List<SourceFile> parsed = parser.parse(source).toList();
    List<Finding> findings = new ArrayList<>();
    Map<String, Integer> annotationOffsets = new HashMap<>();
    String relative = root.relativize(file).toString().replace('\\', '/');
    for (SourceFile sourceFile : parsed) {
      if (!(sourceFile instanceof J.CompilationUnit unit)) continue;
      new JavaIsoVisitor<Void>() {
        @Override public J.ClassDeclaration visitClassDeclaration(J.ClassDeclaration declaration, Void unused) {
          declaration.getLeadingAnnotations().forEach(annotation -> {
            String simple = annotation.getSimpleName();
            String kind = CLASS_ANNOTATIONS.get(simple);
            if (kind != null) findings.add(new Finding(relative, annotationLine(source, annotation.printTrimmed(), simple, annotationOffsets), kind, declaration.getSimpleName(), "class", simple));
          });
          return super.visitClassDeclaration(declaration, unused);
        }
        @Override public J.MethodDeclaration visitMethodDeclaration(J.MethodDeclaration declaration, Void unused) {
          J.ClassDeclaration owner = getCursor().firstEnclosing(J.ClassDeclaration.class);
          declaration.getLeadingAnnotations().forEach(annotation -> {
            String simple = annotation.getSimpleName();
            String kind = METHOD_ANNOTATIONS.get(simple);
            if ("endpoint".equals(kind) && (owner == null || !hasAnnotation(owner, "RestController", "Controller"))) return;
            if (kind != null) findings.add(new Finding(relative, annotationLine(source, annotation.printTrimmed(), simple, annotationOffsets), kind, declaration.getSimpleName(), "method", simple));
          });
          return super.visitMethodDeclaration(declaration, unused);
        }
      }.visit(unit, null);
    }
    return findings;
  }

  private static int annotationLine(String source, String rendered, String simple, Map<String, Integer> offsets) {
    int from = offsets.getOrDefault(simple, 0);
    int offset = source.indexOf(rendered.trim(), from);
    if (offset < 0) {
      Matcher matcher = Pattern.compile("@(?:[\\w$]+\\.)*" + Pattern.quote(simple) + "\\b").matcher(source);
      offset = matcher.find(from) ? matcher.start() : -1;
    }
    if (offset < 0) return 1;
    offsets.put(simple, offset + 1);
    return 1 + (int) source.substring(0, offset).chars().filter(character -> character == '\n').count();
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 1) { System.err.println("Usage: air-spring-analyzer <repository>"); System.exit(2); }
    Path root = Path.of(args[0]).toAbsolutePath().normalize();
    JavaParser parser = JavaParser.fromJavaVersion().logCompilationWarningsAndErrors(true).build();
    List<Finding> findings = new ArrayList<>();
    try (Stream<Path> paths = Files.walk(root)) {
      for (Path file : paths.filter(path -> path.toString().endsWith(".java"))
          .filter(path -> !isTestSource(root.relativize(path)))
          .sorted(Comparator.comparing(Path::toString)).toList()) {
        try { findings.addAll(analyze(root, file, parser)); }
        catch (Exception error) { System.err.println(relative(root, file) + ": " + error.getMessage()); }
      }
    }
    findings.stream().sorted(Comparator.comparing(Finding::path).thenComparingInt(Finding::line).thenComparing(Finding::kind)).map(SpringAnalyzer::json).forEach(System.out::println);
  }

  private static boolean isTestSource(Path relative) {
    String path = relative.toString().replace('\\', '/');
    return TEST_SOURCE.matcher(path).find();
  }

  private static String relative(Path root, Path path) { return root.relativize(path).toString().replace('\\', '/'); }
}
