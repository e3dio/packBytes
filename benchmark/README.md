# Benchmark Install:

Install the encoding libraries [avsc](https://github.com/mtth/avsc) - [protobufjs](https://github.com/protobufjs/protobuf.js) - [@msgpack/msgpack](https://github.com/msgpack/msgpack-javascript) as listed in package.json by running:

`npm i`

# Results:

`node benchmark_data1.mjs`

<img src="https://raw.githubusercontent.com/e3dio/packBytes/main/benchmark/chart.png" alt="AssemblyScript logo">

Encoding | time (ns) | bytes
--- | --- | ---
`packBytes` | 55 | 1
`packBytes_schema` | 155 | 1
`avsc` | 270 | 4
`protobuf` |250 | 8
`msgpack` | 1170 | 33
`json` | 800 | 53

```javascript
const data = { field1: true, field2: false, field3: 3, field4: 15 };
```

---

`node benchmark_data2.mjs`

Encoding | time (ns) | bytes
--- | --- | ---
`packBytes` | 60 | 4
`packBytes_schema` | 210 | 4
`avsc` | 300 | 9
`protobuf` | 490 | 17
`msgpack` | 1450 | 33
`json` | 1150 | 102

```javascript
const data = { field1: true, field2: false, field3: 3, field4: 7, field5: 15, field6: 31, field7: 63, field8: 1023 };
```
