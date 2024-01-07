<p align="center"><img height="220" src="https://i.giphy.com/media/QpVUMRUJGokfqXyfa1/giphy.webp"></p>

<h1 align="center">packBytes</h1>

<p align="center">
:dizzy: The <b>Fastest</b>, <b>Smallest</b>, and <b>Easiest</b> to use data encoder for JavaScript<br>
:recycle: <b>Schemas</b> automate all encoding and decoding in high-level interface<br>
:satellite: Useful for <b>storing</b> or <b>sending</b> compact data over network<br>
:fast_forward: <a href="https://github.com/e3dio/packBytes#benchmark">Benchmark</a> is <b>50x</b> smaller than JSON and <b>5x</b> faster to encode
</p>
<h3 align="center"><b>Node.js</b> :heavy_check_mark: &nbsp;<b>Web Browsers</b> :heavy_check_mark:</h3>

<p align="center">
<a href="#Install">1. Install</a><br>
<a href="#Schema">2. Schema</a><br>
<a href="#Example">3. Example</a><br>
<a href="#Benchmark">4. Benchmark</a><br>
<a href="#API">5. API</a>
</p>

# Install:

`npm i e3dio/packbytes`

# Schema:

- Define the structure of your data with a Schema
- Encoder/Decoder will optimize and execute all low-level operations for you
- Creates a smaller encoding faster and easier than any other schema-based system:

```javascript
// Example schema with all data types:

import { bool, bits, float, varint, string, blob, objectid, uuid, date, lonlat, array, schemas } from 'packbytes';

const schema = {
   a: bool,
   b: bits(1),
   c: bits(7),
   d: bits(25),
   e: string,
   x: string('str1', 'str2'),
   y: array(bits(5)),
   z: array({
      a: float(32),
      b: float(64),
      c: blob,
      d: blob(12),
      e: array(blob),
      f: array(string),
      1: array(string('str1', 'str2')),
      2: array(string('str1', 'str2')).size(3),
      3: array(array(bits(7))),
      4: schemas({ name1: bool, name2: array(bits(3)).size(2) }),
      5: array(schemas({ s1: string, s2: { field1: bool, field2: array(string('str1', 'str2')) } }))
   })
};
```

# Example:

- This code runs in both Node.js and Web Browser:

### Schema:
```javascript
import { bool, bits, array, PackBytes } from 'packbytes';

const schema = array({
   a: bool,
   b: bits(2),
   c: bits(5)
});

const encoder = new PackBytes(schema);
```
### Encode:
```javascript
const data = [
   { a: false, b: 0, c: 0 },
   { a: true, b: 1, c: 12 },
   { a: true, b: 3, c: 31 }
];

const buf = encoder.encode(data);

// buf.length == 3, encoded to 3 bytes, 24x smaller than JSON.stringify(data) at 73 bytes

sendOverNetwork(buf);
saveToDisk(buf);
```
### Decode:
```javascript
const data = encoder.decode(buf);

console.log(data);
// [
//    { a: false, b: 0, c: 0 },
//    { a: true, b: 1, c: 12 },
//    { a: true, b: 3, c: 31 }
// ]
```

# Benchmark:

- The [benchmark](https://github.com/e3dio/packBytes/tree/main/benchmark) encodes data 50x smaller than JSON and is 5x faster, also compare with other encoding methods: 

<img src="https://raw.githubusercontent.com/e3dio/packBytes/main/benchmark/chart.png" alt="AssemblyScript logo">

Encoding | time (ns) | bytes
--- | --- | ---
`packBytes` | 55 | 1
`packBytes_schema` | 155 | 1
`avsc` | 270 | 4
`protobuf` |250 | 8
`msgpack` | 1170 | 33
`json` | 800 | 53

- Same benchmark with different data set, 25x smaller than JSON and 5x faster:

Encoding | time (ns) | bytes
--- | --- | ---
`packBytes` | 60 | 4
`packBytes_schema` | 210 | 4
`avsc` | 300 | 9
`protobuf` | 490 | 17
`msgpack` | 1450 | 33
`json` | 1150 | 102

# API:

- Detailed API description and user guide:

```javascript
// all available exports:
import { bool, bits, string, array, float, blob, schemas, PackBytes } from 'packbytes';

// create a schema using any combination or nesting of schema types:
schema = bool // true or false
schema = bits(x) // x number bits for unsigned integer (max integer = 2**x-1)
schema = string // string of any length
schema = string('str1', 'str2', ..) // any of specific strings, auto-maps to integer
schema = float(x) // 32 or 64 bit floating point number
schema = blob // any length buffer
schema = blob(x) // specific byte size buffer 
schema = array(schema) // array of any schema type
schema = array(schema).size(x) // specific length array
schema = { field1: schema, field2: schema, .. } // object with multiple fields, field names auto-map to integers
schema = schemas({ schema1: schema, schema2: schema, .. }) // multiple schemas mapped to 1 schema, schema names auto-map to integers

// create encoder by providing schema:
// accepts schema object or JSON.stringify(schema) string for easy transfer from server to client:
encoder = new PackBytes(schema)

buf = encoder.encode(data) // encode data
buf = encoder.encode(schema_name, data) // encode data with specific schema from 'schemas' type

data = encoder.decode(buf) // decode, returns original data
```
