import UUID from "uuid";
import { Version, Dico } from "./types";
// @ts-ignore
import { TextDecoder } from "text-decoding";

export enum DataType {
	Boolean = 1,
	Int8 = 2,
	Int16 = 3,
	Int32 = 4,
	Money = 5,
	Float32 = 6,
	Float64 = 7,
	DateTime = 8,
	Binary = 9,
	Text = 10,
	OLE = 11,
	Memo = 12,
	GUID = 15,
	Bit96Bytes17 = 16,
	Complex = 18,
}

const TABLE_PAGE_MAGIC = Buffer.from([0x02, 0x01]);
const DATA_PAGE_MAGIC = Buffer.from([0x01, 0x01]);

export const parseType = function (dataType: DataType, buffer: Buffer, length?: number, version: Version = 3) {
	let parsed: number | string = "";
	let buf: Buffer;
	switch (dataType) {
		case DataType.Int8:
			parsed = buffer.readInt8(0);
			break;
		case DataType.Int16:
			parsed = buffer.readInt16LE(0);
			break;
		case DataType.Int32:
		case DataType.Complex:
			parsed = buffer.readInt32LE(0);
			break;
		case DataType.Float32:
			parsed = buffer.readFloatLE(0);
			break;
		case DataType.Float64:
			parsed = buffer.readDoubleLE(0);
			break;
		case DataType.Money:
			parsed = buffer.readUInt32LE(0) + buffer.readUInt32LE(4) * Math.pow(0x10, 8);
		break;
		case DataType.DateTime:
			const daysPassed = Math.floor(buffer.readDoubleLE(0));
			const date = new Date("1899/12/30");
			date.setHours(12, 0, 0, 0);
			date.setDate(date.getDate() + daysPassed);
			const day = date.getDate();
			const month = date.getMonth() + 1;
			const year = date.getFullYear();
			parsed = `${day < 10 ? "0" : "" }${ day }/${ month < 10 ? "0" : "" }${ month }/${ year }`;
			break;
		case DataType.Binary:
			parsed = buffer.slice(0, length).toString("utf8"); // Maybe
			break;
		case DataType.GUID:
			parsed = UUID.stringify(buffer.slice(0, 16));
			break;
		case DataType.Bit96Bytes17:
			parsed = buffer.slice(0, 17).toString("utf8"); // Maybe
			break;
		case DataType.Text:
			if (version > 3) {
				const first = Buffer.compare(buffer.slice(0, 2), Buffer.from([0xFE, 0xFF])) === 0;
				const second = Buffer.compare(buffer.slice(0, 2), Buffer.from([0xFF, 0xFE])) === 0;
				if (first || second) {
					parsed = new TextDecoder("utf-8")
					.decode(buffer.slice(2));
				} else {
					parsed = new TextDecoder("utf-16le")
					.decode(buffer);
				}
			} else {
				parsed = buffer.toString("utf8");
			}
			break;
	}
	return parsed;
}

export const categorizePages = function (dbData: Buffer, pageSize: number): [Dico<Buffer>, Dico<Buffer>, Dico<Buffer>] {
	if (dbData.length % pageSize)
		throw new Error(`DB is not full or pageSize is wrong. pageSize: ${ pageSize } dbData.length: ${ dbData.length }`);
	const pages: Dico<Buffer> = {};
	for (let i = 0; i < dbData.length; i += pageSize)
		pages[i] = dbData.slice(i, i + pageSize);
	const dataPages: Dico<Buffer> = {};
	const tableDefs: Dico<Buffer> = {};
	for (const page of Object.keys(pages)) {
		const comp1 = Buffer.compare(DATA_PAGE_MAGIC, pages[page]!.slice(0, DATA_PAGE_MAGIC.length)) === 0;
		const comp2 = Buffer.compare(TABLE_PAGE_MAGIC, pages[page]!.slice(0, TABLE_PAGE_MAGIC.length)) === 0;
		if (comp1)
			dataPages[page] = pages[page];
		else if (comp2)
			tableDefs[page] = pages[page];
	}
	return [tableDefs, dataPages, pages];
}
