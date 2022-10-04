export interface ScopedVar<T = any> {
  text: any;
  value: T;
  [key: string]: any;
}

export type ScopedVars = Record<string, ScopedVar>
