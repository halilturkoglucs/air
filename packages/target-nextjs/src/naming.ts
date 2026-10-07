export function lowerFirst(value: string): string {
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

export function upperFirst(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

export function camelCase(value: string): string {
  const parts = words(value);
  return parts.map((part, index) => (index === 0 ? part : upperFirst(part))).join("");
}

export function pascalCase(value: string): string {
  return words(value).map(upperFirst).join("");
}

export function kebabCase(value: string): string {
  return words(value).join("-");
}

export function snakeCase(value: string): string {
  return words(value).join("_");
}

export function pluralize(value: string): string {
  if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  return `${value}s`;
}

export function entityNames(entityName: string) {
  const pascal = pascalCase(entityName);
  const camel = camelCase(entityName);
  const pluralCamel = pluralize(camel);
  return {
    pascal,
    camel,
    pluralCamel,
    kebab: kebabCase(entityName),
    table: snakeCase(pluralCamel),
  };
}

export function routePathToDirectory(path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const parameter = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(segment);
      return parameter ? `[${parameter[1]}]` : segment;
    });
  return `src/app/${segments.join("/")}/route.ts`;
}
