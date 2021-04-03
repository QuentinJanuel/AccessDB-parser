# AccessDB parser

## Description

A pure javascript Microsoft AccessDB files (.mdb, .accdb) parser.

## Use

```js
const { AccessParser } = require("accessdb-parser");

// Load your access file in a node buffer

const db = new AccessParser(myFileBuffer);

const tables = db.getTables(); // -> ["tableName1", "tableName2"]

const table = db.parseTable("tableName1"); // -> [{data: {name: "John", age: 23}, rowNumber: 1},{data: {name: "Bill", age: 56}, rowNumber: 2}]
```

## TypeScript

This project has types declaration.

## Todo

- unparse

## Special thanks

- https://github.com/ClarotyICS/access_parser
- https://github.com/brianb/mdbtools
