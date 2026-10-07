import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import {
  AIR_SCHEMA_V0_1,
  AIR_SCHEMA_V0_2,
  AIR_SCHEMA_V0_3,
  AIR_SCHEMA_V0_4,
  AIR_SCHEMA_V0_5,
  AIR_SCHEMA_V0_6,
  AIR_SCHEMA_V0_7,
  AIR_SCHEMA_V0_8,
  AIR_API_VERSION_V0_1,
  AIR_API_VERSION_V0_2,
  AIR_API_VERSION_V0_3,
  AIR_API_VERSION_V0_4,
  AIR_API_VERSION_V0_5,
  AIR_API_VERSION_V0_6,
  AIR_API_VERSION_V0_7,
  AIR_API_VERSION_V0_8,
  type AirDocument,
  type ConstraintValue,
  type ContractFieldDefinition,
  type CommandValueReference,
  type FieldDefinition,
  type InvariantExpression,
  type InvariantOperand,
  type PrimitiveType,
} from "@air/schema";

export type ValidationIssueKind = "schema" | "semantic";

export interface ValidationIssue {
  readonly kind: ValidationIssueKind;
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly valid: true; readonly document: AirDocument; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchemaV0_1 = ajv.compile<AirDocument>(AIR_SCHEMA_V0_1);
const validateSchemaV0_2 = ajv.compile<AirDocument>(AIR_SCHEMA_V0_2);
const validateSchemaV0_3 = ajv.compile<AirDocument>(AIR_SCHEMA_V0_3);
const validateSchemaV0_4 = ajv.compile<AirDocument>(AIR_SCHEMA_V0_4);
const validateSchemaV0_5 = ajv.compile<AirDocument>(AIR_SCHEMA_V0_5);
const validateSchemaV0_6 = ajv.compile<AirDocument>(AIR_SCHEMA_V0_6);
const validateSchemaV0_7 = ajv.compile<AirDocument>(AIR_SCHEMA_V0_7);
const validateSchemaV0_8 = ajv.compile<AirDocument>(AIR_SCHEMA_V0_8);

function schemaIssue(error: ErrorObject): ValidationIssue {
  const property =
    error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string"
      ? `/${error.params.additionalProperty}`
      : "";

  return {
    kind: "schema",
    path: `${error.instancePath}${property}` || "/",
    code: `schema.${error.keyword}`,
    message: error.message ?? "does not satisfy the AIR schema",
  };
}

function semanticIssue(path: string, code: string, message: string): ValidationIssue {
  return { kind: "semantic", path, code, message };
}

function enumValueMatchesField(field: FieldDefinition | ContractFieldDefinition, value: ConstraintValue): boolean {
  if (value === null) return field.nullable === true;
  if (field.type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (field.type === "number") return typeof value === "number";
  if (field.type === "boolean") return typeof value === "boolean";
  return typeof value === "string";
}

function scalarValueMatchesField(field: FieldDefinition | ContractFieldDefinition, value: ConstraintValue): boolean {
  return enumValueMatchesField(field, value);
}

function validateFieldConstraints(
  entityName: string,
  fieldName: string,
  field: FieldDefinition | ContractFieldDefinition,
  root = "/spec/entities",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const constraints = field.validation;
  if (!constraints) return issues;

  const basePath = `${root}/${entityName}/fields/${fieldName}/validation`;
  const stringLike = ["string", "uuid", "date", "datetime"].includes(field.type);
  const numeric = field.type === "integer" || field.type === "number";

  if (!stringLike &&
      (constraints.minLength !== undefined ||
        constraints.maxLength !== undefined ||
        constraints.pattern !== undefined)) {
    issues.push(
      semanticIssue(
        basePath,
        "field.string_constraint_type",
        `String constraints cannot be applied to a ${field.type} field.`,
      ),
    );
  }

  if (!numeric && (constraints.minimum !== undefined || constraints.maximum !== undefined)) {
    issues.push(
      semanticIssue(
        basePath,
        "field.numeric_constraint_type",
        `Numeric constraints cannot be applied to a ${field.type} field.`,
      ),
    );
  }

  if (
    constraints.minLength !== undefined &&
    constraints.maxLength !== undefined &&
    constraints.minLength > constraints.maxLength
  ) {
    issues.push(
      semanticIssue(basePath, "field.length_range", "minLength must not exceed maxLength."),
    );
  }

  if (
    constraints.minimum !== undefined &&
    constraints.maximum !== undefined &&
    constraints.minimum > constraints.maximum
  ) {
    issues.push(
      semanticIssue(basePath, "field.numeric_range", "minimum must not exceed maximum."),
    );
  }

  if (constraints.pattern !== undefined) {
    try {
      new RegExp(constraints.pattern);
    } catch {
      issues.push(
        semanticIssue(`${basePath}/pattern`, "field.invalid_pattern", "pattern must be a valid regular expression."),
      );
    }
  }

  if (constraints.enum?.some((value) => !enumValueMatchesField(field, value))) {
    issues.push(
      semanticIssue(
        `${basePath}/enum`,
        "field.enum_type",
        `Every enum value must match field type ${field.type}.`,
      ),
    );
  }

  return issues;
}

function validateSemantics(document: AirDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const entityNames = new Set(Object.keys(document.spec.entities));
  const explicitDataSemantics =
    document.apiVersion === AIR_API_VERSION_V0_2 ||
    document.apiVersion === AIR_API_VERSION_V0_3 ||
    document.apiVersion === AIR_API_VERSION_V0_4 ||
    document.apiVersion === AIR_API_VERSION_V0_5 ||
    document.apiVersion === AIR_API_VERSION_V0_6 ||
    document.apiVersion === AIR_API_VERSION_V0_7 ||
    document.apiVersion === AIR_API_VERSION_V0_8;

  for (const [entityName, entity] of Object.entries(document.spec.entities)) {
    if (explicitDataSemantics) {
      const primaryKeys = Object.entries(entity.fields).filter(([, field]) => field.primaryKey === true);
      if (primaryKeys.length !== 1) {
        issues.push(
          semanticIssue(
            `/spec/entities/${entityName}/fields`,
            "entity.primary_key_count",
            `AIR v0.2+ entities must declare exactly one primary key; ${entityName} declares ${primaryKeys.length}.`,
          ),
        );
      }
    }

    for (const [fieldName, field] of Object.entries(entity.fields)) {
      issues.push(...validateFieldConstraints(entityName, fieldName, field));
      const fieldPath = `/spec/entities/${entityName}/fields/${fieldName}`;

      if (field.primaryKey && field.nullable) {
        issues.push(
          semanticIssue(fieldPath, "field.primary_key_nullable", "A primary key cannot be nullable."),
        );
      }
      if (field.primaryKey && !["string", "uuid", "integer"].includes(field.type)) {
        issues.push(
          semanticIssue(
            `${fieldPath}/type`,
            "field.primary_key_type",
            "A primary key must use string, uuid, or integer.",
          ),
        );
      }
      if (field.default !== undefined && !scalarValueMatchesField(field, field.default)) {
        issues.push(
          semanticIssue(
            `${fieldPath}/default`,
            "field.default_type",
            `Default value must match field type ${field.type}${field.nullable ? " or be null" : ""}.`,
          ),
        );
      }
      if (field.generated !== undefined && field.default !== undefined) {
        issues.push(
          semanticIssue(
            fieldPath,
            "field.generated_default_conflict",
            "A field cannot declare both generated and default.",
          ),
        );
      }
      const expectedGeneratedType = {
        uuid: "uuid",
        "auto-increment": "integer",
        "created-at": "datetime",
        "updated-at": "datetime",
      } as const;
      if (field.generated && field.type !== expectedGeneratedType[field.generated]) {
        issues.push(
          semanticIssue(
            `${fieldPath}/generated`,
            "field.generated_type",
            `${field.generated} generation requires field type ${expectedGeneratedType[field.generated]}.`,
          ),
        );
      }
    }

    for (const [relationshipName, relationship] of Object.entries(entity.relationships ?? {})) {
      const path = `/spec/entities/${entityName}/relationships/${relationshipName}`;
      if (!entityNames.has(relationship.target)) {
        issues.push(
          semanticIssue(
            `${path}/target`,
            "relationship.unknown_target",
            `Relationship target ${relationship.target} does not name a declared entity.`,
          ),
        );
        continue;
      }

      if (relationship.inverse !== undefined) {
        const target = document.spec.entities[relationship.target];
        if (target && !(relationship.inverse in (target.relationships ?? {}))) {
          issues.push(
            semanticIssue(
              `${path}/inverse`,
              "relationship.unknown_inverse",
              `Inverse relationship ${relationship.target}.${relationship.inverse} is not declared.`,
            ),
          );
        } else if (target) {
          const inverse = target.relationships?.[relationship.inverse];
          if (inverse && inverse.target !== entityName) {
            issues.push(
              semanticIssue(
                `${path}/inverse`,
                "relationship.inverse_target",
                `Inverse relationship ${relationship.target}.${relationship.inverse} must target ${entityName}.`,
              ),
            );
          }
        }
      }

      if (explicitDataSemantics) {
        const ownsForeignKey =
          relationship.cardinality === "many-to-one" || relationship.cardinality === "one-to-one";
        if (ownsForeignKey && (!relationship.sourceField || !relationship.targetField)) {
          issues.push(
            semanticIssue(
              path,
              "relationship.foreign_key_fields_required",
              `${relationship.cardinality} relationships require sourceField and targetField.`,
            ),
          );
        }
        if (!ownsForeignKey && relationship.sourceField !== undefined) {
          issues.push(
            semanticIssue(
              `${path}/sourceField`,
              "relationship.foreign_key_on_inverse",
              `${relationship.cardinality} is an inverse or join relationship and cannot own sourceField directly.`,
            ),
          );
        }
        if (relationship.cardinality === "one-to-many" && relationship.inverse === undefined) {
          issues.push(
            semanticIssue(
              `${path}/inverse`,
              "relationship.inverse_required",
              "A one-to-many relationship must identify its owning inverse relationship.",
            ),
          );
        }

        const sourceField = relationship.sourceField
          ? entity.fields[relationship.sourceField]
          : undefined;
        const targetEntity = document.spec.entities[relationship.target];
        const targetField = relationship.targetField
          ? targetEntity?.fields[relationship.targetField]
          : undefined;
        if (relationship.sourceField && !sourceField) {
          issues.push(
            semanticIssue(
              `${path}/sourceField`,
              "relationship.unknown_source_field",
              `${entityName}.${relationship.sourceField} is not declared.`,
            ),
          );
        }
        if (relationship.targetField && !targetField) {
          issues.push(
            semanticIssue(
              `${path}/targetField`,
              "relationship.unknown_target_field",
              `${relationship.target}.${relationship.targetField} is not declared.`,
            ),
          );
        }
        if (sourceField && targetField && sourceField.type !== targetField.type) {
          issues.push(
            semanticIssue(
              path,
              "relationship.field_type_mismatch",
              `Foreign-key types differ: ${sourceField.type} does not match ${targetField.type}.`,
            ),
          );
        }
        if (targetField && !targetField.primaryKey && !targetField.unique) {
          issues.push(
            semanticIssue(
              `${path}/targetField`,
              "relationship.target_not_unique",
              "A foreign key must reference a primary or unique field.",
            ),
          );
        }
        if (relationship.cardinality === "one-to-one" && sourceField && !sourceField.unique) {
          issues.push(
            semanticIssue(
              `${path}/sourceField`,
              "relationship.one_to_one_not_unique",
              "A one-to-one relationship source field must be unique.",
            ),
          );
        }
        if (relationship.onDelete === "set-null" && sourceField && !sourceField.nullable) {
          issues.push(
            semanticIssue(
              `${path}/onDelete`,
              "relationship.set_null_non_nullable",
              "set-null requires a nullable source field.",
            ),
          );
        }
      }
    }
  }

  if (
    document.apiVersion === AIR_API_VERSION_V0_3 ||
    document.apiVersion === AIR_API_VERSION_V0_4 ||
    document.apiVersion === AIR_API_VERSION_V0_5 ||
    document.apiVersion === AIR_API_VERSION_V0_6 ||
    document.apiVersion === AIR_API_VERSION_V0_7 ||
    document.apiVersion === AIR_API_VERSION_V0_8
  ) {
    const contracts = document.spec.contracts ?? {};
    const principals = document.spec.principals ?? {};
    const commands = document.spec.commands ?? {};

    for (const [contractName, contract] of Object.entries(contracts)) {
      for (const [fieldName, field] of Object.entries(contract.fields)) {
        issues.push(...validateFieldConstraints(contractName, fieldName, field, "/spec/contracts"));
      }
    }

    for (const [principalName, principal] of Object.entries(principals)) {
      if (contracts[principalName]) {
        issues.push(
          semanticIssue(
            `/spec/principals/${principalName}`,
            "principal.contract_name_collision",
            `Principal ${principalName} collides with a request contract of the same name.`,
          ),
        );
      }
      for (const [fieldName, field] of Object.entries(principal.fields)) {
        issues.push(...validateFieldConstraints(principalName, fieldName, field, "/spec/principals"));
      }
    }

    for (const [commandName, command] of Object.entries(commands)) {
      const path = `/spec/commands/${commandName}`;
      const input = contracts[command.input];
      const errors = command.errors ?? {};
      const requireError = (
        errorCode: string,
        errorPath: string,
        code = "command.unknown_error",
      ): void => {
        if (!errors[errorCode]) {
          issues.push(
            semanticIssue(
              errorPath,
              code,
              `Error ${errorCode} is not declared by command ${commandName}.`,
            ),
          );
        }
      };
      const validateReference = (
        reference: CommandValueReference,
        targetField: FieldDefinition | undefined,
        referencePath: string,
      ): void => {
        if ("input" in reference) {
          const inputField = input?.fields[reference.input];
          if (!inputField) {
            issues.push(
              semanticIssue(
                `${referencePath}/input`,
                "command.unknown_input_field",
                `${command.input}.${reference.input} is not declared.`,
              ),
            );
          } else {
            if (!inputField.required) {
              issues.push(
                semanticIssue(
                  `${referencePath}/input`,
                  "command.optional_input_reference",
                  `Command behavior cannot depend on optional input ${command.input}.${reference.input}.`,
                ),
              );
            }
            if (targetField && targetField.type !== inputField.type) {
              issues.push(
                semanticIssue(
                  referencePath,
                  "command.reference_type_mismatch",
                  `Input type ${inputField.type} does not match target type ${targetField.type}.`,
                ),
              );
            }
          }
        } else if (targetField) {
          if (targetField.type === "json" || !scalarValueMatchesField(targetField, reference.literal)) {
            issues.push(
              semanticIssue(
                `${referencePath}/literal`,
                "command.literal_type_mismatch",
                `Literal value must match target type ${targetField.type}; JSON values must come from a typed input contract.`,
              ),
            );
          }
        }
      };
      type ResolvedInvariantOperand = {
        readonly type: PrimitiveType | "null";
        readonly nullable: boolean;
        readonly field?: FieldDefinition | ContractFieldDefinition;
        readonly literal?: ConstraintValue;
      };
      const resolveInvariantOperand = (
        operand: InvariantOperand,
        operandPath: string,
      ): ResolvedInvariantOperand | undefined => {
        if ("input" in operand) {
          const field = input?.fields[operand.input];
          if (!field) {
            issues.push(
              semanticIssue(
                `${operandPath}/input`,
                "invariant.unknown_input_field",
                `${command.input}.${operand.input} is not declared.`,
              ),
            );
            return undefined;
          }
          if (!field.required) {
            issues.push(
              semanticIssue(
                `${operandPath}/input`,
                "invariant.optional_input_field",
                "Invariant expressions cannot depend on an optional input field.",
              ),
            );
          }
          return { type: field.type, nullable: field.nullable === true, field };
        }
        if ("record" in operand) {
          const recordReference =
            typeof operand.record === "string"
              ? { effect: undefined, field: operand.record }
              : operand.record;
          const selectedEffect = recordReference.effect
            ? command.effects?.[recordReference.effect]
            : command.effect.kind === "update" || command.effect.kind === "delete"
              ? command.effect
              : undefined;
          if (!selectedEffect) {
            issues.push(
              semanticIssue(
                `${operandPath}/record`,
                "invariant.record_requires_update",
                recordReference.effect
                  ? `Record operand references unknown update effect ${recordReference.effect}.`
                  : "Record operands require the primary effect to be an update.",
              ),
            );
            return undefined;
          }
          const field = document.spec.entities[selectedEffect.entity]?.fields[recordReference.field];
          if (!field) {
            issues.push(
              semanticIssue(
                `${operandPath}/record`,
                "invariant.unknown_record_field",
                `${selectedEffect.entity}.${recordReference.field} is not declared.`,
              ),
            );
            return undefined;
          }
          return { type: field.type, nullable: field.nullable === true, field };
        }
        if ("principal" in operand) {
          const authorization = command.authorization;
          if (!authorization) {
            issues.push(
              semanticIssue(
                `${operandPath}/principal`,
                "invariant.principal_requires_authorization",
                "Principal operands require command authorization.",
              ),
            );
            return undefined;
          }
          const field = principals[authorization.principal]?.fields[operand.principal];
          if (!field) {
            issues.push(
              semanticIssue(
                `${operandPath}/principal`,
                "invariant.unknown_principal_field",
                `${authorization.principal}.${operand.principal} is not declared.`,
              ),
            );
            return undefined;
          }
          if (!field.required) {
            issues.push(
              semanticIssue(
                `${operandPath}/principal`,
                "invariant.optional_principal_field",
                "Invariant expressions cannot depend on an optional principal field.",
              ),
            );
          }
          return { type: field.type, nullable: field.nullable === true, field };
        }
        const literalType: PrimitiveType | "null" =
          operand.literal === null
            ? "null"
            : typeof operand.literal === "boolean"
              ? "boolean"
              : typeof operand.literal === "number"
                ? Number.isInteger(operand.literal)
                  ? "integer"
                  : "number"
                : "string";
        return { type: literalType, nullable: operand.literal === null, literal: operand.literal };
      };
      const numericType = (type: PrimitiveType | "null"): boolean =>
        type === "integer" || type === "number";
      const compatibleInvariantOperands = (
        left: ResolvedInvariantOperand,
        right: ResolvedInvariantOperand,
      ): boolean => {
        if (left.literal !== undefined || left.type === "null") {
          if (right.field) return scalarValueMatchesField(right.field, left.literal ?? null);
        }
        if (right.literal !== undefined || right.type === "null") {
          if (left.field) return scalarValueMatchesField(left.field, right.literal ?? null);
        }
        return left.type === right.type || (numericType(left.type) && numericType(right.type));
      };
      const validateInvariantExpression = (
        expression: InvariantExpression,
        expressionPath: string,
        depth = 0,
      ): void => {
        if (depth > 12) {
          issues.push(
            semanticIssue(
              expressionPath,
              "invariant.expression_depth",
              "Invariant expressions may be nested at most 12 levels deep.",
            ),
          );
          return;
        }
        if ("all" in expression) {
          for (const [index, child] of expression.all.entries()) {
            validateInvariantExpression(child, `${expressionPath}/all/${index}`, depth + 1);
          }
          return;
        }
        if ("any" in expression) {
          for (const [index, child] of expression.any.entries()) {
            validateInvariantExpression(child, `${expressionPath}/any/${index}`, depth + 1);
          }
          return;
        }
        if ("not" in expression) {
          validateInvariantExpression(expression.not, `${expressionPath}/not`, depth + 1);
          return;
        }
        const left = resolveInvariantOperand(expression.left, `${expressionPath}/left`);
        const right = resolveInvariantOperand(expression.right, `${expressionPath}/right`);
        if (!left || !right) return;
        if (left.type === "json" || right.type === "json") {
          issues.push(
            semanticIssue(
              expressionPath,
              "invariant.json_operand_unsupported",
              "JSON comparison is not portable enough for an invariant expression.",
            ),
          );
          return;
        }
        if (!compatibleInvariantOperands(left, right)) {
          issues.push(
            semanticIssue(
              expressionPath,
              "invariant.operand_type_mismatch",
              `Invariant operands ${left.type} and ${right.type} are not type-compatible.`,
            ),
          );
        }
        if (expression.operator !== "equals" && expression.operator !== "not-equals") {
          if (!numericType(left.type) || !numericType(right.type)) {
            issues.push(
              semanticIssue(
                `${expressionPath}/operator`,
                "invariant.ordered_comparison_type",
                "Ordered comparisons require integer or number operands.",
              ),
            );
          }
          if (left.nullable || right.nullable) {
            issues.push(
              semanticIssue(
                expressionPath,
                "invariant.ordered_comparison_nullable",
                "Ordered comparisons cannot use nullable operands.",
              ),
            );
          }
        }
      };
      if (!input) {
        issues.push(
          semanticIssue(
            `${path}/input`,
            "command.unknown_input_contract",
            `Command input ${command.input} does not name a declared contract.`,
          ),
        );
      }

      const authorization = command.authorization;
      if (authorization) {
        const principal = principals[authorization.principal];
        if (!principal) {
          issues.push(
            semanticIssue(
              `${path}/authorization/principal`,
              "authorization.unknown_principal",
              `Principal ${authorization.principal} is not declared.`,
            ),
          );
        }
        requireError(
          authorization.unauthenticatedError,
          `${path}/authorization/unauthenticatedError`,
          "authorization.unknown_unauthenticated_error",
        );
        const unauthenticated = errors[authorization.unauthenticatedError];
        if (unauthenticated && unauthenticated.status !== 401) {
          issues.push(
            semanticIssue(
              `${path}/authorization/unauthenticatedError`,
              "authorization.unauthenticated_status",
              "The unauthenticated error must use HTTP status 401.",
            ),
          );
        }

        for (const [index, rule] of authorization.rules.entries()) {
          const rulePath = `${path}/authorization/rules/${index}`;
          const principalField = principal?.fields[rule.principalField];
          if (!principalField) {
            issues.push(
              semanticIssue(
                `${rulePath}/principalField`,
                "authorization.unknown_principal_field",
                `${authorization.principal}.${rule.principalField} is not declared.`,
              ),
            );
          } else if (!principalField.required) {
            issues.push(
              semanticIssue(
                `${rulePath}/principalField`,
                "authorization.optional_principal_field",
                "Authorization cannot depend on an optional principal field.",
              ),
            );
          }

          if (rule.kind === "input-equals-principal") {
            const inputField = input?.fields[rule.input];
            if (!inputField) {
              issues.push(
                semanticIssue(
                  `${rulePath}/input`,
                  "authorization.unknown_input_field",
                  `${command.input}.${rule.input} is not declared.`,
                ),
              );
            } else if (!inputField.required) {
              issues.push(
                semanticIssue(
                  `${rulePath}/input`,
                  "authorization.optional_input_field",
                  "Authorization cannot depend on an optional input field.",
                ),
              );
            } else if (principalField && inputField.type !== principalField.type) {
              issues.push(
                semanticIssue(
                  rulePath,
                  "authorization.field_type_mismatch",
                  `Input type ${inputField.type} does not match principal type ${principalField.type}.`,
                ),
              );
            }
          } else if (rule.kind === "record-field-equals-principal") {
            const selectedEffect = rule.effect
              ? command.effects?.[rule.effect]
              : command.effect.kind === "update" || command.effect.kind === "delete"
                ? command.effect
                : undefined;
            const recordField = selectedEffect
              ? document.spec.entities[selectedEffect.entity]?.fields[rule.field]
              : undefined;
            if (!selectedEffect) {
              issues.push(
                semanticIssue(
                  `${rulePath}/${rule.effect ? "effect" : "kind"}`,
                  "authorization.record_rule_requires_update",
                  rule.effect
                    ? `Authorization references unknown update effect ${rule.effect}.`
                    : "Record-field authorization requires the primary effect to be an update.",
                ),
              );
            }
            if (!recordField) {
              issues.push(
                semanticIssue(
                  `${rulePath}/field`,
                  "authorization.unknown_record_field",
                  `${selectedEffect?.entity ?? rule.effect ?? command.effect.entity}.${rule.field} is not declared.`,
                ),
              );
            } else if (principalField && recordField.type !== principalField.type) {
              issues.push(
                semanticIssue(
                  rulePath,
                  "authorization.field_type_mismatch",
                  `Record type ${recordField.type} does not match principal type ${principalField.type}.`,
                ),
              );
            }
          } else if (principalField) {
            if (principalField.type !== "string") {
              issues.push(
                semanticIssue(
                  `${rulePath}/principalField`,
                  "authorization.principal_membership_type",
                  "Principal membership rules require a string field.",
                ),
              );
            }
            const allowed = principalField.validation?.enum;
            if (allowed && rule.values.some((value) => !allowed.includes(value))) {
              issues.push(
                semanticIssue(
                  `${rulePath}/values`,
                  "authorization.principal_membership_value",
                  "Every allowed role or scope must be permitted by the principal field enum.",
                ),
              );
            }
          }

          requireError(rule.error, `${rulePath}/error`, "authorization.unknown_forbidden_error");
          const forbidden = errors[rule.error];
          if (forbidden && forbidden.status !== 403) {
            issues.push(
              semanticIssue(
                `${rulePath}/error`,
                "authorization.forbidden_status",
                "Authorization rule errors must use HTTP status 403.",
              ),
            );
          }
        }
      }

      for (const [index, invariant] of (command.invariants ?? []).entries()) {
        const invariantPath = `${path}/invariants/${index}`;
        validateInvariantExpression(invariant.condition, `${invariantPath}/condition`);
        requireError(invariant.error, `${invariantPath}/error`, "invariant.unknown_error");
      }

      const outputEntity = document.spec.entities[command.output.entity];
      if (!outputEntity) {
        issues.push(
          semanticIssue(
            `${path}/output/entity`,
            "command.unknown_output_entity",
            `Command output entity ${command.output.entity} is not declared.`,
          ),
        );
      } else {
        for (const [index, fieldName] of command.output.fields.entries()) {
          if (!outputEntity.fields[fieldName]) {
            issues.push(
              semanticIssue(
                `${path}/output/fields/${index}`,
                "command.unknown_output_field",
                `${command.output.entity}.${fieldName} is not declared.`,
              ),
            );
          }
        }
      }

      const effectEntity = document.spec.entities[command.effect.entity];
      if (!effectEntity) {
        issues.push(
          semanticIssue(
            `${path}/effect/entity`,
            "command.unknown_effect_entity",
            `Command effect entity ${command.effect.entity} is not declared.`,
          ),
        );
      }
      if (command.output.entity !== command.effect.entity) {
        issues.push(
          semanticIssue(
            `${path}/output/entity`,
            "command.output_effect_mismatch",
            "A command must output the entity changed by its effect.",
          ),
        );
      }

      for (const [targetFieldName, assignment] of Object.entries(
        command.effect.kind === "delete" ? {} : command.effect.values,
      )) {
        const assignmentPath = `${path}/effect/values/${targetFieldName}`;
        const targetField = effectEntity?.fields[targetFieldName];
        if (!targetField) {
          issues.push(
            semanticIssue(
              assignmentPath,
              "command.unknown_effect_field",
              `${command.effect.entity}.${targetFieldName} is not declared.`,
            ),
          );
          continue;
        }
        if (targetField.generated || (targetField.primaryKey && command.effect.kind === "update")) {
          issues.push(
            semanticIssue(
              assignmentPath,
              "command.generated_effect_field",
              `Command effects cannot assign generated or primary field ${targetFieldName}.`,
            ),
          );
        }
        if ("increment" in assignment || "decrement" in assignment) {
          const operation = "increment" in assignment ? "increment" : "decrement";
          const amount = "increment" in assignment ? assignment.increment : assignment.decrement;
          if (command.effect.kind !== "update" || !["integer", "number"].includes(targetField.type)) {
            issues.push(
              semanticIssue(
                `${assignmentPath}/${operation}`,
                "command.increment_type",
                "Numeric change assignments require an update effect and an integer or number field.",
              ),
            );
          }
          if (typeof amount === "number" && targetField.type === "integer" && !Number.isInteger(amount)) {
            issues.push(
              semanticIssue(
                `${assignmentPath}/${operation}`,
                "command.increment_integer",
                "An integer field must be changed by an integer value.",
              ),
            );
          }
          if (typeof amount !== "number") {
            validateReference(amount, targetField, `${assignmentPath}/${operation}`);
          }
          if (targetField.nullable) {
            issues.push(
              semanticIssue(
                `${assignmentPath}/${operation}`,
                "command.increment_nullable",
                "A nullable field cannot be changed numerically and deterministically.",
              ),
            );
          }
        } else {
          validateReference(assignment, targetField, assignmentPath);
        }
      }

      if (effectEntity && command.effect.kind === "create") {
        for (const [fieldName, field] of Object.entries(effectEntity.fields)) {
          const supplied = fieldName in command.effect.values;
          const generatedOrDefaulted = field.generated !== undefined || field.default !== undefined;
          if (!field.nullable && !generatedOrDefaulted && !supplied) {
            issues.push(
              semanticIssue(
                `${path}/effect/values`,
                "command.missing_required_effect_field",
                `Create effect must supply required field ${command.effect.entity}.${fieldName}.`,
              ),
            );
          }
        }
      }

      if (command.effect.kind === "update" || command.effect.kind === "delete") {
        const identifyPath = `${path}/effect/identify`;
        const identifyField = effectEntity?.fields[command.effect.identify.field];
        if (!identifyField) {
          issues.push(
            semanticIssue(
              `${identifyPath}/field`,
              "command.unknown_identify_field",
              `${command.effect.entity}.${command.effect.identify.field} is not declared.`,
            ),
          );
        } else if (!identifyField.primaryKey && !identifyField.unique) {
          issues.push(
            semanticIssue(
              `${identifyPath}/field`,
              "command.identify_not_unique",
              "An update or delete command must identify its record through a primary or unique field.",
            ),
          );
        } else if (identifyField.nullable) {
          issues.push(
            semanticIssue(
              `${identifyPath}/field`,
              "command.identify_nullable",
              "An update selector must use a non-null identity field.",
            ),
          );
        }
        validateReference(command.effect.identify.value, identifyField, `${identifyPath}/value`);
        requireError(command.effect.identify.error, `${identifyPath}/error`);

        for (const [index, precondition] of (command.effect.preconditions ?? []).entries()) {
          const preconditionPath = `${path}/effect/preconditions/${index}`;
          const preconditionField = effectEntity?.fields[precondition.field];
          if (!preconditionField) {
            issues.push(
              semanticIssue(
                `${preconditionPath}/field`,
                "command.unknown_precondition_field",
                `${command.effect.entity}.${precondition.field} is not declared.`,
              ),
            );
          } else if (preconditionField.type === "json") {
            issues.push(
              semanticIssue(
                `${preconditionPath}/field`,
                "command.json_precondition_unsupported",
                "JSON equality is not portable enough for a command precondition.",
              ),
            );
          }
          validateReference(precondition.equals, preconditionField, `${preconditionPath}/equals`);
          requireError(precondition.error, `${preconditionPath}/error`);
        }

        if (!command.transaction) {
          issues.push(
            semanticIssue(
              `${path}/transaction`,
              "command.update_transaction_required",
              "Update and delete commands must declare transaction isolation.",
            ),
          );
        } else if (!command.transaction.conflictError) {
          issues.push(
            semanticIssue(
              `${path}/transaction/conflictError`,
              "command.conflict_error_required",
              "Update and delete commands must declare the error used for concurrent conflicts.",
            ),
          );
        }
      }

      for (const [effectName, effect] of Object.entries(command.effects ?? {})) {
        const effectPath = `${path}/effects/${effectName}`;
        if (effectName === "result") {
          issues.push(
            semanticIssue(effectPath, "command.reserved_effect_name", "Named effect result is reserved for the primary effect."),
          );
        }
        const namedEntity = document.spec.entities[effect.entity];
        if (!namedEntity) {
          issues.push(
            semanticIssue(
              `${effectPath}/entity`,
              "command.unknown_effect_entity",
              `Named effect entity ${effect.entity} is not declared.`,
            ),
          );
          continue;
        }
        const identifyField = namedEntity.fields[effect.identify.field];
        if (!identifyField) {
          issues.push(
            semanticIssue(
              `${effectPath}/identify/field`,
              "command.unknown_identify_field",
              `${effect.entity}.${effect.identify.field} is not declared.`,
            ),
          );
        } else if (!identifyField.primaryKey && !identifyField.unique) {
          issues.push(
            semanticIssue(
              `${effectPath}/identify/field`,
              "command.identify_not_unique",
              "A named update must identify its record through a primary or unique field.",
            ),
          );
        } else if (identifyField.nullable) {
          issues.push(
            semanticIssue(
              `${effectPath}/identify/field`,
              "command.identify_nullable",
              "A named update selector must use a non-null identity field.",
            ),
          );
        }
        validateReference(effect.identify.value, identifyField, `${effectPath}/identify/value`);
        requireError(effect.identify.error, `${effectPath}/identify/error`);

        for (const [index, precondition] of (effect.preconditions ?? []).entries()) {
          const preconditionPath = `${effectPath}/preconditions/${index}`;
          const field = namedEntity.fields[precondition.field];
          if (!field) {
            issues.push(
              semanticIssue(
                `${preconditionPath}/field`,
                "command.unknown_precondition_field",
                `${effect.entity}.${precondition.field} is not declared.`,
              ),
            );
          } else if (field.type === "json") {
            issues.push(
              semanticIssue(
                `${preconditionPath}/field`,
                "command.json_precondition_unsupported",
                "JSON equality is not portable enough for a command precondition.",
              ),
            );
          }
          validateReference(precondition.equals, field, `${preconditionPath}/equals`);
          requireError(precondition.error, `${preconditionPath}/error`);
        }

        for (const [fieldName, assignment] of Object.entries(effect.values)) {
          const assignmentPath = `${effectPath}/values/${fieldName}`;
          const field = namedEntity.fields[fieldName];
          if (!field) {
            issues.push(
              semanticIssue(
                assignmentPath,
                "command.unknown_effect_field",
                `${effect.entity}.${fieldName} is not declared.`,
              ),
            );
            continue;
          }
          if (field.generated || field.primaryKey) {
            issues.push(
              semanticIssue(
                assignmentPath,
                "command.generated_effect_field",
                `Named updates cannot assign generated or primary field ${fieldName}.`,
              ),
            );
          }
          if ("increment" in assignment || "decrement" in assignment) {
            const operation = "increment" in assignment ? "increment" : "decrement";
            const amount = "increment" in assignment ? assignment.increment : assignment.decrement;
            if (!["integer", "number"].includes(field.type)) {
              issues.push(
                semanticIssue(
                  `${assignmentPath}/${operation}`,
                  "command.increment_type",
                  "Numeric change assignments require an integer or number field.",
                ),
              );
            }
            if (typeof amount === "number" && field.type === "integer" && !Number.isInteger(amount)) {
              issues.push(
                semanticIssue(
                  `${assignmentPath}/${operation}`,
                  "command.increment_integer",
                  "An integer field must be changed by an integer value.",
                ),
              );
            }
            if (typeof amount !== "number") {
              validateReference(amount, field, `${assignmentPath}/${operation}`);
            }
            if (field.nullable) {
              issues.push(
                semanticIssue(
                  `${assignmentPath}/${operation}`,
                  "command.increment_nullable",
                  "A nullable field cannot be changed numerically and deterministically.",
                ),
              );
            }
          } else {
            validateReference(assignment, field, assignmentPath);
          }
        }
      }

      if (Object.keys(command.effects ?? {}).length > 0) {
        if (!command.transaction) {
          issues.push(
            semanticIssue(
              `${path}/transaction`,
              "command.multi_effect_transaction_required",
              "Commands with named effects must declare transaction isolation.",
            ),
          );
        } else if (!command.transaction.conflictError) {
          issues.push(
            semanticIssue(
              `${path}/transaction/conflictError`,
              "command.conflict_error_required",
              "Commands with named effects must declare a concurrent-conflict error.",
            ),
          );
        }
      }

      if (command.idempotency) {
        const idempotencyPath = `${path}/idempotency`;
        const idempotencyEntity = document.spec.entities[command.idempotency.entity];
        const keyInput = input?.fields[command.idempotency.input];
        const keyField = idempotencyEntity?.fields[command.idempotency.field];
        const principal = command.authorization
          ? principals[command.authorization.principal]
          : undefined;
        const scopePrincipal = principal?.fields[command.idempotency.scopePrincipalField];
        const scopeField = idempotencyEntity?.fields[command.idempotency.scopeField];
        if (!command.authorization) {
          issues.push(
            semanticIssue(
              idempotencyPath,
              "idempotency.authorization_required",
              "Scoped idempotency replay requires an authenticated principal.",
            ),
          );
        }
        if (!idempotencyEntity) {
          issues.push(
            semanticIssue(
              `${idempotencyPath}/entity`,
              "idempotency.unknown_entity",
              `Idempotency entity ${command.idempotency.entity} is not declared.`,
            ),
          );
        } else if (command.output.entity !== command.idempotency.entity) {
          issues.push(
            semanticIssue(
              `${idempotencyPath}/entity`,
              "idempotency.output_entity_mismatch",
              "Replay idempotency must use the command output entity.",
            ),
          );
        }
        if (!keyInput || !keyInput.required) {
          issues.push(
            semanticIssue(
              `${idempotencyPath}/input`,
              "idempotency.required_input",
              "Idempotency must reference a required command input.",
            ),
          );
        }
        if (!keyField) {
          issues.push(
            semanticIssue(
              `${idempotencyPath}/field`,
              "idempotency.unknown_field",
              `${command.idempotency.entity}.${command.idempotency.field} is not declared.`,
            ),
          );
        } else {
          if (!keyField.unique && !keyField.primaryKey) {
            issues.push(
              semanticIssue(
                `${idempotencyPath}/field`,
                "idempotency.field_not_unique",
                "The idempotency field must be unique or primary.",
              ),
            );
          }
          if (keyInput && keyInput.type !== keyField.type) {
            issues.push(
              semanticIssue(
                idempotencyPath,
                "idempotency.key_type_mismatch",
                `Input type ${keyInput.type} does not match idempotency field type ${keyField.type}.`,
              ),
            );
          }
        }
        if (!scopePrincipal || !scopePrincipal.required) {
          issues.push(
            semanticIssue(
              `${idempotencyPath}/scopePrincipalField`,
              "idempotency.required_principal_scope",
              "Idempotency scope must reference a required principal field.",
            ),
          );
        }
        if (!scopeField) {
          issues.push(
            semanticIssue(
              `${idempotencyPath}/scopeField`,
              "idempotency.unknown_scope_field",
              `${command.idempotency.entity}.${command.idempotency.scopeField} is not declared.`,
            ),
          );
        } else if (scopePrincipal && scopePrincipal.type !== scopeField.type) {
          issues.push(
            semanticIssue(
              idempotencyPath,
              "idempotency.scope_type_mismatch",
              `Principal scope type ${scopePrincipal.type} does not match entity scope type ${scopeField.type}.`,
            ),
          );
        }
      }

      if (command.transaction?.conflictError) {
        requireError(command.transaction.conflictError, `${path}/transaction/conflictError`);
      }

      for (const [index, guard] of (command.guards ?? []).entries()) {
        const guardPath = `${path}/guards/${index}`;
        const guardEntity = document.spec.entities[guard.entity];
        const guardField = guardEntity?.fields[guard.field];
        const inputField = input?.fields[guard.value.input];
        if (!guardEntity) {
          issues.push(
            semanticIssue(
              `${guardPath}/entity`,
              "command.unknown_guard_entity",
              `Guard entity ${guard.entity} is not declared.`,
            ),
          );
        } else if (!guardField) {
          issues.push(
            semanticIssue(
              `${guardPath}/field`,
              "command.unknown_guard_field",
              `${guard.entity}.${guard.field} is not declared.`,
            ),
          );
        }
        if (!inputField) {
          issues.push(
            semanticIssue(
              `${guardPath}/value/input`,
              "command.unknown_guard_input",
              `${command.input}.${guard.value.input} is not declared.`,
            ),
          );
        } else if (guardField && guardField.type !== inputField.type) {
          issues.push(
            semanticIssue(
              `${guardPath}/value`,
              "command.guard_type_mismatch",
              `Input type ${inputField.type} does not match ${guard.entity}.${guard.field} type ${guardField.type}.`,
            ),
          );
        }
        requireError(guard.error, `${guardPath}/error`, "command.unknown_guard_error");
      }
    }
  }

  const operationIds = new Set<string>();
  for (const [index, operation] of (document.spec.http?.operations ?? []).entries()) {
    const path = `/spec/http/operations/${index}`;
    if (operationIds.has(operation.id)) {
      issues.push(
        semanticIssue(`${path}/id`, "http.duplicate_operation_id", `Operation id ${operation.id} must be unique.`),
      );
    }
    operationIds.add(operation.id);

    if ("entity" in operation && !entityNames.has(operation.entity)) {
      issues.push(
        semanticIssue(
          `${path}/entity`,
          "http.unknown_entity",
          `HTTP operation references undeclared entity ${operation.entity}.`,
        ),
      );
    }
    if ("entity" in operation) {
      const entity = document.spec.entities[operation.entity];
      if (operation.collection && operation.action !== "list") {
        issues.push(
          semanticIssue(
            `${path}/collection`,
            "http.collection_requires_list",
            "Collection controls may only be declared on a list operation.",
          ),
        );
      }
      if (operation.collection?.pagination &&
          operation.collection.pagination.defaultLimit > operation.collection.pagination.maxLimit) {
        issues.push(
          semanticIssue(
            `${path}/collection/pagination/defaultLimit`,
            "http.pagination_default_exceeds_maximum",
            "defaultLimit must not exceed maxLimit.",
          ),
        );
      }
      const filterParameters = new Set<string>();
      for (const [filterIndex, filter] of (operation.collection?.filters ?? []).entries()) {
        const filterPath = `${path}/collection/filters/${filterIndex}`;
        const field = entity?.fields[filter.field];
        if (!field) {
          issues.push(semanticIssue(
            `${filterPath}/field`,
            "http.collection_unknown_filter_field",
            `${operation.entity}.${filter.field} is not declared.`,
          ));
        } else if (field.type === "json") {
          issues.push(semanticIssue(
            `${filterPath}/field`,
            "http.collection_json_filter_unsupported",
            "Portable collection equality filters cannot target JSON fields.",
          ));
        }
        if (filterParameters.has(filter.parameter)) {
          issues.push(semanticIssue(
            `${filterPath}/parameter`,
            "http.collection_duplicate_filter_parameter",
            `Filter parameter ${filter.parameter} is declared more than once.`,
          ));
        }
        filterParameters.add(filter.parameter);
      }
      for (const [orderIndex, order] of (operation.collection?.orderBy ?? []).entries()) {
        if (!entity?.fields[order.field]) {
          issues.push(semanticIssue(
            `${path}/collection/orderBy/${orderIndex}/field`,
            "http.collection_unknown_order_field",
            `${operation.entity}.${order.field} is not declared.`,
          ));
        }
      }
      if (operation.authorization) {
        const principal = document.spec.principals?.[operation.authorization.principal];
        if (!principal) {
          issues.push(semanticIssue(
            `${path}/authorization/principal`,
            "http.authorization_unknown_principal",
            `Principal ${operation.authorization.principal} is not declared.`,
          ));
        }
        for (const [ruleIndex, rule] of operation.authorization.rules.entries()) {
          const field = principal?.fields[rule.principalField];
          const rulePath = `${path}/authorization/rules/${ruleIndex}`;
          if (!field) {
            issues.push(semanticIssue(
              `${rulePath}/principalField`,
              "http.authorization_unknown_principal_field",
              `${operation.authorization.principal}.${rule.principalField} is not declared.`,
            ));
          } else {
            if (!field.required || field.nullable) {
              issues.push(semanticIssue(
                `${rulePath}/principalField`,
                "http.authorization_optional_principal_field",
                "CRUD authorization requires a non-null required principal field.",
              ));
            }
            if (field.type !== "string") {
              issues.push(semanticIssue(
                `${rulePath}/principalField`,
                "http.authorization_principal_membership_type",
                "CRUD role/scope membership requires a string principal field.",
              ));
            }
            const allowed = field.validation?.enum;
            if (allowed && rule.values.some((value) => !allowed.includes(value))) {
              issues.push(semanticIssue(
                `${rulePath}/values`,
                "http.authorization_principal_membership_value",
                "Every allowed role or scope must be permitted by the principal field enum.",
              ));
            }
          }
        }
      }
    }
    if ("command" in operation && !document.spec.commands?.[operation.command]) {
      issues.push(
        semanticIssue(
          `${path}/command`,
          "http.unknown_command",
          `HTTP operation references undeclared command ${operation.command}.`,
        ),
      );
    }
  }

  return issues;
}

export function validateAir(value: unknown): ValidationResult {
  const apiVersion =
    value !== null && typeof value === "object" && "apiVersion" in value
      ? (value as { readonly apiVersion?: unknown }).apiVersion
      : undefined;
  const validateSchema =
    apiVersion === AIR_API_VERSION_V0_1
      ? validateSchemaV0_1
      : apiVersion === AIR_API_VERSION_V0_2
        ? validateSchemaV0_2
        : apiVersion === AIR_API_VERSION_V0_3
          ? validateSchemaV0_3
          : apiVersion === AIR_API_VERSION_V0_4
            ? validateSchemaV0_4
            : apiVersion === AIR_API_VERSION_V0_5
              ? validateSchemaV0_5
              : apiVersion === AIR_API_VERSION_V0_6
                ? validateSchemaV0_6
                : apiVersion === AIR_API_VERSION_V0_7
                  ? validateSchemaV0_7
                  : apiVersion === AIR_API_VERSION_V0_8
                    ? validateSchemaV0_8
                : undefined;

  if (!validateSchema) {
    return {
      valid: false,
      issues: [
        schemaIssue({
          keyword: "apiVersion",
          instancePath: "/apiVersion",
          schemaPath: "#/properties/apiVersion",
          params: {},
          message: "must be a supported AIR version (air.dev/v0.1 through air.dev/v0.8)",
        }),
      ],
    };
  }

  if (!validateSchema(value)) {
    return {
      valid: false,
      issues: (validateSchema.errors ?? []).map(schemaIssue),
    };
  }

  const semanticIssues = validateSemantics(value);
  return semanticIssues.length > 0
    ? { valid: false, issues: semanticIssues }
    : { valid: true, document: value, issues: [] };
}
