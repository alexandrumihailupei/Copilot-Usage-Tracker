declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  interface Database {
    run(sql: string, params?: (string | number | null | Uint8Array)[]): Database;
    exec(sql: string, params?: (string | number | null | Uint8Array)[]): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  interface Statement {
    run(params?: (string | number | null | Uint8Array)[]): void;
    free(): void;
  }

  interface QueryExecResult {
    columns: string[];
    values: (string | number | null | Uint8Array)[][];
  }

  interface SqlJsOptions {
    locateFile?: (filename: string) => string;
  }

  export default function initSqlJs(options?: SqlJsOptions): Promise<SqlJsStatic>;
  export type { Database, Statement, QueryExecResult, SqlJsStatic };
}
