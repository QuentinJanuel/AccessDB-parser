import { AccessTable, TableObject } from "./access-table";
import { ACCESSHEADER, parseTableHead } from "./parsing-primitives";
import type {
  AccessParserError,
  AccessParserLogLevel,
  AccessParserOptions,
  AccessParserWarning,
  Dico,
} from "./types";
import { readActiveTablePages } from "./usage-map";
import { categorizePages } from "./utils";

const PAGE_SIZE_V3 = 0x800;
const PAGE_SIZE_V4 = 0x1000;

// Versions
const VERSION_3 = 0x00;
const VERSION_4 = 0x01;
const VERSION_5 = 0x02;
const VERSION_2010 = 0x03;

enum ALL_VERSIONS {
  VERSION_3 = 3,
  VERSION_4 = 4,
  VERSION_5 = 5,
  VERSION_2010 = 2010,
}
const NEW_VERSIONS = [VERSION_4, VERSION_5, VERSION_2010];

const SYSTEM_TABLE_FLAGS = [-0x80000000, -0x00000002, 0x80000000, 0x00000002];
type Line = {
  data: {
    [s: string]: any;
  };
  rowNumber: number;
};

type Table = Line[];

export class AccessParser {
  private dbData: Uint8Array;
  private tableDefs: Dico<Uint8Array>;
  private dataPages: Dico<Uint8Array>;
  private tablesWithData: Dico<TableObject> = {};
  private version = ALL_VERSIONS.VERSION_3;
  private pageSize = PAGE_SIZE_V3;
  private catalog: Dico<number>;
  private logLevel: AccessParserLogLevel;
  private onWarning?: (warning: AccessParserWarning) => void;
  private onError?: (error: AccessParserError) => void;
  public constructor(dbData: Uint8Array, options: AccessParserOptions = {}) {
    this.dbData = dbData;
    this.logLevel = options.logLevel ?? "warn";
    this.onWarning = options.onWarning;
    this.onError = options.onError;
    this.parseFileHeader();
    [this.tableDefs, this.dataPages] = categorizePages(this.dbData, this.pageSize);
    this.catalog = this.parseCatalog();
  }
  private error(code: string, message: string, error?: unknown, meta?: unknown) {
    if (this.onError) this.onError({ code, message, error, meta });
    if (this.logLevel === "silent") return;
    if (error !== undefined && meta !== undefined)
      console.error(`[${code}] ${message}`, { meta, error });
    else if (error !== undefined) console.error(`[${code}] ${message}`, error);
    else if (meta !== undefined) console.error(`[${code}] ${message}`, meta);
    else console.error(`[${code}] ${message}`);
  }
  private parseFileHeader(): void {
    let head: ReturnType<typeof ACCESSHEADER.parse>;
    try {
      head = ACCESSHEADER.parse(
        Buffer.from(this.dbData.buffer, this.dbData.byteOffset, this.dbData.byteLength),
      );
    } catch {
      throw new Error("Failed to parse DB file header. Check it is a valid file header");
    }
    const version = head.jetVersion;
    if (NEW_VERSIONS.includes(version)) {
      if (version === VERSION_4) this.version = ALL_VERSIONS.VERSION_4;
      else if (version === VERSION_5) this.version = ALL_VERSIONS.VERSION_5;
      else if (version === VERSION_2010) this.version = ALL_VERSIONS.VERSION_2010;
      this.pageSize = PAGE_SIZE_V4;
    } else if (version !== VERSION_3) {
      throw new Error(`Unknown database version ${version} Trying to parse database as version 3`);
    }
  }
  private getTableObject(tablePage: number, tableName: string): TableObject {
    const offset = tablePage * this.pageSize;
    const cached = this.tablesWithData[offset];
    if (cached !== undefined) return cached;
    const definition = this.tableDefs[offset];
    if (definition === undefined) {
      throw new Error(`Could not find table ${tableName} at definition page ${tablePage}`);
    }
    let usageMapPointer: number | undefined;
    let linkedPages: Uint8Array[];
    try {
      usageMapPointer = parseTableHead(definition, this.version).rowPageMap;
      linkedPages = readActiveTablePages(
        this.dbData,
        this.pageSize,
        this.version,
        tablePage,
        usageMapPointer!,
      );
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      const message = `Cannot read active pages for table ${tableName}: ${reason}`;
      this.error("ERR_DB_USAGE_MAP_INVALID", message, cause, {
        tableName,
        tableDefinitionPage: tablePage,
        usageMapPointer,
      });
      throw new Error(`ERR_DB_USAGE_MAP_INVALID: ${message}`);
    }
    const table = new TableObject(offset, definition);
    table.linkedPages = linkedPages;
    this.tablesWithData[offset] = table;
    return table;
  }
  private parseCatalog() {
    const catalogPage = this.getTableObject(2, "MSysObjects");
    const accessTable = new AccessTable(
      catalogPage,
      this.version,
      this.pageSize,
      this.dataPages,
      this.tableDefs,
      this.logLevel,
      this.onWarning,
      this.onError,
    );
    const catalog = accessTable.parse();
    const tablesMapping: Dico<number> = {};
    let i = -1;
    const names: Array<string> = catalog["Name"] as any;
    const types: Array<number> = catalog["Type"] as any;
    const flags: Array<number> = catalog["Flags"] as any;
    const ids: Array<number> = catalog["Id"] as any;
    if (names === undefined || types === undefined || flags === undefined || ids === undefined)
      throw new Error("The catalog is missing required fields");
    for (const tableName of names) {
      if (typeof tableName !== "string") continue;
      i += 1;
      const tableType = 1;
      if (types[i] === tableType) {
        if (!SYSTEM_TABLE_FLAGS.includes(flags[i]) && flags[i] === 0) {
          tablesMapping[tableName] = ids[i];
        }
      }
    }
    return tablesMapping;
  }
  private parseTableUnformatted(tableName: string) {
    const tablePage = this.catalog[tableName];
    if (tablePage === undefined) throw new Error(`Could not find table ${tableName} in Database`);
    const table = this.getTableObject(tablePage, tableName);
    const accessTable = new AccessTable(
      table,
      this.version,
      this.pageSize,
      this.dataPages,
      this.tableDefs,
      this.logLevel,
      this.onWarning,
      this.onError,
    );
    return accessTable.parse();
  }
  public parseTable(name: string): Table {
    const table = this.parseTableUnformatted(name);
    const fields = Object.keys(table);
    if (fields.length === 0) {
      return [];
    }
    const linesNumber = table[fields[0]]!.length;
    const lines: Array<Line> = [];
    for (let i = 0; i < linesNumber; ++i) {
      const line: any = {};
      for (const field of fields) {
        line[field] = table[field]![i];
      }
      lines.push({ data: line, rowNumber: i + 1 });
    }
    return lines;
  }
  public getTables(): string[] {
    return Object.keys(this.catalog);
  }
  public getVersion(): number {
    return this.version;
  }
}

