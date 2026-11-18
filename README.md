# AccessDB Browser Parser

## Description

This is a fork of the pure javascript Microsoft AccessDB files (.mdb, .accdb) parser `accessdb-parser`, adapted to work in modern web browsers.

This version removes Node.js dependencies like `Buffer` and uses `Uint8Array` and other Web APIs instead, making it suitable for client-side applications.

## Usage

```javascript
import { AccessParser } from "accessdb-parser";

async function loadAndParseDB() {
  const response = await fetch("path/to/your/database.mdb");
  const arrayBuffer = await response.arrayBuffer();
  const dbData = new Uint8Array(arrayBuffer);

  const db = new AccessParser(dbData);

  const tables = db.getTables(); // -> ["tableName1", "tableName2"]
  console.log("Tables:", tables);

  const table = db.parseTable("tableName1");
  console.log("Table Data:", table);
  // -> [{data: {name: "John", age: 23}, rowNumber: 1},{data: {name: "Bill", age: 56}, rowNumber: 2}]
}

loadAndParseDB();
```

## TypeScript

This project has types declaration.

## Active table pages

Tables are read from their allocation usage map, including the `MSysObjects`
catalog. A data page's owner header alone does not make that page part of a table:
released pages may retain old rows and the old owner value.

The reader supports inline (type 0) and indirect (type 1) usage maps for the page
sizes already supported by the parser. It checks map pointers, row boundaries,
bitmap page types, allocated page existence and table ownership. It never falls
back to scanning owner headers when a map is missing, malformed or unsupported.
Flagged map records and unknown map types are rejected explicitly.

A valid map with no allocated data pages returns an empty array. An invalid map
throws an error prefixed with `ERR_DB_USAGE_MAP_INVALID` and calls the existing
`onError` callback with that code and the table name, table definition page and
usage map pointer. Invalid catalog maps fail in the constructor; other table maps
are checked when `parseTable` reads that table. No public method signature changes.

This changes page selection only. Field decoding, linked memo/overflow reads and
existing row warnings retain their previous behavior.

## Todo

- unparse

## Special thanks

- The original [accessdb-parser](https://github.com/quentinjanuel/accessdb-parser)
- https://github.com/ClarotyICS/access_parser
- https://github.com/brianb/mdbtools
