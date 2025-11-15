```javascript
import { bool, bits, float, varint, string, blob, date, array, select, union, PackBytes } from './packbytes.mjs';

type = bool // true or false
type = bits(x) // x number of bits 1-32 for unsigned integer, max int = 2**x - 1
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

const { encode, decode } = PackBytes(schema)
const { encode, decode } = PackBytes(JSON.stringify(schema))

buf = encode(data) 

data = decode(buf) 
```
