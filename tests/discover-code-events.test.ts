import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCodeSeams } from "@air/discovery";

// Patterns from a trial on the OpenTelemetry demo (gRPC services, Kafka, a Valkey cart) and common equivalents.
const files: Record<string, string> = {
  "pb/demo.proto": "syntax = \"proto3\";\nservice CartService {\n    rpc AddItem(AddItemRequest) returns (Empty) {}\n    rpc GetCart(GetCartRequest) returns (Cart) {}\n}\n",
  "checkout/producer.go": "func Create() (sarama.AsyncProducer, error) {\n\treturn sarama.NewAsyncProducer(brokers, config)\n}\n",
  "orders/worker.go": "func run() {\n\tgroup, _ := sarama.NewConsumerGroup(brokers, \"orders\", config)\n\tclient := redis.NewClient(&redis.Options{})\n}\n",
  "accounting/Consumer.cs": "public class Consumer {\n  var consumer = new ConsumerBuilder<string, byte[]>(config).Build();\n  var redis = ConnectionMultiplexer.Connect(url);\n}\n",
  "billing/Listeners.java": "class Listeners {\n  @JmsListener(destination = \"invoices\")\n  void onInvoice(String body) { jmsTemplate.convertAndSend(\"receipts\", body); }\n  @KafkaListener(topics = \"payments\")\n  void onPayment(String body) {}\n  @Cacheable(\"prices\")\n  Price price(String id) { return null; }\n}\n",
  "web/pages/api/cart.ts": "const handler = async (req, res) => res.json({});\nexport default handler;\n",
  "web/queue.ts": "import Redis from 'ioredis';\nconst emails = new Queue('emails');\nnew Worker('emails', async (job) => {});\n",
  "jobs/consume.py": "channel.basic_consume(queue='audit', on_message_callback=handle)\n",
  "load/locustfile.py": "class User(HttpUser):\n    @task\n    def browse(self):\n        self.client.get('/')\n",
  "db/seed.sql": "INSERT INTO products (name) VALUES ('Image from https://example.com');\n",
};

describe("air discover code events, caches, and RPC", () => {
  it("finds gRPC methods, message producers and consumers, caches, and Next.js API routes without false positives", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "air-events-"));
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content); }
    const report = await scanCodeSeams({ root });
    const seams = report.seams.map((seam) => `${seam.kind} ${seam.route ?? seam.name}`);
    expect(seams).toEqual(expect.arrayContaining([
      "rpc /CartService/AddItem", "rpc /CartService/GetCart",
      "consumer orders/worker.go", "consumer accounting/Consumer.cs", "consumer invoices", "consumer payments",
      "http /api/cart", "consumer emails", "consumer audit",
    ]));
    expect(seams.filter((seam) => seam.startsWith("job"))).toEqual([]);
    const effects = [...new Set(report.effects.map((effect) => `${effect.kind} ${effect.name}`))].sort();
    expect(effects).toEqual(["cache prices", "cache redis", "database products", "message emails", "message kafka", "message receipts"]);
  });
});
