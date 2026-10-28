/** Small, dependency-free wire decoders. Unknown object properties are retained. */
export type Decoder<T> = (value: unknown, path?: string) => T;
export const fail = (path: string, expected: string): never => {
  throw new Error(`Invalid data at ${path}: expected ${expected}`);
};
export const recordValue: Decoder<Record<string, unknown>> = (
  value,
  path = '$',
) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(path, 'an object');
  return value as Record<string, unknown>;
};
export const string: Decoder<string> = (value, path = '$') =>
  typeof value === 'string' ? value : fail(path, 'a string');
export const number: Decoder<number> = (value, path = '$') =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(path, 'a finite number');
export const boolean: Decoder<boolean> = (value, path = '$') =>
  typeof value === 'boolean' ? value : fail(path, 'a boolean');
export const unknown: Decoder<unknown> = (value) => value;
export const optional =
  <T>(decode: Decoder<T>): Decoder<T | undefined> =>
  (value, path) =>
    value === undefined ? undefined : decode(value, path);
export const nullable =
  <T>(decode: Decoder<T>): Decoder<T | null> =>
  (value, path) =>
    value === null ? null : decode(value, path);
export const array =
  <T>(decode: Decoder<T>): Decoder<T[]> =>
  (value, path = '$') => {
    if (!Array.isArray(value)) return fail(path, 'an array');
    const values: unknown[] = value;
    return values.map((item, index) => decode(item, `${path}[${index}]`));
  };
export const record =
  <T>(decode: Decoder<T>): Decoder<Record<string, T>> =>
  (value, path = '$') =>
    Object.fromEntries(
      Object.entries(recordValue(value, path)).map(([key, item]) => [
        key,
        decode(item, `${path}.${key}`),
      ]),
    );
export const object =
  <T extends object>(shape: { [K in keyof T]-?: Decoder<T[K]> }): Decoder<T> =>
  (value, path = '$') => {
    const input = recordValue(value, path);
    const output: Record<string, unknown> = { ...input };
    for (const key in shape) {
      const decoded = shape[key](input[key], `${path}.${key}`);
      if (decoded !== undefined || key in input) output[key] = decoded;
    }
    // Each declared property has been decoded; extra properties remain untouched.
    return output as T;
  };
export const oneOf =
  <const T extends readonly (string | number | boolean)[]>(
    ...values: T
  ): Decoder<T[number]> =>
  (value, path = '$') => {
    for (const item of values) if (value === item) return item;
    return fail(path, values.map(String).join(' | '));
  };
export const union =
  <A, B>(left: Decoder<A>, right: Decoder<B>): Decoder<A | B> =>
  (value, path) => {
    try {
      return left(value, path);
    } catch {
      return right(value, path);
    }
  };
