# AIR schemas

The public application schemas are [`air-0.1.schema.json`](../packages/air-schema/schema/air-0.1.schema.json) through [`air-0.9.schema.json`](../packages/air-schema/schema/air-0.9.schema.json). System and Deployment documents have separate v0.1 schemas. AIR YAML is a human-friendly serialization of these JSON data models.

## Versioning

Every document declares:

```yaml
apiVersion: air.dev/v0.9
kind: Application
```

Breaking semantic or structural changes require a new `apiVersion`. Parsers must reject unknown versions rather than guessing. Package versions and AIR schema versions are related but independent.

The parser accepts v0.1 through v0.9. New documents should use v0.9. `air migrate` upgrades older applications without inventing asynchronous behavior; the v0.9 sections remain absent until explicitly authored.

## Top-level model

```yaml
apiVersion: air.dev/v0.9
kind: Application
metadata:
  name: example
spec:
  entities: {}
  http:
    operations: []
```

All objects are closed: unknown properties fail validation. This prevents misspellings from silently changing meaning and keeps target concepts out of the semantic model.

## Complex services in v0.9

Applications can declare versioned domain or integration events, point-to-point tasks, command `emits` and `enqueues` effects, durable consumers, UTC schedules, derived cached reads, and authenticated realtime channels. Payload mappings may read command input, the written record, the principal, or a literal. Semantic validation resolves every contract, command, event, task, operation, and invalidation reference.

Every transported message uses the same envelope: `id`, `type`, `schemaVersion`, `occurredAt`, `producer`, `correlationId`, optional `causationId` and `orderingKey`, and `payload`. Delivery is at least once. Generated persistence uses a transactional outbox and durable consumer inbox; cross-system exactly-once delivery is intentionally not promised.

Cached reads are derived from a declared canonical HTTP read. They specify TTL, maximum staleness, invalidating events, and `canonical-source` fallback. Cache data is never authoritative. Realtime channels declare subscriptions, client-command mappings, WebSocket/SSE transports, cursor resume, and bounded overflow behavior.

## System and Deployment documents

`air.dev/system/v0.1` joins multiple applications into named API, worker, scheduler, realtime, and orchestrator components. Logical channels connect event/task sources to consumers. Durable saga definitions support invoke, publish, wait, and delay steps with timeouts, retries, compensation, correlation, and terminal outcomes.

`air.dev/deployment/v0.1` binds those logical resources to explicit providers and a deployment profile. Provider configuration stays out of application semantics. Plugins are named and version-locked; AIR never scans arbitrary installed packages. Supported first-party bindings are Kafka-compatible brokers (including Redpanda), RabbitMQ, PostgreSQL outbox/inbox queues, PostgreSQL persistence, and Redis derived caches.

## Identity, generation and nullability in v0.2

Every v0.2 entity declares exactly one `primaryKey`. Supported primary-key types are `string`, `uuid`, and `integer`.

```yaml
id:
  type: uuid
  primaryKey: true
  generated: uuid
createdAt:
  type: datetime
  generated: created-at
status:
  type: string
  default: pending
```

`required` means the field must be present in an API input when it has no default or generator. `nullable` controls whether stored values may be null. Generated and defaulted values are omitted from generated create-input requirements.

## Entities and fields

Entity and field names use language-neutral identifiers. v0.1 supports `string`, `integer`, `number`, `boolean`, `uuid`, `date`, `datetime`, and `json`.

Fields may be required and may declare string, numeric, pattern, or enum constraints. Semantic validation rejects constraints that do not apply to the field type.

```yaml
entities:
  Todo:
    fields:
      id:
        type: uuid
        required: true
      title:
        type: string
        required: true
        validation:
          minLength: 1
          maxLength: 200
```

## Relationships

Relationships have a target and cardinality. Optional inverse references make a bidirectional relation explicit. Targets and inverses must resolve to declared entities and relationships.

AIR v0.2 owning relationships (`many-to-one` and `one-to-one`) declare `sourceField` and `targetField`. The fields must exist, have matching primitive types, and reference a primary or unique target field. A `one-to-many` relationship names its owning inverse rather than duplicating the foreign key.

```yaml
customer:
  target: Customer
  cardinality: many-to-one
  inverse: orders
  sourceField: customerId
  targetField: id
  onDelete: restrict
```

Supported cardinalities are `one-to-one`, `one-to-many`, `many-to-one`, and `many-to-many`. Delete behavior can be `restrict`, `cascade`, or `set-null`. These are semantic intentions; an adapter chooses a target-specific implementation or reports incompatibility.

## Commands and contracts in v0.3

Commands define behavior independently from HTTP. The v0.3 subset deliberately supports one executable shape: a named input contract, an entity output projection, declared errors, optional existence guards, and a create effect.

```yaml
contracts:
  PlaceOrderInput:
    fields:
      customerId: { type: uuid, required: true }
      total:
        type: number
        required: true
        validation: { minimum: 0.01 }

commands:
  placeOrder:
    input: PlaceOrderInput
    output:
      entity: Order
      fields: [id, customerId, status, total]
    errors:
      CUSTOMER_NOT_FOUND:
        status: 404
        message: Customer not found.
        retryable: false
    guards:
      - kind: exists
        entity: Customer
        field: id
        value: { input: customerId }
        error: CUSTOMER_NOT_FOUND
    effect:
      kind: create
      entity: Order
      values:
        customerId: { input: customerId }
        total: { input: total }
```

Contract fields are closed and use AIR primitive types and validation rules. Semantic validation proves that guard and effect references exist and have matching types, every guard names a declared error, the output fields exist, and the create effect supplies all non-null fields that lack a generator or default.

## HTTP operations

An HTTP operation connects a transport contract to one entity and one CRUD action:

```yaml
- id: createTodo
  method: POST
  path: /todos
  entity: Todo
  action: create
```

The available actions are `create`, `read`, `update`, `delete`, and `list`. v0.1 does not yet model request/response shapes, authorization, errors, pagination, workflows, transactions, or arbitrary domain commands.

AIR v0.3 can expose a command through transport without making HTTP part of the command itself:

```yaml
- id: placeOrder
  method: POST
  path: /orders/place
  command: placeOrder
```

The current Next.js target accepts POST command routes without path parameters. That is a target capability of the first slice, not a permanent restriction encoded into domain behavior.

## Transactional state transitions in v0.4

An update effect identifies exactly one row through a primary or unique field, checks typed preconditions, and applies assignments. Numeric fields can be incremented relative to their stored value.

```yaml
markOrderPaid:
  input: MarkOrderPaidInput
  output:
    entity: Order
    fields: [id, status, version]
  errors:
    ORDER_NOT_FOUND: { status: 404, message: Order not found. }
    ORDER_NOT_PENDING: { status: 409, message: Only pending orders can be marked paid. }
    VERSION_CONFLICT:
      status: 409
      message: Order was changed by another request.
      retryable: true
  transaction:
    isolation: serializable
    conflictError: VERSION_CONFLICT
  effect:
    kind: update
    entity: Order
    identify:
      field: id
      value: { input: orderId }
      error: ORDER_NOT_FOUND
    preconditions:
      - field: status
        equals: { literal: pending }
        error: ORDER_NOT_PENDING
      - field: version
        equals: { input: expectedVersion }
        error: VERSION_CONFLICT
    values:
      status: { literal: paid }
      version: { increment: 1 }
```

Allowed isolation values are `read-committed`, `repeatable-read`, and `serializable`. Update commands must declare isolation and a conflict error. Semantic validation requires a unique selector, required and type-compatible input references, valid literal types, declared errors, mutable target fields, and numeric increment targets.

## Principals and command ownership in v0.5

Principals are closed typed claim contracts. Command authorization names one principal, one declared 401 error, and one or more ownership rules whose failure uses a declared 403 error.

```yaml
principals:
  CustomerPrincipal:
    fields:
      customerId: { type: uuid, required: true }

commands:
  markOrderPaid:
    # input, output, errors, transaction, and effect omitted
    authorization:
      principal: CustomerPrincipal
      unauthenticatedError: UNAUTHENTICATED
      rules:
        - kind: record-field-equals-principal
          field: customerId
          principalField: customerId
          error: FORBIDDEN
```

`input-equals-principal` compares a required command input with a required principal field. `record-field-equals-principal` compares a field on the update effect's selected record. Semantic validation proves that references and types match and that authentication/authorization errors use status 401/403 respectively. AIR does not define JWTs, sessions, cookies, or an identity provider.

## Invariant expressions in v0.6

An invariant has a boolean condition and one declared domain error. Conditions compose comparisons with `all`, `any`, and `not`:

```yaml
invariants:
  - condition:
      all:
        - left: { input: total }
          operator: greater-than
          right: { literal: 0 }
        - not:
            left: { input: total }
            operator: greater-than
            right: { principal: maximumOrderTotal }
    error: ORDER_LIMIT_EXCEEDED
```

Comparison operators are `equals`, `not-equals`, `greater-than`, `greater-than-or-equal`, `less-than`, and `less-than-or-equal`. Operands may use `input`, `record`, `principal`, or `literal`. Ordered comparisons are limited to non-null integer and number operands; JSON comparison is intentionally unsupported. Input and principal operands must be required fields, principal operands require command authorization, and record operands currently require an update effect. Expression nesting is limited to 12 levels.

## Atomic multi-record effects and idempotency in v0.7

Named effects select multiple records by unique fields, lock them, check per-record preconditions, and apply updates before the primary effect. Invariants can reference any selected record by effect name. Numeric assignments can increment or decrement by a literal or input field.

```yaml
effects:
  debitSource:
    kind: update
    entity: Account
    identify:
      field: id
      value: { input: fromAccountId }
      error: SOURCE_NOT_FOUND
    preconditions:
      - field: version
        equals: { input: expectedFromVersion }
        error: VERSION_CONFLICT
    values:
      balance: { decrement: { input: amount } }
      version: { increment: 1 }
  creditDestination:
    kind: update
    entity: Account
    identify:
      field: id
      value: { input: toAccountId }
      error: DESTINATION_NOT_FOUND
    values:
      balance: { increment: { input: amount } }
      version: { increment: 1 }
effect:
  kind: create
  entity: Transfer
  values:
    id: { input: transferId }
    amount: { input: amount }
```

Record operands use `{ record: { effect: debitSource, field: balance } }`. Record ownership rules may similarly name `effect: debitSource`.

Idempotency declares a required input key, a unique field on the output entity, and a principal-scoped output field. `mode: replay` means an existing scoped result is returned without reapplying effects. `transaction.retry.maxAttempts` is bounded from 1 to 10; targets must either implement compatible retry behavior or reject the command.

The current named-effect subset intentionally requires update effects followed by one primary create effect. This represents ledger-style atomic mutation without introducing target-specific transaction syntax.

## Deliberate omissions

The schemas contain no `nextjs`, `react`, `prisma`, `spring`, `rust`, `vercel`, file path, class, controller, or package-manager concept. Those belong in target options, deployment constraints, or adapters.
