<p align="center"><img height="220" src="https://i.giphy.com/media/QpVUMRUJGokfqXyfa1/giphy.webp"></p>

<h1 align="center">PackBytes</h1>
<h3 align="center">Binary data encoder for JavaScript.</h3>
<br>
<p align="center">
:dizzy: <b>Fast</b>, <b>Small</b>, and <b>Easy</b> to use.<br>
:recycle: <b>Schemas</b> automate encoding in high-level interface.<br>
:satellite: Useful for <b>storing</b> or <b>sending</b> compact data over network.<br>
:fast_forward: <a href="https://github.com/e3dio/packBytes#benchmark">Benchmark</a> is <b>50x</b> smaller than JSON and <b>5x</b> faster to encode.
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

```js
// Example schema with all data types:

import { bool, bits, float, varint, string, blob, objectid, uuid, date, lonlat, array, schemas } from 'packbytes';

const schema = {
   a: bool,
   b: bits(1),
   c: bits(7),
   d: bits(25),
   e: string,
   x: string([ 'str1', 'str2' ]),
   y: array(bits(5)),
   z: array({
      a: float(32),
      b: float(64),
      c: blob,
      d: blob(12),
      e: array(blob),
      f: array(string),
      1: array(string([ 'str1', 'str2' ])),
      2: array(string([ 'str1', 'str2' ])).size(3),
      3: array(array(bits(7))),
      4: schemas({ name1: bool, name2: array(bits(3)).size(2) }),
      5: array(schemas({ s1: string, s2: { field1: bool, field2: array(string([ 'str1', 'str2' ])) } }))
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

const { encode, decode } = PackBytes(schema);
```
### Encode:
```javascript
const data = [
   { a: false, b: 0, c: 0 },
   { a: true, b: 1, c: 12 },
   { a: true, b: 3, c: 31 }
];

const buf = encode(data);

// buf.length == 3, encoded to 3 bytes, 24x smaller than JSON.stringify(data) at 73 bytes

sendOverNetwork(buf);
saveToDisk(buf);
```
### Decode:
```javascript
const data = decode(buf);

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
import { bool, bits, maxInt, float, varint, string, blob, date, array, union, PackBytes } from 'packbytes';

// create a schema using any combination of types:
type = bool // true or false
type = bits(x) // x number of bits 1-32 for unsigned integer, max int = 2**32 - 1
type = maxInt(x) // max integer from 0 to 4_294_967_295, auto calculates bits(x)
type = float(x) // 16, 32, or 64 bit floating point number
type = varint // variable length integer, max int = 1_073_741_823
type = string // string of any length
type = string([ 'str1', 'str2', .. ]) // any of specific strings
type = blob // any length buffer
type = blob(x) // specific byte size buffer 
type = date // 32 bit javascript Date, 1 second accuracy with year range 1884 to 2106
type = array(type) // array of any type
type = array(type).size(x) // specific length array
type = { field1: type, field2: type, .. } // object with all fields
type = select({ field1: type, field2: type, .. }) // object with a single field active
type = union({ field1: type, field2: type, .. }) // object with multiple optional fields
type = null // takes up no space

schema = type

// create encoder by providing schema:
const { encode, decode } = PackBytes(schema)

// also takes JSON string of schema:
const { encode, decode } = PackBytes(JSON.stringify(schema))

// encode data to buffer
buf = encode(data) 

// decode buffer to original data
data = decode(buf) 
```
