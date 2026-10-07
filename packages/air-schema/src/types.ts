export const AIR_API_VERSION_V0_1 = "air.dev/v0.1" as const;
export const AIR_API_VERSION_V0_2 = "air.dev/v0.2" as const;
export const AIR_API_VERSION_V0_3 = "air.dev/v0.3" as const;
export const AIR_API_VERSION_V0_4 = "air.dev/v0.4" as const;
export const AIR_API_VERSION_V0_5 = "air.dev/v0.5" as const;
export const AIR_API_VERSION_V0_6 = "air.dev/v0.6" as const;
export const AIR_API_VERSION_V0_7 = "air.dev/v0.7" as const;
export const AIR_API_VERSION_V0_8 = "air.dev/v0.8" as const;
export const AIR_API_VERSION = AIR_API_VERSION_V0_8;
export const AIR_KIND = "Application" as const;

export type AirApiVersion =
  | typeof AIR_API_VERSION_V0_1
  | typeof AIR_API_VERSION_V0_2
  | typeof AIR_API_VERSION_V0_3
  | typeof AIR_API_VERSION_V0_4
  | typeof AIR_API_VERSION_V0_5
  | typeof AIR_API_VERSION_V0_6
  | typeof AIR_API_VERSION_V0_7
  | typeof AIR_API_VERSION_V0_8;
export type AirKind = typeof AIR_KIND;

export type PrimitiveType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "uuid"
  | "date"
  | "datetime"
  | "json";

export type ConstraintValue = string | number | boolean | null;
export type GeneratedValue = "uuid" | "auto-increment" | "created-at" | "updated-at";

export interface FieldValidation {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly ConstraintValue[];
}

export interface FieldDefinition {
  readonly type: PrimitiveType;
  readonly description?: string;
  readonly required?: boolean;
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly unique?: boolean;
  readonly generated?: GeneratedValue;
  readonly default?: ConstraintValue;
  readonly validation?: FieldValidation;
}

export type RelationshipCardinality =
  | "one-to-one"
  | "one-to-many"
  | "many-to-one"
  | "many-to-many";

export type RelationshipDeleteBehavior = "restrict" | "cascade" | "set-null";

export interface RelationshipDefinition {
  readonly target: string;
  readonly cardinality: RelationshipCardinality;
  readonly description?: string;
  readonly required?: boolean;
  readonly inverse?: string;
  readonly sourceField?: string;
  readonly targetField?: string;
  readonly onDelete?: RelationshipDeleteBehavior;
}

export interface EntityDefinition {
  readonly description?: string;
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  readonly relationships?: Readonly<Record<string, RelationshipDefinition>>;
}

export interface ContractFieldDefinition {
  readonly type: PrimitiveType;
  readonly description?: string;
  readonly required?: boolean;
  readonly nullable?: boolean;
  readonly validation?: FieldValidation;
}

export interface ContractDefinition {
  readonly description?: string;
  readonly fields: Readonly<Record<string, ContractFieldDefinition>>;
}

export interface PrincipalDefinition extends ContractDefinition {}

export interface CommandErrorDefinition {
  readonly status: number;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface CommandInputReference {
  readonly input: string;
}

export interface CommandLiteralReference {
  readonly literal: ConstraintValue;
}

export interface CommandIncrementReference {
  readonly increment: number | CommandInputReference;
}

export interface CommandDecrementReference {
  readonly decrement: number | CommandInputReference;
}

export type CommandValueReference = CommandInputReference | CommandLiteralReference;
export type CommandAssignment =
  | CommandValueReference
  | CommandIncrementReference
  | CommandDecrementReference;

export interface CommandExistsGuard {
  readonly kind: "exists";
  readonly entity: string;
  readonly field: string;
  readonly value: CommandInputReference;
  readonly error: string;
}

export interface CommandCreateEffect {
  readonly kind: "create";
  readonly entity: string;
  readonly values: Readonly<Record<string, CommandValueReference>>;
}

export interface CommandUpdateSelector {
  readonly field: string;
  readonly value: CommandValueReference;
  readonly error: string;
}

export interface CommandPrecondition {
  readonly field: string;
  readonly equals: CommandValueReference;
  readonly error: string;
}

export interface CommandUpdateEffect {
  readonly kind: "update";
  readonly entity: string;
  readonly identify: CommandUpdateSelector;
  readonly preconditions?: readonly CommandPrecondition[];
  readonly values: Readonly<Record<string, CommandAssignment>>;
}

export interface CommandDeleteEffect {
  readonly kind: "delete";
  readonly entity: string;
  readonly identify: CommandUpdateSelector;
  readonly preconditions?: readonly CommandPrecondition[];
}

export type CommandEffect = CommandCreateEffect | CommandUpdateEffect | CommandDeleteEffect;

export type TransactionIsolation = "read-committed" | "repeatable-read" | "serializable";

export interface CommandTransactionDefinition {
  readonly isolation: TransactionIsolation;
  readonly conflictError?: string;
  readonly retry?: {
    readonly maxAttempts: number;
  };
}

export interface InputEqualsPrincipalRule {
  readonly kind: "input-equals-principal";
  readonly input: string;
  readonly principalField: string;
  readonly error: string;
}

export interface RecordFieldEqualsPrincipalRule {
  readonly kind: "record-field-equals-principal";
  readonly effect?: string;
  readonly field: string;
  readonly principalField: string;
  readonly error: string;
}

export interface PrincipalFieldInRule {
  readonly kind: "principal-field-in";
  readonly principalField: string;
  readonly values: readonly string[];
  readonly error: string;
}

export type AuthorizationRule =
  | InputEqualsPrincipalRule
  | RecordFieldEqualsPrincipalRule
  | PrincipalFieldInRule;

export interface CommandAuthorizationDefinition {
  readonly principal: string;
  readonly unauthenticatedError: string;
  readonly rules: readonly AuthorizationRule[];
}

export interface InvariantInputOperand {
  readonly input: string;
}

export interface InvariantRecordOperand {
  readonly record: string | { readonly effect: string; readonly field: string };
}

export interface InvariantPrincipalOperand {
  readonly principal: string;
}

export type InvariantOperand =
  | InvariantInputOperand
  | InvariantRecordOperand
  | InvariantPrincipalOperand
  | CommandLiteralReference;

export type InvariantComparisonOperator =
  | "equals"
  | "not-equals"
  | "greater-than"
  | "greater-than-or-equal"
  | "less-than"
  | "less-than-or-equal";

export interface InvariantComparisonExpression {
  readonly left: InvariantOperand;
  readonly operator: InvariantComparisonOperator;
  readonly right: InvariantOperand;
}

export interface InvariantAllExpression {
  readonly all: readonly InvariantExpression[];
}

export interface InvariantAnyExpression {
  readonly any: readonly InvariantExpression[];
}

export interface InvariantNotExpression {
  readonly not: InvariantExpression;
}

export type InvariantExpression =
  | InvariantComparisonExpression
  | InvariantAllExpression
  | InvariantAnyExpression
  | InvariantNotExpression;

export interface CommandInvariantDefinition {
  readonly condition: InvariantExpression;
  readonly error: string;
}

export interface CommandIdempotencyDefinition {
  readonly input: string;
  readonly entity: string;
  readonly field: string;
  readonly scopePrincipalField: string;
  readonly scopeField: string;
  readonly mode: "replay";
}

export interface CommandOutputDefinition {
  readonly entity: string;
  readonly fields: readonly string[];
}

export interface CommandDefinition {
  readonly description?: string;
  readonly input: string;
  readonly output: CommandOutputDefinition;
  readonly errors?: Readonly<Record<string, CommandErrorDefinition>>;
  readonly guards?: readonly CommandExistsGuard[];
  readonly transaction?: CommandTransactionDefinition;
  readonly authorization?: CommandAuthorizationDefinition;
  readonly invariants?: readonly CommandInvariantDefinition[];
  readonly effects?: Readonly<Record<string, CommandUpdateEffect>>;
  readonly idempotency?: CommandIdempotencyDefinition;
  readonly effect: CommandEffect;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type CrudAction = "create" | "read" | "update" | "delete" | "list";

export interface CrudHttpOperation {
  readonly id: string;
  readonly description?: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly entity: string;
  readonly action: CrudAction;
  readonly authorization?: CrudAuthorizationDefinition;
  readonly collection?: CollectionDefinition;
}

export interface CrudPrincipalFieldInRule {
  readonly kind: "principal-field-in";
  readonly principalField: string;
  readonly values: readonly string[];
}

export interface CrudAuthorizationDefinition {
  readonly principal: string;
  readonly rules: readonly CrudPrincipalFieldInRule[];
}

export interface CollectionFilterDefinition {
  readonly parameter: string;
  readonly field: string;
  readonly operator: "equals";
}

export interface CollectionDefinition {
  readonly pagination?: {
    readonly defaultLimit: number;
    readonly maxLimit: number;
  };
  readonly filters?: readonly CollectionFilterDefinition[];
  readonly orderBy?: readonly {
    readonly field: string;
    readonly direction: "asc" | "desc";
  }[];
}

export interface CommandHttpOperation {
  readonly id: string;
  readonly description?: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly command: string;
}

export type HttpOperation = CrudHttpOperation | CommandHttpOperation;

export interface HttpDefinition {
  readonly operations: readonly HttpOperation[];
}

export interface ApplicationMetadata {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
}

export interface ApplicationSpec {
  readonly entities: Readonly<Record<string, EntityDefinition>>;
  readonly contracts?: Readonly<Record<string, ContractDefinition>>;
  readonly principals?: Readonly<Record<string, PrincipalDefinition>>;
  readonly commands?: Readonly<Record<string, CommandDefinition>>;
  readonly http?: HttpDefinition;
}

export interface AirDocument {
  readonly apiVersion: AirApiVersion;
  readonly kind: AirKind;
  readonly metadata: ApplicationMetadata;
  readonly spec: ApplicationSpec;
}

export type AirDocumentV0_1 = AirDocument & { readonly apiVersion: typeof AIR_API_VERSION_V0_1 };
export type AirDocumentV0_2 = AirDocument & { readonly apiVersion: typeof AIR_API_VERSION_V0_2 };
export type AirDocumentV0_3 = AirDocument & { readonly apiVersion: typeof AIR_API_VERSION_V0_3 };
export type AirDocumentV0_4 = AirDocument & { readonly apiVersion: typeof AIR_API_VERSION_V0_4 };
export type AirDocumentV0_5 = AirDocument & { readonly apiVersion: typeof AIR_API_VERSION_V0_5 };
export type AirDocumentV0_6 = AirDocument & { readonly apiVersion: typeof AIR_API_VERSION_V0_6 };
export type AirDocumentV0_7 = AirDocument & { readonly apiVersion: typeof AIR_API_VERSION_V0_7 };
export type AirDocumentV0_8 = AirDocument & { readonly apiVersion: typeof AIR_API_VERSION_V0_8 };
