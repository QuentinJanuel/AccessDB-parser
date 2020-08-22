import {
	categorizePages,
	DataType,
	parseType,
} from "./utils";
import {
	ACCESSHEADER,
	TDEF_HEADER,
	MEMO,
	parseDataPageHeader,
	parseTableHead,
	parseTableData,
	parseRelativeObjectMetadataStruct,
} from "./parsing-primitives";
import { Dico } from "./types";

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

class TableObject {
	public value: Buffer;
	// private offset: number;
	public linkedPages: Array<Buffer> = [];
	public constructor(_offset: number, value: Buffer) {
		this.value = value;
		// this.offset = offset;
		this.linkedPages = [];
	}
}

type Line = Array<string>;

interface Table {
	fields: Line;
	lines: Array<Line>;
}

export class AccessParser {
	private dbData: Buffer;
	private tableDefs: Dico<Buffer>;
	private dataPages: Dico<Buffer>;
	// private allPages: Dico<Buffer>;
	private tablesWithData: Dico<TableObject>;
	private version = ALL_VERSIONS.VERSION_3;
	private pageSize = PAGE_SIZE_V3;
	private catalog: Dico<number>;
	public constructor(dbData: Buffer) {
		this.dbData = dbData;
		this.parseFileHeader();
		[this.tableDefs, this.dataPages, /*this.allPages*/] = categorizePages(this.dbData, this.pageSize);
		this.tablesWithData = this.linkTablesToData();
		this.catalog = this.parseCatalog();
	}
	private parseFileHeader(): void {
		let head: ReturnType<typeof ACCESSHEADER.parse>;
		try {
			head = ACCESSHEADER.parse(this.dbData);
		} catch {
			throw new Error("Failed to parse DB file header. Check it is a valid file header");
		}
		const version = head.jetVersion;
		if (NEW_VERSIONS.includes(version)) {
			if (version === VERSION_4)
				this.version = ALL_VERSIONS.VERSION_4;
			else if (version === VERSION_5)
				this.version = ALL_VERSIONS.VERSION_5;
			else if (version === VERSION_2010)
				this.version = ALL_VERSIONS.VERSION_2010
			this.pageSize = PAGE_SIZE_V4;
		} else if (version !== VERSION_3) {
			throw new Error(`Unknown database version ${version} Trying to parse database as version 3`);
		}
	}
	private linkTablesToData(): Dico<TableObject> {
		const tablesWithData: Dico<TableObject> = {};
		for (const i of Object.keys(this.dataPages)) {
			const data = this.dataPages[i]!;
			let parsedDP: ReturnType<typeof parseDataPageHeader>;
			try {
				parsedDP = parseDataPageHeader(data, this.version)
			} catch {
				console.error(`Failed to parse data page ${data}`);
				continue;
			}
			const pageOffset = parsedDP.owner * this.pageSize;
			if (Object.keys(this.tableDefs).map(str => parseInt(str)).includes(pageOffset)) {
				const tablePageValue = this.tableDefs[pageOffset]!;
				if (!Object.keys(tablesWithData).includes(pageOffset.toString()))
					tablesWithData[pageOffset] = new TableObject(pageOffset, tablePageValue);
				tablesWithData[pageOffset]!.linkedPages.push(data);
			}
		}
		return tablesWithData;
	}
	private parseCatalog() {
		const catalogPage = this.tablesWithData[2 * this.pageSize]!;
		const accessTable = new AccessTable(catalogPage, this.version, this.pageSize, this.dataPages, this.tableDefs);
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
			if (typeof tableName !== "string")
				continue;
			i += 1;
			const tableType = 1;
			if (types[i] === tableType) {
				if (!SYSTEM_TABLE_FLAGS.includes(flags[i]) && flags[i] === 0) {
					// TODO: CHECK IF 0 IS THE RIGHT FLAG TO SET
					// console.log(tableName);
					// console.log(flags[i]);
					tablesMapping[tableName] = ids[i];
				}
			}
		}
		return tablesMapping;
	}
	private parseTableUnformatted(tableName: string) {
		let tableOffset = this.catalog[tableName];
		if (tableOffset === undefined)
			throw new Error(`Could not find table ${tableName} in Database`);
		tableOffset *= this.pageSize;
		let table = this.tablesWithData[tableOffset];
		if (table === undefined) {
			const tableDef = this.tableDefs[tableOffset];
			if (tableDef === undefined) {
				throw new Error(`Could not find table ${tableName} offset ${tableOffset}`);
			} else {
				throw new Error("Empty table")
				// table = new TableObject(tableOffset, tableDef);
			}
		}
		const accessTable = new AccessTable(table, this.version, this.pageSize, this.dataPages, this.tableDefs);
		return accessTable.parse();
	}
	public parseTable(name: string): Table {
		const table = this.parseTableUnformatted(name);
		const fields = Object.keys(table);
		if (fields.length === 0) {
			return { fields: [], lines: [] };
		}
		const linesNumber = table[fields[0]]!.length;
		const lines: Array<Line> = [];
		for (let i = 0; i < linesNumber; ++i) {
			const line: Array<string> = [];
			for (const field of fields)
				line.push(table[field]![i].toString());
			lines.push(line);
		}
		return { fields, lines };
	}
	public getTables() {
		return Object.keys(this.catalog);
	}
	public getVersion(): number {
		return this.version;
	}
}

type PropType<TObj, TProp extends keyof TObj> = TObj[TProp];
type Column = PropType<ReturnType<typeof parseTableData>, "column">[0] & { colNameStr: string };
type TableHeader = ReturnType<typeof parseTableHead>;

class AccessTable {
	private version: ALL_VERSIONS;
	private pageSize: number;
	private dataPages: Dico<Buffer>;
	private tableDefs: Dico<Buffer>;
	private table: TableObject;
	private parsedTable: Dico<Array<string | number | boolean>>;
	private columns: Dico<Column>;
	private tableHeader: TableHeader;
	public constructor(table: TableObject, version: ALL_VERSIONS, pageSize: number, dataPages: Dico<Buffer>, tableDefs: Dico<Buffer>) {
		this.version = version
		this.pageSize = pageSize;
		this.dataPages = dataPages
		this.tableDefs = tableDefs;
		this.table = table
		this.parsedTable = {};
		[this.columns, this.tableHeader] = this.getTableColumns();
	}
	private getTableColumns(): [Dico<Column>, TableHeader] {
		let tableHeader: TableHeader;
		let colNames: PropType<ReturnType<typeof parseTableData>, "columnNames">;
		let columns: Array<Column>;
		try {
			tableHeader = parseTableHead(this.table.value, this.version);
			let mergedData = this.table.value.slice(tableHeader.tDefHeaderEnd);
			if (tableHeader.TDEF_header.nextPagePtr) {
				mergedData = Buffer.concat([
					mergedData,
					this.mergeTableData(tableHeader.TDEF_header.nextPagePtr),
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
			// REMOVE FOR NOW
			// (tableHeader as any).column = parsedData.column;
			// (tableHeader as any).columnNames = parsedData.columnNames;
		} catch (err) {
			throw new Error(`Failed to parse table header`);
		}
		// const colNames = tableHeader.columnNames;
		// const columns = tableHeader.column;
		columns.forEach((c, i) => {
			c.colNameStr = colNames[i].colNameStr;
		});
		const offset = Math.min(...columns.map(c => c.columnIndex));
		const columnDict: Dico<Column> = {};
		for (const x of columns)
			columnDict[x.columnIndex - offset] = x;
		if (Object.keys(columnDict).length !== columns.length) {
			for (const x of columns)
				columnDict[x.columnID] = x;
		}
		if (Object.keys(columnDict).length !== tableHeader.columnCount)
			throw new Error(`Expected ${tableHeader.columnCount} columns got ${Object.keys(columnDict).length}`);
		return [columnDict, tableHeader];
	}
	private mergeTableData(firstPage: number): Buffer {
		let table = this.tableDefs[firstPage * this.pageSize]!;
		let parsedHeader = TDEF_HEADER.parse(table);
		let data = table.slice(parsedHeader.headerEnd);
		while (parsedHeader.nextPagePtr) {
			table = this.tableDefs[parsedHeader.nextPagePtr * this.pageSize]!;
			parsedHeader = TDEF_HEADER.parse(table);
			data = Buffer.concat([data, table.slice(parsedHeader.headerEnd)]);
		}
		return data;
	}
	private createEmptyTable() {
		const parsedTable: Dico<Array<string | number | boolean>> = {};
		const [columns,] = this.getTableColumns();
		for (let i of Object.keys(columns)) {
			const column = columns[i]!;
			parsedTable[column.colNameStr] = [];
		}
		return parsedTable;
	}
	private getOverflowRecord(recordPointer: number): Buffer | undefined {
		const recordOffset = (recordPointer & 0xFF) >>> 0;
		const pageNum = recordPointer >>> 8;
		const recordPage = this.dataPages[pageNum * this.pageSize];
		if (!recordPage)
			return;
		const parsedData = parseDataPageHeader(recordPage, this.version);
		if (recordOffset > parsedData.recordOffsets.length)
			return;
		let start = parsedData.recordOffsets[recordOffset];
		if ((start & 0x8000) >>> 0)
			start = (start & 0xFFF) >>> 0;
		else
			console.log(`Overflow record flag is not present ${start}`);
		let record: Buffer;
		if (recordOffset === 0) {
			record = recordPage.slice(start);
		} else {
			let end = parsedData.recordOffsets[recordOffset - 1];
			if ((end & 0x8000) >>> 0)
				end = (end & 0xFFF) >>> 0;
			record = recordPage.slice(start, end);
		}
		return record;
	}
	private parseFixedLengthData(originalRecord: Buffer, column: Column, nullTable: Array<boolean>) {
		const columnName = column.colNameStr;
		let parsedType: boolean | string | number;
		if (column.type === DataType.Boolean) {
			if (column.columnID > nullTable.length)
				throw new Error(`Failed to parse bool field, Column not found in nullTable column: ${columnName}, column id: ${column.columnID}, nullTable: ${nullTable}`);
			parsedType = nullTable[column.columnID];
		} else {
			if (column.fixedOffset > originalRecord.length)
				throw new Error(`Column offset is bigger than the length of the record ${column.fixedOffset}`);
			const record = originalRecord.slice(column.fixedOffset);
			parsedType = parseType(column.type, record, this.version);
		}
		if (this.parsedTable[columnName] === undefined)
			this.parsedTable[columnName] = [];
		this.parsedTable[columnName]!.push(parsedType);
	}
	private parseDynamicLengthRecordsMetadata(reverseRecord: Buffer, originalRecord: Buffer, nullTableLength: number) {
		if (this.version > 3) {
			reverseRecord = reverseRecord.slice(nullTableLength + 1);
			if (reverseRecord.length > 1 && reverseRecord[0] === 0)
				reverseRecord = reverseRecord.slice(1);
			return parseRelativeObjectMetadataStruct(reverseRecord, undefined, this.version);
		}
		const variableLengthJumpTableCNT = Math.floor((originalRecord.length - 1) / 256);
		reverseRecord = reverseRecord.slice(nullTableLength);
		let relativeRecordMetadata: ReturnType<typeof parseRelativeObjectMetadataStruct>;
		try {
			relativeRecordMetadata = parseRelativeObjectMetadataStruct(reverseRecord, variableLengthJumpTableCNT, this.version);
			relativeRecordMetadata.relativeMetadataEnd += nullTableLength;
		} catch {
			throw new Error("Failed parsing record");
		}
		if (relativeRecordMetadata && relativeRecordMetadata.variableLengthFieldCount !== this.tableHeader.variableColumns) {
			const tmpBuffer = Buffer.allocUnsafe(2);
			tmpBuffer.writeUInt16LE(this.tableHeader.variableColumns);
			const metadataStart = reverseRecord.indexOf(tmpBuffer);
			if (metadataStart !== 1 && metadataStart < 10) {
				reverseRecord = reverseRecord.slice(metadataStart);
				try {
					relativeRecordMetadata = parseRelativeObjectMetadataStruct(reverseRecord, variableLengthJumpTableCNT, this.version);
				} catch {
					throw new Error(`Failed to parse record metadata: ${originalRecord}`);
				}
				relativeRecordMetadata.relativeMetadataEnd += metadataStart;
			} else {
				console.log(`Record did not parse correctly. Number of columns: ${this.tableHeader.variableColumns}. Number of parsed columns: ${relativeRecordMetadata.variableLengthFieldCount}`);
				return;
			}
		}
		return relativeRecordMetadata;
	}
	private parseMemo(relativeObjData: Buffer, column: Column): string | number | boolean {
		console.log(`Parsing memo field ${relativeObjData}`);
		const parsedMemo = MEMO.parse(relativeObjData);
		let memoData: Buffer;
		let memoType: DataType;
		if (parsedMemo.memoLength & 0x80000000) {
			console.log("Memo data inline");
			memoData = relativeObjData.slice(parsedMemo.memoEnd);
			memoType = DataType.Text;
		} else if (parsedMemo.memoLength & 0x40000000) {
			console.log("LVAL type 1");
			const tmp = this.getOverflowRecord(parsedMemo.recordPointer);
			if (tmp === undefined)
				throw new Error("LVAL type 1 memoData is undefined");
			memoData = tmp;
			memoType = DataType.Text;
		} else {
			console.log("LVAL type 2");
			console.log("memo lval type 2 currently not supported");
			memoData = relativeObjData;
			memoType = column.type;
		}
		return parseType(memoType, memoData, memoData.length, this.version);
	}
	private parseDynamicLengthData(
		originalRecord: Buffer,
		relativeRecordMetadata: ReturnType<typeof parseRelativeObjectMetadataStruct>,
		relativeRecordsColumnMap: Dico<Column>,
	): void {
		const relativeOffsets = relativeRecordMetadata.variableLengthFieldOffsets;
		let jumpTableAddition = 0;
		let i = -1;
		for (const columnIndex of Object.keys(relativeRecordsColumnMap)) {
			i += 1;
			const column = relativeRecordsColumnMap[columnIndex]!;
			const colName = column.colNameStr;
			if (this.version === 3) {
				if (relativeRecordMetadata.variableLengthJumpTable.includes(i))
					jumpTableAddition = (jumpTableAddition + 0x100) >>> 0;
			}
			let relStart = relativeOffsets[i];
			let relEnd: number;
			if (i + 1 === relativeOffsets.length)
				relEnd = relativeRecordMetadata.varLenCount;
			else
				relEnd = relativeOffsets[i + 1];
			if (this.version > 3) {
				if (relEnd > originalRecord.length)
					relEnd = (relEnd & 0xFF) >>> 0;
				if (relStart > originalRecord.length)
					relStart = (relStart & 0xFF) >>> 0;
			}
			if (relStart === relEnd) {
				if (this.parsedTable[colName] === undefined)
					this.parsedTable[colName] = [];
				this.parsedTable[colName]!.push("");
				continue;
			}
			const relativeObjData = originalRecord.slice(relStart + jumpTableAddition, relEnd + jumpTableAddition);
			let parsedType: string | number | boolean;
			if (column.type === DataType.Memo) {
				try {
					parsedType = this.parseMemo(relativeObjData, column);
				} catch {
					console.log(`Failed to parse memo field. Using data as bytes`);
					parsedType = relativeObjData.toString();
				}
			} else {
				parsedType = parseType(column.type, relativeObjData, relativeObjData.length, this.version);
			}
			if (this.parsedTable[colName] === undefined)
				this.parsedTable[colName] = [];
			this.parsedTable[colName]!.push(parsedType);
		}
	}
	private parseRow(record: Buffer): void {
		const originalRecord = Buffer.allocUnsafe(record.length);
		record.copy(originalRecord);
		let reverseRecord = Buffer.allocUnsafe(record.length);
		record.copy(reverseRecord);
		reverseRecord = reverseRecord.reverse();
		const nullTableLen = Math.floor((this.tableHeader.columnCount + 7) / 8);
		const nullTable: Array<boolean> = [];
		if (nullTableLen && nullTableLen < originalRecord.length) {
			const nullTableBuffer = record.slice(nullTableLen === 0 ? 0 : record.length - nullTableLen);
			for (let i = 0; i < nullTable.length * 8; ++i)
				nullTable.push(((nullTableBuffer[Math.floor(i / 8)]) & (1 << (i % 8) >>> 0) >>> 0) !== 0); // CHECK MOD
		} else {
			throw new Error(`Failed to parse null table column count ${this.tableHeader.columnCount}`);
		}
		if (this.version > 3)
			record = record.slice(2);
		else
			record = record.slice(1);
		const relativeRecordsColumnMap: Dico<Column> = {};
		for (const i of Object.keys(this.columns)) {
			const column = this.columns[i]!;
			if (!column.columnFlags.fixedLength) {
				relativeRecordsColumnMap[i] = column;
				continue;
			}
			this.parseFixedLengthData(record, column, nullTable);
		}
		if (relativeRecordsColumnMap) {
			const metadata = this.parseDynamicLengthRecordsMetadata(reverseRecord, originalRecord, nullTableLen);
			if (metadata === undefined)
				return;
			this.parseDynamicLengthData(originalRecord, metadata, relativeRecordsColumnMap);
		}
	}
	public parse() {
		if (!this.table.linkedPages)
			return this.createEmptyTable();
		for (const dataChunk of this.table.linkedPages) {
			const originalData = dataChunk;
			const parsedData = parseDataPageHeader(originalData, this.version);
			let lastOffset: number | undefined = undefined;
			for (const recOffset of parsedData.recordOffsets) {
				if ((recOffset & 0x8000) >>> 0) {
					lastOffset = (recOffset & 0xFFF) >>> 0;
					continue;
				}
				if ((recOffset & 0x4000) >>> 0) {
					const recPtrOffset = (recOffset & 0xFFF) >>> 0;
					lastOffset = recPtrOffset;
					const overflowRecPtrBuffer = originalData.slice(recPtrOffset, recPtrOffset + 4);
					const overflowRecPtr = overflowRecPtrBuffer.readUInt32LE(0);
					const record = this.getOverflowRecord(overflowRecPtr);
					if (record !== undefined)
						this.parseRow(record);
					continue;
				}
				let record: Buffer;
				if (!lastOffset)
					record = originalData.slice(recOffset);
				else
					record = originalData.slice(recOffset, lastOffset);
				lastOffset = recOffset;
				if (record)
					this.parseRow(record);
			}
		}
		return this.parsedTable;
	}
}
