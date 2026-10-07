export function words(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part.toLowerCase());
}

function upperFirst(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function pascalCase(value: string): string {
  return words(value).map(upperFirst).join("");
}

export function snakeCase(value: string): string {
  return words(value).join("_");
}

export function pluralize(value: string): string {
  if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  return `${value}s`;
}

export function tableName(entity: string): string {
  return snakeCase(pluralize(entity));
}

export function rustIdentifier(value: string): string {
  const identifier = snakeCase(value);
  return ["type", "match", "ref", "self", "crate", "mod", "move", "async", "await", "loop", "where", "use", "struct", "enum", "impl", "fn", "in", "as", "dyn"].includes(identifier)
    ? `r#${identifier}`
    : identifier;
}
