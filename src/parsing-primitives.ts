import { Parser } from "binary-parser";
import { Version } from "./types";
// @ts-ignore
import { TextDecoder } from "text-decoding";

Parser.prototype.array = (function (oldArray) {
	return function (this: any, varName: any, options: any) {
		if (options.length === 0)
			return this.setNextParser("array", varName, options);
		return oldArray.call(this, varName, options);
	}
})(Parser.prototype.array);

export const ACCESSHEADER = new Parser()
	.seek(4)
	.string("jetString", {
		zeroTerminated: true,
	})
	.uint32le("jetVersion")
	.seek(126);

export const MEMO = new Parser()
	.uint32le("memoLength")
	.uint32le("recordPointer")
	.uint32le("memoUnknown")
	.saveOffset("memoEnd");

const VERSION_3_FLAGS = new Parser()
	.bit1("hyperlink")
	.bit1("autoGUID")
	.bit1("unk1")
	.bit1("replication")
	.bit1("unk2")
	.bit1("autonumber")
	.bit1("canBeNull")
	.bit1("fixedLength");

const VERSION_4_FLAGS = new Parser()
	.bit1("hyperlink")
	.bit1("autoGUID")
	.bit1("unk1")
	.bit1("replication")
	.bit1("unk2")
	.bit1("autonumber")
	.bit1("canBeNull")
	.bit1("fixedLength")
	.bit1("unk3")
	.bit1("unk4")
	.bit1("unk5")
	.bit1("modernPackageType")
	.bit1("unk6")
	.bit1("unk7")
	.bit1("unk8")
	.bit1("compressedUnicode");

export const TDEF_HEADER = new Parser()
	.seek(2)
	.uint16le("peekVersion")
	.seek(-2)
	.uint16le("tdefVer")
	.uint32le("nextPagePtr")
	.saveOffset("headerEnd");

export const parseTableHead = function (buffer: Buffer, version: Version = 3) {
	return new Parser()
		.nest("TDEF_header", { type: TDEF_HEADER })
		.uint32le("tableDefinitionLength")
		// Conditional
		.uint32le("ver4Unknown")
		.seek(version > 3 ? 0 : -4)
		.uint32le("numberOfRows")
		.uint32le("autonumber")
		// Conditional
		.uint32le("autonumberIncrement")
		.seek(version > 3 ? 0 : -4)
		// Conditional
		.uint32le("complexAutonumber")
		.seek(version > 3 ? 0 : -4)
		// Conditional
		.uint32le("ver4Unknown1")
		.seek(version > 3 ? 0 : -4)
		// Conditional
		.uint32le("ver4Unknown2")
		.seek(version > 3 ? 0 : -4)
		.uint8("tableTypeFlags")
		.uint16le("nextColumnID")
		.uint16le("variableColumns")
		.uint16le("columnCount")
		.uint32le("indexCount")
		.uint32le("realIndexCount")
		.uint32le("rowPageMap")
		.uint32le("freeSpacePageMap")
		.saveOffset("tDefHeaderEnd")
		.parse(buffer);
}

export const parseTableData = function (buffer: Buffer, realIndexCount: number, columnCount: number, version: Version = 3) {
	const REAL_INDEX = new Parser()
		.uint32le("unk1")
		.uint32le("indexRowCount")
		.seek(version > 3 ? 0 : -4)
		// Conditional
		.uint32le("ver4AlwaysZero");
	const VARIOUS_TEXT_V3 = new Parser()
		.uint16le("LCID")
		.uint16le("codePage")
		.uint16le("variousText3Unknown");
	const VARIOUS_TEXT_V4 = new Parser()
		.uint16le("collation")
		.uint8("variousText4Unknown")
		.uint8("collationVersionNumber");
	const VARIOUS_TEXT = version === 3 ? VARIOUS_TEXT_V3 : VARIOUS_TEXT_V4;
	const VARIOUS_DEC_V3 = new Parser()
		.uint16le("variousDec3Unknown")
		.uint8("maxNumberOfDigits")
		.uint8("numberOfDecimal")
		.uint16le("variousDec3Unknown2");
	const VARIOUS_DEC_V4 = new Parser()
		.uint8("maxNumOfDigits")
		.uint8("numOfDecimalDigits")
		.uint16le("variousDec4Unknown");
	const VARIOUS_DEC = version === 3 ? VARIOUS_DEC_V3 : VARIOUS_DEC_V4;
	const COLUMN = new Parser()
		.uint8("type")
		// Conditional
		.uint32le("ver4Unknown3")
		.seek(version > 3 ? 0 : -4)
		.uint16le("columnID")
		.uint16le("variableColumnNumber")
		.uint16le("columnIndex")
		.choice("various", {
			tag: "type",
			choices: {
				1: VARIOUS_DEC,
				2: VARIOUS_DEC,
				3: VARIOUS_DEC,
				4: VARIOUS_DEC,
				5: VARIOUS_DEC,
				6: VARIOUS_DEC,
				7: VARIOUS_DEC,
				8: VARIOUS_DEC,
				9: VARIOUS_TEXT,
				10: VARIOUS_TEXT,
				11: VARIOUS_TEXT,
				12: VARIOUS_TEXT,
			},
			defaultChoice: new Parser().seek(version === 3 ? 6 : 4),
		})
		.choice("columnFlags", {
			tag: new Function(`return ${version === 3 ? 1 : 0}`) as any,
			choices: {
				1: VERSION_3_FLAGS,
				0: VERSION_4_FLAGS,
			},
		})
		// Conditional
		.uint32le("ver4Unknown4")
		.seek(version > 3 ? 0 : -4)
		.uint16le("fixedOffset")
		.uint16le("length");
	const COLUMN_NAMES_V3 = new Parser()
		.uint8("colNamesLen")
		.string("colNameStr", {
			length: "colNamesLen",
			encoding: "utf8",
			stripNull: true,
		});
	const COLUMN_NAMES_V4 = new Parser()
		.uint16le("colNamesLen")
		.buffer("colNameStr", {
			length: "colNamesLen",
		});
	// .string("colNameStr", {
	// 	length: "colNamesLen",
	// 	encoding: "utf16",
	// 	stripNull: true,
	// });
	const COLUMN_NAMES: typeof COLUMN_NAMES_V3 = version === 3 ? COLUMN_NAMES_V3 : COLUMN_NAMES_V4 as any;
	const res = new Parser()
		.array("readIndex", {
			length: realIndexCount,
			type: REAL_INDEX,
		})
		.array("column", {
			length: columnCount,
			type: COLUMN,
		})
		.array("columnNames", {
			length: columnCount,
			type: COLUMN_NAMES,
		})
		.parse(buffer);
	if (version !== 3) {
		for (const columnName of res.columnNames) {
			const buffer = columnName.colNameStr as unknown as Buffer;
			columnName.colNameStr = new TextDecoder("utf-16le")
				.decode(buffer);
		}
	}
	return res;
}

export const parseDataPageHeader = function (buffer: Buffer, version: Version = 3) {
	return new Parser()
		.seek(2)
		.uint16le("dataFreeSpace")
		.uint32le("owner")
		.seek(version > 3 ? 0 : -4)
		// Conditional
		.uint32le("ver4UnknownData")
		.uint16le("recordCount")
		.array("recordOffsets", {
			length: "recordCount",
			type: "uint16le",
		})
		.parse(buffer);
}

export const parseRelativeObjectMetadataStruct = function (buffer: Buffer, variableJumpTablesCNT: number = 0, version: Version = 3) {
	if (version === 3) {
		return new Parser()
			.uint8("variableLengthFieldCount")
			.array("variableLengthJumpTable", {
				length: variableJumpTablesCNT,
				type: "uint8",
			})
			.array("variableLengthFieldOffsets", {
				length: function () {
					return this.variableLengthFieldCount;
				},
				type: "uint8",
			})
			.uint8("varLenCount")
			.saveOffset("relativeMetadataEnd")
			.parse(buffer);
	} else {
		const part1 = new Parser()
			.uint16le("variableLengthFieldCount")
			.array("variableLengthJumpTable", {
				length: variableJumpTablesCNT,
				type: "uint8",
			})
			.saveOffset("part2StartOffset")
			.parse(buffer);
		const part2 = new Parser()
			.array("variableLengthFieldOffsets", {
				length: (part1.variableLengthFieldCount & 0xFF) >>> 0,
				type: "uint16le",
			})
			.uint16le("varLenCount")
			.saveOffset("relativeMetadataEnd")
			.parse(buffer.slice(part1.part2StartOffset));
		const result = { ...part1, ...part2 };
		return result;
	}
}
