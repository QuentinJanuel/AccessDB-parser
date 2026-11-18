import {
  MEMO,
  parseDataPageHeader,
  parseRelativeObjectMetadataStruct,
  parseTableData,
  parseTableHead,
  TDEF_HEADER,
} from "./parsing-primitives";
import type {
  AccessParserError,
  AccessParserLogLevel,
  AccessParserWarning,
  AccessParserWarningCode,
  Dico,
  Version,
} from "./types";
import { DataType, parseType } from "./utils";

const LOG_LEVEL_RANK: { [K in AccessParserLogLevel]: number } = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
};
const WARN_PRINT_LIMIT = 3;

export class TableObject {
  public value: Uint8Array;
  public linkedPages: Array<Uint8Array> = [];
  public constructor(_offset: number, value: Uint8Array) {
    this.value = value;
    this.linkedPages = [];
  }
}

type PropType<TObj, TProp extends keyof TObj> = TObj[TProp];
type Column = PropType<ReturnType<typeof parseTableData>, "column">[0] & {
  colNameStr: string;
};
type TableHeader = ReturnType<typeof parseTableHead>;

export class AccessTable {
  private version: Version;
  private pageSize: number;
  private dataPages: Dico<Uint8Array>;
  private tableDefs: Dico<Uint8Array>;
  private table: TableObject;
  private parsedTable: Dico<Array<string | number | boolean | null>>;
  private columns: Dico<Column>;
  private tableHeader: TableHeader;
  private logLevel: AccessParserLogLevel;
  private onWarning?: (warning: AccessParserWarning) => void;
  private onError?: (error: AccessParserError) => void;
  private warningCountsBySignature: Map<string, number>;
  private warningTotalsByCode: Map<AccessParserWarningCode, number>;
  public constructor(
    table: TableObject,
    version: Version,
    pageSize: number,
    dataPages: Dico<Uint8Array>,
    tableDefs: Dico<Uint8Array>,
    logLevel: AccessParserLogLevel,
    onWarning?: (warning: AccessParserWarning) => void,
    onError?: (error: AccessParserError) => void,
  ) {
    this.version = version;
    this.pageSize = pageSize;
    this.dataPages = dataPages;
    this.tableDefs = tableDefs;
    this.table = table;
    this.logLevel = logLevel;
    this.onWarning = onWarning;
    this.onError = onError;
    this.warningCountsBySignature = new Map<string, number>();
    this.warningTotalsByCode = new Map<AccessParserWarningCode, number>();
    this.parsedTable = {};
    [this.columns, this.tableHeader] = this.getTableColumns();
  }
  private shouldLog(level: "error" | "warn" | "info"): boolean {
    return LOG_LEVEL_RANK[this.logLevel] >= LOG_LEVEL_RANK[level];
  }
  private serializeMeta(meta: unknown): string {
    if (meta === undefined) return "";
    if (meta === null) return "null";
    if (typeof meta !== "object") return String(meta);
    if (Array.isArray(meta)) return `[${meta.map((item) => this.serializeMeta(item)).join(",")}]`;
    const obj = meta as { [key: string]: unknown };
    const keys = Object.keys(obj).sort();
    const entries = keys.map((key) => `${key}:${this.serializeMeta(obj[key])}`);
    return `{${entries.join(",")}}`;
  }
  private warn(code: AccessParserWarningCode, message: string, meta?: unknown): void {
    const signature = `${code}|${message}|${this.serializeMeta(meta)}`;
    const occurrence = (this.warningCountsBySignature.get(signature) ?? 0) + 1;
    this.warningCountsBySignature.set(signature, occurrence);
    this.warningTotalsByCode.set(code, (this.warningTotalsByCode.get(code) ?? 0) + 1);
    if (this.onWarning) this.onWarning({ code, message, meta, occurrence, signature });
    if (!this.shouldLog("warn")) return;
    if (occurrence > WARN_PRINT_LIMIT) return;
    if (meta !== undefined) console.warn(`[${code}] ${message}`, meta);
    else console.warn(`[${code}] ${message}`);
  }
  private error(code: string, message: string, error?: unknown, meta?: unknown): void {
    if (this.onError) this.onError({ code, message, error, meta });
    if (!this.shouldLog("error")) return;
    if (error !== undefined && meta !== undefined)
      console.error(`[${code}] ${message}`, { meta, error });
    else if (error !== undefined) console.error(`[${code}] ${message}`, error);
    else if (meta !== undefined) console.error(`[${code}] ${message}`, meta);
    else console.error(`[${code}] ${message}`);
  }
  private emitWarningsSummary(): void {
    if (!this.shouldLog("warn")) return;
    for (const [code, total] of this.warningTotalsByCode.entries()) {
      if (total <= WARN_PRINT_LIMIT) continue;
      console.warn(`[${code}] x${total}`);
    }
  }
  private getTableColumns(): [Dico<Column>, TableHeader] {
    let tableHeader: TableHeader;
    let colNames: PropType<ReturnType<typeof parseTableData>, "columnNames">;
    let columns: Array<Column>;
    try {
      tableHeader = parseTableHead(this.table.value, this.version);
      let mergedData = this.table.value.slice(tableHeader.tDefHeaderEnd);
      if (tableHeader.TDEF_header.nextPagePtr) {
        mergedData = new Uint8Array([
          ...mergedData,
          ...this.mergeTableData(tableHeader.TDEF_header.nextPagePtr),
        ]);
      }
      const parsedData = parseTableData(
        mergedData,
        tableHeader.realIndexCount,
        tableHeader.columnCount,
        this.version,
      );
      columns = parsedData.column as any;
      colNames = parsedData.columnNames;
    } catch (err) {
      throw new Error(`Failed to parse table header`);
    }
    columns.forEach((c, i) => {
      c.colNameStr = colNames[i].colNameStr;
    });
    const offset = Math.min(...columns.map((c) => c.columnIndex));
    const columnDict: Dico<Column> = {};
    for (const x of columns) columnDict[x.columnIndex - offset] = x;
    if (Object.keys(columnDict).length !== columns.length) {
      for (const x of columns) columnDict[x.columnID] = x;
    }
    if (Object.keys(columnDict).length !== tableHeader.columnCount)
      throw new Error(
        `Expected ${tableHeader.columnCount} columns got ${Object.keys(columnDict).length}`,
      );
    return [columnDict, tableHeader];
  }
  private mergeTableData(firstPage: number): Uint8Array {
    let table = this.tableDefs[firstPage * this.pageSize]!;
    let parsedHeader = TDEF_HEADER.parse(
      Buffer.from(table.buffer, table.byteOffset, table.byteLength),
    );
    let data = table.slice(parsedHeader.headerEnd);
    while (parsedHeader.nextPagePtr) {
      table = this.tableDefs[parsedHeader.nextPagePtr * this.pageSize]!;
      parsedHeader = TDEF_HEADER.parse(
        Buffer.from(table.buffer, table.byteOffset, table.byteLength),
      );
      data = new Uint8Array([...data, ...table.slice(parsedHeader.headerEnd)]);
    }
    return data;
  }
  private createEmptyTable() {
    const parsedTable: Dico<Array<string | number | boolean>> = {};
    const [columns] = this.getTableColumns();
    for (const i of Object.keys(columns)) {
      const column = columns[i]!;
      parsedTable[column.colNameStr] = [];
    }
    return parsedTable;
  }
  private getOverflowRecord(recordPointer: number): Uint8Array | undefined {
    const recordOffset = (recordPointer & 0xff) >>> 0;
    const pageNum = recordPointer >>> 8;
    const recordPage = this.dataPages[pageNum * this.pageSize];
    if (!recordPage) return;
    const parsedData = parseDataPageHeader(recordPage, this.version);
    if (recordOffset >= parsedData.recordOffsets.length) return;
    const recordOffsetMask = this.pageSize * 2 - 1;
    let start = parsedData.recordOffsets[recordOffset];
    if ((start & 0x8000) >>> 0) start = (start & recordOffsetMask) >>> 0;
    else
      this.warn("WARN_DB_OVERFLOW_FLAG_MISSING", "Overflow record flag is not present", {
        start,
        recordOffset,
        pageNum,
      });
    let record: Uint8Array;
    if (recordOffset === 0) {
      record = recordPage.slice(start);
    } else {
      let end: number | undefined;
      for (let index = recordOffset - 1; index >= 0; index -= 1) {
        const previousOffset = parsedData.recordOffsets[index]!;
        if ((previousOffset & 0x4000) === 0) {
          end = previousOffset & recordOffsetMask;
          break;
        }
      }
      record = end === undefined ? recordPage.slice(start) : recordPage.slice(start, end);
    }
    return record;
  }
  private parseFixedLengthData(
    originalRecord: Uint8Array,
    column: Column,
    nullTable: Array<boolean>,
  ) {
    const columnName = column.colNameStr;
    if (column.columnID >= nullTable.length)
      throw new Error(
        `Failed to parse field, column not found in nullTable column: ${columnName}, column id: ${column.columnID}, nullTable: ${nullTable}`,
      );

    if (this.parsedTable[columnName] === undefined) this.parsedTable[columnName] = [];

    let parsedType: boolean | string | number | null;

    if (column.type === DataType.Boolean) {
      if (column.columnID >= nullTable.length)
        throw new Error(
          `Failed to parse bool field, Column not found in nullTable column: ${columnName}, column id: ${column.columnID}, nullTable: ${nullTable}`,
        );
      parsedType = nullTable[column.columnID];
    } else {
      if (column.columnID >= nullTable.length)
        throw new Error(
          `Failed to parse field, column not found in nullTable column: ${columnName}, column id: ${column.columnID}, nullTable: ${nullTable}`,
        );
      if (nullTable[column.columnID] === false) {
        parsedType = null;
      } else {
        if (column.fixedOffset >= originalRecord.length)
          throw new Error(
            `Column offset is bigger than the length of the record ${column.fixedOffset}`,
          );
        const record = originalRecord.slice(column.fixedOffset);
        parsedType = parseType(column.type, record, undefined, this.version);
      }
    }
    this.parsedTable[columnName]!.push(parsedType);
  }
  private parseDynamicLengthRecordsMetadata(
    reverseRecord: Uint8Array,
    originalRecord: Uint8Array,
    nullTableLength: number,
  ) {
    if (this.version > 3) {
      const recordView = new DataView(
        originalRecord.buffer,
        originalRecord.byteOffset,
        originalRecord.byteLength,
      );
      const trailerEnd = originalRecord.length - nullTableLength;
      const countOffset = trailerEnd - 2;
      if (countOffset < 0) {
        throw new Error("Jet4 record is too short for variable-length field count");
      }

      const variableLengthFieldCount = recordView.getUint16(countOffset, true);
      if (variableLengthFieldCount > this.tableHeader.variableColumns) {
        throw new Error(
          `Jet4 variable-length field count exceeds table definition: expected at most ${this.tableHeader.variableColumns}, got ${variableLengthFieldCount}`,
        );
      }

      const terminalOffsetPosition = trailerEnd - 4 - 2 * variableLengthFieldCount;
      if (terminalOffsetPosition < 0 || terminalOffsetPosition + 2 > countOffset) {
        throw new Error("Jet4 variable-length metadata is outside the record bounds");
      }

      const variableLengthFieldOffsets = Array.from(
        { length: variableLengthFieldCount },
        (_, index) => recordView.getUint16(trailerEnd - 4 - 2 * index, true),
      );
      const varLenCount = recordView.getUint16(terminalOffsetPosition, true);
      if (varLenCount > terminalOffsetPosition) {
        throw new Error(
          `Jet4 variable-length data end ${varLenCount} overlaps metadata at ${terminalOffsetPosition}`,
        );
      }

      let previousOffset = 0;
      for (const [index, offset] of variableLengthFieldOffsets.entries()) {
        if (offset < previousOffset || offset > varLenCount) {
          throw new Error(
            `Jet4 variable-length field offset ${index} is outside the record data bounds`,
          );
        }
        previousOffset = offset;
      }

      return {
        variableLengthFieldCount,
        variableLengthJumpTable: [],
        variableLengthFieldOffsets,
        varLenCount,
        relativeMetadataEnd: trailerEnd,
      };
    }
    const variableLengthJumpTableCNT = Math.floor((originalRecord.length - 1) / 256);
    reverseRecord = reverseRecord.slice(nullTableLength);
    let relativeRecordMetadata: ReturnType<typeof parseRelativeObjectMetadataStruct>;
    try {
      relativeRecordMetadata = parseRelativeObjectMetadataStruct(
        reverseRecord,
        variableLengthJumpTableCNT,
        this.version,
      );
      relativeRecordMetadata.relativeMetadataEnd += nullTableLength;
    } catch {
      throw new Error("Failed parsing record");
    }
    if (
      relativeRecordMetadata &&
      relativeRecordMetadata.variableLengthFieldCount !== this.tableHeader.variableColumns
    ) {
      const tmpBuffer = new Uint8Array(2);
      const tmpDataView = new DataView(tmpBuffer.buffer);
      tmpDataView.setUint16(0, this.tableHeader.variableColumns, true);
      const metadataStart = reverseRecord.indexOf(tmpBuffer[0]);
      if (metadataStart !== 1 && metadataStart < 10) {
        reverseRecord = reverseRecord.slice(metadataStart);
        try {
          relativeRecordMetadata = parseRelativeObjectMetadataStruct(
            reverseRecord,
            variableLengthJumpTableCNT,
            this.version,
          );
        } catch {
          throw new Error(`Failed to parse record metadata: ${originalRecord}`);
        }
        relativeRecordMetadata.relativeMetadataEnd += metadataStart;
      } else {
        this.warn("WARN_DB_RECORD_METADATA_MISMATCH", "Record metadata mismatch", {
          expectedColumns: this.tableHeader.variableColumns,
          parsedColumns: relativeRecordMetadata.variableLengthFieldCount,
        });
        return;
      }
    }
    return relativeRecordMetadata;
  }
  private parseMemo(relativeObjData: Uint8Array, column: Column): string | number | boolean {
    // console.log(`Parsing memo field ${relativeObjData}`);
    const parsedMemo = MEMO.parse(
      Buffer.from(relativeObjData.buffer, relativeObjData.byteOffset, relativeObjData.byteLength),
    );
    let memoData: Uint8Array;
    let memoType: DataType;
    if (parsedMemo.memoLength & 0x80000000) {
      // console.log("Memo data inline");
      memoData = relativeObjData.slice(parsedMemo.memoEnd);
      memoType = DataType.Text;
    } else if (parsedMemo.memoLength & 0x40000000) {
      // console.log("LVAL type 1");
      const tmp = this.getOverflowRecord(parsedMemo.recordPointer);
      if (tmp === undefined) throw new Error("LVAL type 1 memoData is undefined");
      memoData = tmp;
      memoType = DataType.Text;
    } else {
      // console.log("LVAL type 2");
      this.warn("WARN_DB_MEMO_LVAL2_UNSUPPORTED", "Memo LVAL type 2 currently not supported");
      memoData = relativeObjData;
      memoType = column.type;
    }
    return parseType(memoType, memoData, memoData.length, this.version);
  }
  private parseDynamicLengthData(
    originalRecord: Uint8Array,
    relativeRecordMetadata: ReturnType<typeof parseRelativeObjectMetadataStruct>,
    relativeRecordsColumnMap: Dico<Column>,
    nullTable: Array<boolean>,
  ): void {
    const relativeOffsets = relativeRecordMetadata.variableLengthFieldOffsets;
    let jumpTableAddition = 0;
    let i = -1;
    for (const columnIndex of Object.keys(relativeRecordsColumnMap)) {
      i += 1;
      const column = relativeRecordsColumnMap[columnIndex]!;
      const colName = column.colNameStr;

      if (column.columnID < nullTable.length && nullTable[column.columnID] === false) {
        if (this.parsedTable[colName] === undefined) {
          this.parsedTable[colName] = [];
        }
        this.parsedTable[colName]!.push(null);
        continue;
      }

      if (this.version === 3) {
        if (relativeRecordMetadata.variableLengthJumpTable.includes(i))
          jumpTableAddition = (jumpTableAddition + 0x100) >>> 0;
      }
      let relStart = relativeOffsets[i];
      let relEnd: number;
      if (i + 1 === relativeOffsets.length) relEnd = relativeRecordMetadata.varLenCount;
      else relEnd = relativeOffsets[i + 1];
      if (relStart === relEnd) {
        if (this.parsedTable[colName] === undefined) this.parsedTable[colName] = [];
        this.parsedTable[colName]!.push("");
        continue;
      }
      const relativeObjData = originalRecord.slice(
        relStart + jumpTableAddition,
        relEnd + jumpTableAddition,
      );
      let parsedType: string | number | boolean;
      if (column.type === DataType.Memo) {
        try {
          parsedType = this.parseMemo(relativeObjData, column);
        } catch {
          this.warn(
            "WARN_DB_MEMO_FALLBACK_TO_BYTES",
            "Failed to parse memo field. Using data as bytes",
            { column: colName },
          );
          parsedType = new TextDecoder("utf-8").decode(relativeObjData);
        }
      } else {
        parsedType = parseType(column.type, relativeObjData, relativeObjData.length, this.version);
      }
      if (this.parsedTable[colName] === undefined) this.parsedTable[colName] = [];
      this.parsedTable[colName]!.push(parsedType);
    }
  }
  private parseRow(record: Uint8Array): void {
    const originalRecord = new Uint8Array(record);
    let reverseRecord = new Uint8Array(record);
    reverseRecord = reverseRecord.reverse();
    const nullTableLen = Math.floor((this.tableHeader.columnCount + 7) / 8);
    const nullTable: Array<boolean> = [];
    if (nullTableLen && nullTableLen < originalRecord.length) {
      const nullTableBuffer = record.slice(nullTableLen === 0 ? 0 : record.length - nullTableLen);
      for (let i = 0; i < nullTableBuffer.length * 8; ++i)
        nullTable.push((nullTableBuffer[Math.floor(i / 8)] & (((1 << (i % 8)) >>> 0) >>> 0)) !== 0);
    } else {
      throw new Error(`Failed to parse null table column count ${this.tableHeader.columnCount}`);
    }
    if (this.version > 3) record = record.slice(2);
    else record = record.slice(1);
    const relativeRecordsColumnMap: Dico<Column> = {};
    for (const i of Object.keys(this.columns)) {
      const column = this.columns[i]!;
      if (!column.columnFlags.fixedLength) {
        relativeRecordsColumnMap[i] = column;
      }
    }
    const hasVariableLengthColumns = Object.keys(relativeRecordsColumnMap).length > 0;
    const jet4Metadata =
      this.version > 3 && hasVariableLengthColumns
        ? this.parseDynamicLengthRecordsMetadata(reverseRecord, originalRecord, nullTableLen)
        : undefined;
    if (jet4Metadata) {
      let variableColumnIndex = 0;
      for (const columnIndex of Object.keys(relativeRecordsColumnMap)) {
        const column = relativeRecordsColumnMap[columnIndex]!;
        const valueIsPresent =
          column.columnID >= nullTable.length || nullTable[column.columnID] !== false;
        if (
          valueIsPresent &&
          variableColumnIndex >= jet4Metadata.variableLengthFieldCount
        ) {
          throw new Error(
            `Jet4 variable-length field ${column.colNameStr} has no record offset`,
          );
        }
        variableColumnIndex += 1;
      }
    }
    for (const i of Object.keys(this.columns)) {
      const column = this.columns[i]!;
      if (column.columnFlags.fixedLength) this.parseFixedLengthData(record, column, nullTable);
    }
    if (Object.keys(relativeRecordsColumnMap).length > 0) {
      const metadata =
        jet4Metadata ??
        this.parseDynamicLengthRecordsMetadata(reverseRecord, originalRecord, nullTableLen);
      if (metadata === undefined) return;
      this.parseDynamicLengthData(originalRecord, metadata, relativeRecordsColumnMap, nullTable);
    }
  }
  public parse(): Dico<Array<string | number | boolean | null>> {
    if (!this.table.linkedPages) return this.createEmptyTable();
    for (const dataChunk of this.table.linkedPages) {
      const originalData = dataChunk;
      const parsedData = parseDataPageHeader(originalData, this.version);
      const recordOffsetMask = this.pageSize * 2 - 1;
      let lastOffset: number | undefined;
      for (const recOffset of parsedData.recordOffsets) {
        if ((recOffset & 0x8000) >>> 0) {
          lastOffset = (recOffset & recordOffsetMask) >>> 0;
          continue;
        }
        if ((recOffset & 0x4000) >>> 0) {
          const recPtrOffset = (recOffset & recordOffsetMask) >>> 0;
          lastOffset = recPtrOffset;
          const overflowRecPtrBuffer = originalData.slice(recPtrOffset, recPtrOffset + 4);
          const dataView = new DataView(
            overflowRecPtrBuffer.buffer,
            overflowRecPtrBuffer.byteOffset,
            overflowRecPtrBuffer.byteLength,
          );
          const overflowRecPtr = dataView.getUint32(0, true);
          const record = this.getOverflowRecord(overflowRecPtr);
          if (record !== undefined) {
            try {
              this.parseRow(record);
            } catch (error) {
              this.warn("WARN_DB_ROW_SKIPPED_PARSE_ERROR", "Skipping row due parse error", {
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          continue;
        }
        let record: Uint8Array;
        if (!lastOffset) record = originalData.slice(recOffset);
        else record = originalData.slice(recOffset, lastOffset);
        lastOffset = recOffset;
        if (record) {
          try {
            this.parseRow(record);
          } catch (error) {
            this.warn("WARN_DB_ROW_SKIPPED_PARSE_ERROR", "Skipping row due parse error", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    this.emitWarningsSummary();
    return this.parsedTable;
  }
}
