// https://github.com/andreashuber69/lightning-node-operator/develop/README.md
export const pick = <T extends object, K extends keyof T>(obj: T, keys: K[]) =>
    Object.fromEntries(keys.filter((key) => key in obj).map((key) => [key, obj[key]])) as Pick<T, K>;
